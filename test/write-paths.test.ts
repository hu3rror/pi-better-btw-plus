/**
 * Contract tests for write-path extraction (candidate 5 deepening):
 * `extractWritePaths(toolName, args)` → the filesystem paths a tool call
 * writes. Pure black-box: only the public API is exercised, so the internal
 * tokenizer can be reorganised freely as long as the contract holds.
 *
 * The fd-redirect cases (`N>&M`, `&>`, `&>>`) are the fixed bug family:
 * before the fix `cp a b 2>&1 | tee log` reported ["2","log"] (fd number "
 * 2" miscounted as the target, real target "b" missed).
 */
import { describe, expect, test } from "bun:test";
import { extractWritePaths } from "../srcs/write-paths.ts";

const bash = (command: string) => extractWritePaths("bash", { command });
const write = (path: string) => extractWritePaths("write", { path });
const edit = (path: string) => extractWritePaths("edit", { path });
const other = (args: unknown) => extractWritePaths("read", args);

const cases: Array<[string, string, string[]]> = [
  // --- redirects push their target ---
  ["echo hi > /tmp/x", "simple > redirect", ["/tmp/x"]],
  ["printf 'a' >> /tmp/out", ">> append redirect", ["/tmp/out"]],
  ["echo x 2>/tmp/err", "2> fd-stderr redirect", ["/tmp/err"]],
  ["ls > /tmp/list; echo done", "redirect inside a ; list", ["/tmp/list"]],
  ["cat <<EOF > /tmp/f", "heredoc with > redirect", ["/tmp/f"]],

  // --- fd duplication (N>&M) never pushes, never pollutes operands ---
  ["cp a b 2>&1 | tee log", "dup stderr in middle of pipe", ["b", "log"]],
  ["echo x 2>&1 > /tmp/y", "dup then >", ["/tmp/y"]],
  ["prog 1>&2 > /tmp/only", "dup stdout->stderr then >", ["/tmp/only"]],
  ["mv 2>&1 /tmp/z", "dup with only one real operand (mv errors out)", []],
  ["cp x 2>err dest", "fd-err redirect + real dest (err is written)", ["err", "dest"]],

  // --- &> / &>> (stdout+stderr combined redirect) ---
  ["cmd &> /tmp/amp", "&> combined redirect", ["/tmp/amp"]],
  ["cmd &>> /tmp/amp2", "&>> append combined redirect", ["/tmp/amp2"]],
  ["cmd > /dev/null 2>&1", "dup to /dev/null target", []],

  // --- quoting: spaces are one word ---
  ["cp 'wei rd name' dest", "single-quoted space", ["dest"]],
  ["cp \"has space\" dest2", "double-quoted space", ["dest2"]],

  // --- separators split command segments ---
  ["echo a && rm /tmp/r", "&&", ["/tmp/r"]],
  ["cd /tmp && touch a b && mv a c", "&& chain", ["a", "b", "c"]],
  ["ls > /tmp/list; echo hi", ";", ["/tmp/list"]],

  // --- command specials ---
  ["printf 'a' | tee /tmp/a /tmp/b", "tee after pipe", ["/tmp/a", "/tmp/b"]],
  ["touch /tmp/one /tmp/two", "touch", ["/tmp/one", "/tmp/two"]],
  ["rm -rf /tmp/dir", "rm with flags", ["/tmp/dir"]],
  ["rm -rf -- /tmp/dir", "rm with -- terminator", ["/tmp/dir"]],
  ["cp -r src/ dst/", "cp keeps last operand", ["dst/"]],
  ["cp a b", "cp", ["b"]],
  ["mv a b", "mv", ["b"]],
  ["mv a b c", "mv multi", ["c"]],
  ["echo hello", "no writes", []],

  // --- non-path noise is ignored ---
  ["> /dev/null", "null redirect", []],
  ["rm /dev/fd/3", "/dev/fd target", []],
  ["touch -foo", "flag-only operand", []],
];

describe("extractWritePaths — bash", () => {
  for (const [command, label, expected] of cases) {
    test(`${label}: ${command}`, () => {
      expect(bash(command)).toEqual(expected);
    });
  }
});

describe("extractWritePaths — non-bash tools", () => {
  test("write → the single path argument", () => {
    expect(write("file.txt")).toEqual(["file.txt"]);
  });
  test("edit → the single path argument", () => {
    expect(edit("src/a.ts")).toEqual(["src/a.ts"]);
  });
  test("read → never a write", () => {
    expect(other({ path: "file.txt" })).toEqual([]);
  });
  test("unknown args shape → never a write", () => {
    expect(other({ somethingElse: 1 })).toEqual([]);
    expect(bash("")).toEqual([]);
  });
});
