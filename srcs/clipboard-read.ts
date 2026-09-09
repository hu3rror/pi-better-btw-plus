/**
 * Clipboard reader (D3, issue #4): read plain text from the system clipboard
 * with an injected platform-channel matrix and level-by-level fallback.
 *
 * The write side is pi's own `copyToClipboard` (public export); the read side
 * is self-built because `readClipboardText` is not re-exported from the
 * package entry. Each platform maps to a primary channel:
 *
 *   - win32  → native addon `getText` (pi's own clipboard read), then
 *     PowerShell `Get-Clipboard -Raw`, then an OSC 52 query;
 *   - darwin → native addon `getText`, then `pbpaste`, then OSC 52 query;
 *   - linux  → OSC 52 query (`\x1b]52;c;?\x07`, read the reply).
 *
 * Channels are injected functions, so tests mock success / fallback /
 * all-fail without touching the host clipboard. The reader never throws:
 * a broken channel falls through to the next one and total failure resolves
 * to `{ ok: false, reason: "unavailable" }` — whether to surface a hint is
 * the caller's decision.
 */
import { spawnSync } from "node:child_process";

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
/**
 * Outcome of reading the system clipboard: text, an explicitly empty
 * clipboard (a channel ran and saw nothing), or no usable channel at all.
 * The empty/unavailable distinction lets callers show a reason-specific
 * hint ("Clipboard is empty" vs "Clipboard read failed").
 */
export type ClipboardReadOutcome =
  | { ok: true; text: string }
  | { ok: false; reason: "empty" | "unavailable" };

/** A single clipboard read channel. */
export interface ClipboardReadChannel {
  /** Channel identity for diagnostics and ordering assertions. */
  readonly name: string;
  /**
   * Read plain text. Resolve `{ ok: false, reason: "empty" }` when the
   * channel ran and found the clipboard empty, `unavailable` when it could
   * not run at all (tool missing / non-zero exit / timeout / no reply).
   */
  readonly read: () => Promise<ClipboardReadOutcome>;
}

/** Result of running one subprocess-based channel. */
export interface ExecResult {
  ok: boolean;
  stdout: string;
}

export interface ExecOptions {
  timeoutMs: number;
  maxBuffer: number;
  env?: NodeJS.ProcessEnv;
}

/** Injected subprocess runner (tests replace with a fake). */
export type ExecFn = (
  command: string,
  args: readonly string[],
  options: ExecOptions,
) => ExecResult;

/** Default subprocess runner: synchronous, mirrors pi's `runCommand`. */
export function defaultExec(
  command: string,
  args: readonly string[],
  options: ExecOptions,
): ExecResult {
  try {
    const result = spawnSync(command, [...args], {
      encoding: "utf8",
      timeout: options.timeoutMs,
      maxBuffer: options.maxBuffer,
      env: options.env,
    });
    if (result.error) return { ok: false, stdout: "" };
    if (result.status !== 0) return { ok: false, stdout: "" };
    return { ok: true, stdout: result.stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/**
 * Try channels in order and return the first usable outcome. A channel that
 * throws is skipped like one that reports unavailable; an explicitly empty
 * clipboard is a definitive answer and stops the cascade — the reader
 * never throws.
 */
export async function readClipboardText(
  channels: readonly ClipboardReadChannel[],
): Promise<ClipboardReadOutcome> {
  for (const channel of channels) {
    try {
      const outcome = await channel.read();
      if (outcome.ok) return outcome;
      if (outcome.reason === "empty") return outcome;
    } catch {
      // Fall through to the next channel.
    }
  }
  return { ok: false, reason: "unavailable" };
}

/** Strip the single trailing newline CLI tools append to their output. */
function stripOneTrailingNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

const DEFAULT_EXEC_TIMEOUT_MS = 5000; // pi's PowerShell channel uses 5s too
const DEFAULT_MAX_BUFFER_BYTES = 50 * 1024 * 1024;

export interface CommandChannelOptions {
  /** Subprocess runner override (tests). Defaults to {@link defaultExec}. */
  exec?: ExecFn;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
}

/**
 * PowerShell channel: `powershell.exe -NoProfile -Command "Get-Clipboard
 * -Raw"`, mirroring pi's clipboard-image PowerShell channel family. The
 * `-Raw` flag preserves the exact text (no extra newline), and the output
 * encoding is pinned to UTF-8 because the text travels over the console
 * pipe (pi's image reader sidesteps this by writing a temp file).
 */
const PS_GET_CLIPBOARD_SCRIPT =
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Clipboard -Raw";

/** Shared shape of the subprocess-based channels: run → strip → outcome. */
function makeCommandChannel(
  name: string,
  command: string,
  args: readonly string[],
  options: CommandChannelOptions,
): ClipboardReadChannel {
  const exec = options.exec ?? defaultExec;
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER_BYTES;
  return {
    name,
    async read() {
      let result: ExecResult;
      try {
        result = exec(command, args, { timeoutMs, maxBuffer, env: options.env });
      } catch {
        return { ok: false, reason: "unavailable" };
      }
      if (!result.ok) return { ok: false, reason: "unavailable" };
      const text = stripOneTrailingNewline(result.stdout);
      // An exit-0 empty output means the clipboard holds no text.
      return text.length > 0
        ? { ok: true, text }
        : { ok: false, reason: "empty" };
    },
  };
}

/**
 * Native clipboard addon (win32 / darwin primary read channel): the
 * `@mariozechner/clipboard` napi addon pi itself uses for reads and writes.
 * Its `getText` is a sub-millisecond, non-blocking call — vs. the PowerShell
 * `Get-Clipboard` subprocess, which cold-starts ~1s and blocks the event loop
 * with `spawnSync` (the source of the right-click-paste lag). Resolution
 * mirrors pi's `clipboard-native` loader: the package's own `require` first,
 * then a `require` rooted at the pi executable's directory.
 *
 * The addon is an optional dependency provided at runtime by the pi host
 * environment — deliberately not listed in package.json to avoid
 * cross-platform prebuild dependency issues. When it is missing or fails to
 * load, the channel reports `unavailable` and the fallback chain
 * (PowerShell / pbpaste → OSC 52) takes over.
 */
export interface NativeClipboardAddon {
  /** Resolve the clipboard's plain text; null when it holds no text. */
  getText(): Promise<string | null>;
}

let cachedNativeAddon: NativeClipboardAddon | null | undefined;

function loadNativeAddon(): NativeClipboardAddon | null {
  if (cachedNativeAddon !== undefined) return cachedNativeAddon;
  const moduleRequire = createRequire(import.meta.url);
  const executableDirRequire = createRequire(
    pathToFileURL(join(dirname(process.execPath), "package.json")).href,
  );
  cachedNativeAddon = null;
  for (const requireClipboard of [moduleRequire, executableDirRequire]) {
    try {
      const addon = requireClipboard("@mariozechner/clipboard") as
        | { getText?: () => Promise<string | null> }
        | undefined;
      if (addon && typeof addon.getText === "function") {
        cachedNativeAddon = addon as NativeClipboardAddon;
        break;
      }
    } catch {
      // Try the next resolution root.
    }
  }
  return cachedNativeAddon;
}

export interface NativeChannelOptions {
  /** Native addon loader override (tests). Defaults to {@link loadNativeAddon}. */
  loadNative?: () => NativeClipboardAddon | null;
}

/**
 * Native channel: read plain text via the `@mariozechner/clipboard` addon.
 * A missing/unloadable addon reports `unavailable`; a loaded addon that sees
 * no text reports `empty` (definitive, stops the cascade).
 */
export function makeNativeChannel(
  options: NativeChannelOptions = {},
): ClipboardReadChannel {
  const load = options.loadNative ?? loadNativeAddon;
  return {
    name: "native",
    async read() {
      let addon: NativeClipboardAddon | null;
      try {
        addon = load();
      } catch {
        addon = null;
      }
      if (!addon) return { ok: false, reason: "unavailable" };
      try {
        const text = await addon.getText();
        return text && text.length > 0
          ? { ok: true, text }
          : { ok: false, reason: "empty" };
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },
  };
}

/**
 * PowerShell channel: `powershell.exe -NoProfile -Command "Get-Clipboard
 * -Raw"`, mirroring pi's clipboard-image PowerShell channel family. The
 * `-Raw` flag preserves the exact text (no extra newline), and the output
 * encoding is pinned to UTF-8 because the text travels over the console
 * pipe (pi's image reader sidesteps this by writing a temp file).
 */
export function makePowerShellChannel(
  options: CommandChannelOptions = {},
): ClipboardReadChannel {
  return makeCommandChannel(
    "powershell",
    "powershell.exe",
    ["-NoProfile", "-Command", PS_GET_CLIPBOARD_SCRIPT],
    options,
  );
}

/** macOS channel: `pbpaste` (adds a trailing newline the strip removes). */
export function makePbpasteChannel(
  options: CommandChannelOptions = {},
): ClipboardReadChannel {
  return makeCommandChannel("pbpaste", "pbpaste", [], options);
}

/** OSC 52 clipboard query: query the clipboard (c = clipboard, ? = read). */
export const OSC52_QUERY = "\x1b]52;c;?\x07";

/** Terminal reply envelope: `\x1b]52;c;<base64>` ended by BEL or ST. */
const OSC52_REPLY_RE = /\x1b\]52;c;([^\x07\x1b]*)(?:\x07|\x1b\\)/;

/** Base64 payload guard (terminal replies are always well-formed). */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decode an OSC 52 base64 payload; null for empty / echoed / malformed. */
export function decodeOsc52Payload(payload: string): string | null {
  if (payload.length === 0 || payload === "?" || !BASE64_RE.test(payload)) {
    return null;
  }
  try {
    return Buffer.from(payload, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Extract and decode the text from a raw OSC 52 reply. Accepts both BEL
 * (`\x07`) and ST (`ESC \`) terminators, and replies that arrive split
 * across stdin chunks (the regex matches once the sequence is complete).
 * Returns null for empty / echoed-query / malformed replies.
 */
export function parseOsc52Reply(raw: string): string | null {
  const match = OSC52_REPLY_RE.exec(raw);
  if (!match) return null;
  const text = decodeOsc52Payload(match[1]);
  return text && text.length > 0 ? text : null;
}

export interface Osc52ChannelOptions {
  /** Query writer override (tests). Defaults to `process.stdout.write`. */
  write?: (sequence: string) => void;
  /**
   * Reply reader override (tests). Defaults to a best-effort
   * `process.stdin` listener with a timeout. The overlay integration
   * (right-click paste, C2) may supply its own reader that intercepts the
   * reply before pi-tui's StdinBuffer sees it.
   */
  readReply?: (timeoutMs: number) => Promise<string | null>;
  timeoutMs?: number;
}

const OSC52_READ_TIMEOUT_MS = 2000;

/** Best-effort default: buffer raw stdin until the reply completes or the
 * timeout elapses (terminals without OSC 52 query support never reply). */
function defaultReadReply(timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin || typeof stdin.on !== "function") {
      resolve(null);
      return;
    }
    let buffer = "";
    const timer = setTimeout(
      () => finish(buffer.length > 0 ? buffer : null),
      timeoutMs,
    );
    function onData(chunk: string | Buffer): void {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      if (OSC52_REPLY_RE.test(buffer)) finish(buffer);
    }
    function finish(value: string | null): void {
      clearTimeout(timer);
      stdin.removeListener("data", onData);
      resolve(value);
    }
    stdin.on("data", onData);
    if (stdin.isPaused && stdin.isPaused()) stdin.resume();
  });
}

/**
 * OSC 52 query channel: write the query, read and decode the reply. A
 * missing/unparsable reply is reported `unavailable` (the terminal either
 * does not answer queries or the clipboard is empty — OSC 52 cannot tell
 * the two apart, so callers treat it as a failed read).
 */
export function makeOsc52Channel(
  options: Osc52ChannelOptions = {},
): ClipboardReadChannel {
  const write =
    options.write ?? ((sequence: string) => process.stdout.write(sequence));
  const readReply = options.readReply ?? defaultReadReply;
  const timeoutMs = options.timeoutMs ?? OSC52_READ_TIMEOUT_MS;
  return {
    name: "osc52",
    async read() {
      // Attach the reply reader before sending the query so an immediate
      // reply is not missed.
      const replyPromise = readReply(timeoutMs);
      write(OSC52_QUERY);
      const raw = await replyPromise;
      if (raw === null) return { ok: false, reason: "unavailable" };
      const text = parseOsc52Reply(raw);
      return text === null
        ? { ok: false, reason: "unavailable" }
        : { ok: true, text };
    },
  };
}

export interface PlatformChannelsOptions {
  /** Platform override (tests). Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
  write?: (sequence: string) => void;
  readReply?: (timeoutMs: number) => Promise<string | null>;
  /** Native addon loader override (tests). Defaults to the real loader. */
  loadNative?: () => NativeClipboardAddon | null;
}
/**
 * The per-platform channel matrix (primary first, then fallbacks). win32 /
 * darwin lead with the native addon, fall back to their platform tool, then
 * to an OSC 52 query; linux (and unknown platforms) query OSC 52 directly —
 * mirroring the write-side cascade where OSC 52 is the universal last resort.
 */
export function buildPlatformChannels(
  options: PlatformChannelsOptions = {},
): ClipboardReadChannel[] {
  const osc52 = makeOsc52Channel({
    write: options.write,
    readReply: options.readReply,
  });
  switch (options.platform ?? process.platform) {
    case "win32":
      return [
        makeNativeChannel({ loadNative: options.loadNative }),
        makePowerShellChannel({ exec: options.exec, env: options.env }),
        osc52,
      ];
    case "darwin":
      return [
        makeNativeChannel({ loadNative: options.loadNative }),
        makePbpasteChannel({ exec: options.exec, env: options.env }),
        osc52,
      ];
    case "linux":
      return [osc52];
    default:
      return [osc52];
  }
}

/** Read the clipboard with the current platform's channel matrix. */
export function readClipboardTextFromSystem(
  options: PlatformChannelsOptions = {},
): Promise<ClipboardReadOutcome> {
  return readClipboardText(buildPlatformChannels(options));
}
