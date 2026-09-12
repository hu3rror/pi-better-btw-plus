/**
 * Write-path extraction for tool calls (`extractWritePaths`).
 *
 * Feeds two consumers: the full-lane file-overlap guard (tool-wrapper.ts
 * wraps tools with a confirm-before-overwrite check) and the main lane's
 * write tracking in index.ts (`tool_execution_start`).
 *
 * The bash branch is a deliberately small hand-rolled tokenizer — enough for
 * the overlap guard, nothing more:
 *
 * - redirects `>` `>>` `&>` `&>>` push their target (a real write);
 * - fd duplication `N>&M` is tokenized as one construct and NEVER pushes:
 *   the fd numbers are neither operands nor paths (fixes the family that
 *   previously reported `["2","log"]` for `cp a b 2>&1 | tee log` and
 *   dropped the real target `b`);
 * - command specials: `tee` / `touch` / `rm` / `cp` / `mv` (the pair
 *   commands keep their last operand as the write target);
 * - `/dev/*` targets and `-flags` are never write paths.
 *
 * KNOWN LIMITATION (backlog issue): in-place writers (`sed -i`, `perl -pi`,
 * `awk -i inplace`) are not special-cased, so their targets go undetected.
 * Fixing them is a behaviour extension, not a correctness fix.
 */
export function extractWritePaths(toolName: string, args: unknown): string[] {
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};

  switch (toolName) {
    case "write":
    case "edit":
      return typeof record.path === "string" ? [record.path] : [];
    case "bash":
      return typeof record.command === "string" ? parseBashWritePaths(record.command) : [];
    default:
      return [];
  }
}

function parseBashWritePaths(command: string): string[] {
  const tokens = tokenizeShell(command);
  const paths: string[] = [];
  let segment: ShellToken[] = [];

  for (const token of tokens) {
    if (token.type === "op" && isCommandSeparator(token.value)) {
      collectSegmentWritePaths(segment, paths);
      segment = [];
      continue;
    }
    segment.push(token);
  }

  collectSegmentWritePaths(segment, paths);
  return [...new Set(paths)];
}

type ShellToken =
  | { type: "word"; value: string }
  | {
      type: "op";
      value: ">" | ">>" | "&>" | "&>>" | ">&" | "|" | "||" | "&" | "&&" | ";";
    };

/** Two-character operators; the three-char `&>>` is intercepted before this map. */
const TWO_CHAR_OPS = {
  ">>": ">>",
  "||": "||",
  "&&": "&&",
  "&>": "&>",
  ">&": ">&",
} as const;

function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];

  for (let i = 0; i < command.length; ) {
    const char = command[i];

    if (/\s/.test(char)) {
      i++;
      continue;
    }

    const threeOp = command.slice(i, i + 3);
    if (threeOp === "&>>") {
      tokens.push({ type: "op", value: "&>>" });
      i += 3;
      continue;
    }

    const twoCharOp = command.slice(i, i + 2);
    if (twoCharOp in TWO_CHAR_OPS) {
      tokens.push({ type: "op", value: TWO_CHAR_OPS[twoCharOp as keyof typeof TWO_CHAR_OPS] });
      i += 2;
      continue;
    }

    if (char === ">" || char === "|" || char === "&" || char === ";") {
      tokens.push({ type: "op", value: char as ">" | "|" | "&" | ";" });
      i++;
      continue;
    }

    let value = "";
    while (i < command.length) {
      const current = command[i];

      if (/\s/.test(current) || current === ">" || current === "|" || current === "&" || current === ";") {
        break;
      }

      if (current === "\\") {
        if (i + 1 < command.length) {
          value += command[i + 1];
          i += 2;
        } else {
          i++;
        }
        continue;
      }

      if (current === "'") {
        i++;
        while (i < command.length && command[i] !== "'") {
          value += command[i];
          i++;
        }
        if (command[i] === "'") i++;
        continue;
      }

      if (current === '"') {
        i++;
        while (i < command.length && command[i] !== '"') {
          if (command[i] === "\\" && i + 1 < command.length && /["\\$`]/.test(command[i + 1])) {
            value += command[i + 1];
            i += 2;
          } else {
            value += command[i];
            i++;
          }
        }
        if (command[i] === '"') i++;
        continue;
      }

      value += current;
      i++;
    }

    if (value) tokens.push({ type: "word", value });
  }

  return tokens;
}

/** Redirect ops that push their target as a write path. */
const REDIRECT_PUSH: ReadonlySet<ShellToken["value"]> = new Set([">", ">>", "&>", "&>>"]);

/** Ops whose target (next word) is consumed: redirects push it, fd dups drop it. */
const CONSUME_NEXT: ReadonlySet<ShellToken["value"]> = new Set([">", ">>", "&>", "&>>", ">&"]);

function collectSegmentWritePaths(segment: ShellToken[], paths: string[]): void {
  for (let i = 0; i < segment.length; i++) {
    const token = segment[i];
    if (token.type === "op" && REDIRECT_PUSH.has(token.value)) {
      if (segment[i + 1]?.type === "word") {
        pushPath(paths, segment[i + 1].value);
        i++;
      }
    }
  }

  const commandIndex = segment.findIndex((token) => token.type === "word");
  if (commandIndex === -1) return;

  const command = segment[commandIndex];

  const operands = collectCommandOperands(segment.slice(commandIndex + 1));
  if (command.value === "tee" || command.value === "touch" || command.value === "rm") {
    for (const operand of operands) pushPath(paths, operand);
  }
  if ((command.value === "cp" || command.value === "mv") && operands.length >= 2) {
    pushPath(paths, operands[operands.length - 1]);
  }
}

function collectCommandOperands(tokens: ShellToken[]): string[] {
  const operands: string[] = [];
  let parsingOptions = true;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.type === "op") {
      if (CONSUME_NEXT.has(token.value) && tokens[i + 1]?.type === "word") i++;
      continue;
    }

    if (parsingOptions) {
      if (token.value === "--") {
        parsingOptions = false;
        continue;
      }
      if (token.value.startsWith("-")) {
        continue;
      }
      parsingOptions = false;
    }

    // fd specifier directly before a redirect op (`2>f` / `2>&1`): a file
    // descriptor number, not an operand. Reads as `mv 2>&1 dst` correctly.
    const next = tokens[i + 1];
    if (/^\d+$/.test(token.value) && next?.type === "op" && CONSUME_NEXT.has(next.value)) {
      continue;
    }

    operands.push(token.value);
  }

  return operands;
}

function isCommandSeparator(value: ShellToken["value"]): boolean {
  return value === "|" || value === "||" || value === "&" || value === "&&" || value === ";";
}

function pushPath(paths: string[], path: string): void {
  if (path && !path.startsWith("-") && !isIgnoredWritePath(path)) {
    paths.push(path);
  }
}

function isIgnoredWritePath(path: string): boolean {
  return path === "/dev/null" || path === "/dev/stdout" || path === "/dev/stderr" || path.startsWith("/dev/fd/");
}
