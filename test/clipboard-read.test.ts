/**
 * Clipboard reader (issue #4, D3): the injected platform-channel matrix with
 * level-by-level fallback. Channels are plain injected functions, so the
 * success / fallback / all-fail paths are covered with fakes instead of
 * touching the host clipboard (prior art: config.test.ts's injected
 * temp-tree pattern).
 */
import { describe, expect, test } from "bun:test";
import {
  OSC52_QUERY,
  buildPlatformChannels,
  decodeOsc52Payload,
  makeOsc52Channel,
  makePbpasteChannel,
  makePowerShellChannel,
  parseOsc52Reply,
  readClipboardText,
  readClipboardTextFromSystem,
  type ClipboardReadChannel,
  type ExecFn,
} from "../srcs/clipboard-read.ts";

/** Build a channel whose read resolves to text / null or rejects. */
function channel(name: string, outcome: string | null | Error): ClipboardReadChannel {
  return {
    name,
    async read() {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

const execOk = (stdout: string): ExecFn => () => ({ ok: true, stdout });
const execFail: ExecFn = () => ({ ok: false, stdout: "" });

const osc52Reply = (text: string, terminator: "\x07" | "\x1b\\" = "\x07") =>
  `\x1b]52;c;${Buffer.from(text).toString("base64")}${terminator}`;

describe("readClipboardText cascade", () => {
  test("returns the first channel's text and stops", async () => {
    let calls = 0;
    const channels: ClipboardReadChannel[] = [
      { name: "a", read: async () => { calls += 1; return "text-a"; } },
      { name: "b", read: async () => { calls += 1; return "text-b"; } },
    ];
    await expect(readClipboardText(channels)).resolves.toBe("text-a");
    expect(calls).toBe(1);
  });

  test("falls back to the next channel when the primary yields null", async () => {
    const result = await readClipboardText([
      channel("a", null),
      channel("b", "fallback text"),
    ]);
    expect(result).toBe("fallback text");
  });

  test("falls back when the primary throws (never rethrows)", async () => {
    const result = await readClipboardText([
      channel("a", new Error("boom")),
      channel("b", "recovered"),
    ]);
    expect(result).toBe("recovered");
  });

  test("returns null when every channel yields null", async () => {
    await expect(
      readClipboardText([channel("a", null), channel("b", null)]),
    ).resolves.toBeNull();
  });

  test("returns null when every channel throws", async () => {
    await expect(
      readClipboardText([
        channel("a", new Error("x")),
        channel("b", new Error("y")),
      ]),
    ).resolves.toBeNull();
  });

  test("returns null for an empty channel list", async () => {
    await expect(readClipboardText([])).resolves.toBeNull();
  });

  test("skips an empty-string channel and keeps cascading", async () => {
    const result = await readClipboardText([
      channel("a", ""),
      channel("b", "later"),
    ]);
    expect(result).toBe("later");
  });
});

describe("channel factories", () => {
  test("powershell channel reads Get-Clipboard -Raw and strips the tool newline", async () => {
    let captured: { command: string; args: string[] } | undefined;
    const exec: ExecFn = (command, args) => {
      captured = { command, args: [...args] };
      return { ok: true, stdout: "hello world\r\n" };
    };
    const text = await makePowerShellChannel({ exec }).read();
    expect(text).toBe("hello world");
    expect(captured?.command).toBe("powershell.exe");
    expect(captured?.args[0]).toBe("-NoProfile");
    expect(captured?.args[1]).toBe("-Command");
    expect(captured?.args[2]).toContain("Get-Clipboard -Raw");
  });

  test("powershell channel returns null on failure / empty clipboard", async () => {
    await expect(makePowerShellChannel({ exec: execFail }).read()).resolves.toBeNull();
    await expect(
      makePowerShellChannel({ exec: execOk("") }).read(),
    ).resolves.toBeNull();
    await expect(
      makePowerShellChannel({ exec: () => { throw new Error("spawn"); } }).read(),
    ).resolves.toBeNull();
  });

  test("powershell channel preserves interior newlines (only the tool one is stripped)", async () => {
    await expect(
      makePowerShellChannel({ exec: execOk("line1\r\nline2\r\n") }).read(),
    ).resolves.toBe("line1\r\nline2");
  });

  test("pbpaste channel reads via pbpaste", async () => {
    let captured: { command: string; args: string[] } | undefined;
    const exec: ExecFn = (command, args) => {
      captured = { command, args: [...args] };
      return { ok: true, stdout: "mac text\n" };
    };
    await expect(makePbpasteChannel({ exec }).read()).resolves.toBe("mac text");
    expect(captured?.command).toBe("pbpaste");
    expect(captured?.args).toEqual([]);
  });

  test("pbpaste channel returns null on failure", async () => {
    await expect(makePbpasteChannel({ exec: execFail }).read()).resolves.toBeNull();
    await expect(
      makePbpasteChannel({ exec: () => { throw new Error("spawn"); } }).read(),
    ).resolves.toBeNull();
  });

  test("osc52 channel writes the query and decodes the reply", async () => {
    const written: string[] = [];
    const chan = makeOsc52Channel({
      write: (s) => written.push(s),
      readReply: async () => osc52Reply("osc payload"),
    });
    await expect(chan.read()).resolves.toBe("osc payload");
    expect(written).toEqual([OSC52_QUERY]);
  });

  test("osc52 channel returns null when the terminal never replies", async () => {
    const chan = makeOsc52Channel({
      write: () => {},
      readReply: async () => null,
    });
    await expect(chan.read()).resolves.toBeNull();
  });

  test("osc52 channel returns null for an empty / echoed-query reply", async () => {
    for (const reply of ["\x1b]52;c;\x07", "\x1b]52;c;?\x07", "not a reply"]) {
      const chan = makeOsc52Channel({
        write: () => {},
        readReply: async () => reply,
      });
      await expect(chan.read()).resolves.toBeNull();
    }
  });
});

describe("parseOsc52Reply / decodeOsc52Payload", () => {
  test("decodes a BEL-terminated reply", () => {
    expect(parseOsc52Reply(osc52Reply("hello"))).toBe("hello");
  });

  test("decodes an ST-terminated reply", () => {
    expect(parseOsc52Reply(osc52Reply("hello", "\x1b\\"))).toBe("hello");
  });

  test("decodes a reply split across stdin chunks", () => {
    const b64 = Buffer.from("split reply").toString("base64");
    expect(parseOsc52Reply(`\x1b]52;c;${b64.slice(0, 5)}${b64.slice(5)}\x07`)).toBe(
      "split reply",
    );
  });

  test("ignores trailing bytes after the reply (glued to later input)", () => {
    expect(parseOsc52Reply(`${osc52Reply("x")}junk`)).toBe("x");
  });

  test("decodes UTF-8 (CJK) payloads", () => {
    expect(parseOsc52Reply(osc52Reply("你好，世界"))).toBe("你好，世界");
  });

  test("returns null for malformed replies", () => {
    expect(parseOsc52Reply("garbage")).toBeNull();
    expect(parseOsc52Reply("\x1b]52;c;!!!not-base64!!!\x07")).toBeNull();
    expect(decodeOsc52Payload("???")).toBeNull();
    expect(decodeOsc52Payload("")).toBeNull();
  });
});

describe("platform channel matrix", () => {
  test("win32: PowerShell primary, OSC 52 fallback", () => {
    const names = buildPlatformChannels({
      platform: "win32",
      exec: execFail,
    }).map((c) => c.name);
    expect(names).toEqual(["powershell", "osc52"]);
  });

  test("darwin: pbpaste primary, OSC 52 fallback", () => {
    const names = buildPlatformChannels({
      platform: "darwin",
      exec: execFail,
    }).map((c) => c.name);
    expect(names).toEqual(["pbpaste", "osc52"]);
  });

  test("linux: OSC 52 only", () => {
    const names = buildPlatformChannels({ platform: "linux" }).map((c) => c.name);
    expect(names).toEqual(["osc52"]);
  });

  test("unknown platform: OSC 52 only", () => {
    const names = buildPlatformChannels({ platform: "aix" }).map((c) => c.name);
    expect(names).toEqual(["osc52"]);
  });
});

describe("readClipboardTextFromSystem end-to-end", () => {
  test("win32: primary success returns the text", async () => {
    const written: string[] = [];
    const text = await readClipboardTextFromSystem({
      platform: "win32",
      exec: execOk("from powershell\r\n"),
      write: (s) => written.push(s),
      readReply: async () => null,
    });
    expect(text).toBe("from powershell");
    expect(written).toEqual([]); // primary succeeded — no OSC 52 query
  });

  test("win32: primary fails, OSC 52 fallback succeeds", async () => {
    const written: string[] = [];
    const text = await readClipboardTextFromSystem({
      platform: "win32",
      exec: execFail,
      write: (s) => written.push(s),
      readReply: async () => osc52Reply("from osc52"),
    });
    expect(text).toBe("from osc52");
    expect(written).toEqual([OSC52_QUERY]);
  });

  test("darwin: pbpaste fails, OSC 52 fallback succeeds", async () => {
    const written: string[] = [];
    const text = await readClipboardTextFromSystem({
      platform: "darwin",
      exec: execFail,
      write: (s) => written.push(s),
      readReply: async () => osc52Reply("mac fallback"),
    });
    expect(text).toBe("mac fallback");
    expect(written).toEqual([OSC52_QUERY]);
  });

  test("linux: OSC 52 success", async () => {
    const written: string[] = [];
    const text = await readClipboardTextFromSystem({
      platform: "linux",
      write: (s) => written.push(s),
      readReply: async () => osc52Reply("linux clipboard"),
    });
    expect(text).toBe("linux clipboard");
    expect(written).toEqual([OSC52_QUERY]);
  });

  test("all channels fail → null, never throws", async () => {
    await expect(
      readClipboardTextFromSystem({
        platform: "win32",
        exec: () => { throw new Error("powershell missing"); },
        write: () => {},
        readReply: async () => null,
      }),
    ).resolves.toBeNull();
  });
});
