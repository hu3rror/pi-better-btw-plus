/**
 * Clipboard reader (issue #4, D3): the injected platform-channel matrix with
 * level-by-level fallback. Channels are plain injected functions, so the
 * success / fallback / all-fail paths are covered with fakes instead of
 * touching the host clipboard (prior art: config.test.ts's injected
 * temp-tree pattern). Outcomes distinguish text, an explicitly empty
 * clipboard, and no usable channel — the caller (right-click paste, #7)
 * surfaces a reason-specific hint from that.
 */
import { describe, expect, test } from "bun:test";
import {
  OSC52_QUERY,
  buildPlatformChannels,
  decodeOsc52Payload,
  makeNativeChannel,
  makeOsc52Channel,
  makePbpasteChannel,
  makePowerShellChannel,
  parseOsc52Reply,
  readClipboardText,
  readClipboardTextFromSystem,
  type ClipboardReadChannel,
  type ClipboardReadOutcome,
  type ExecFn,
  type NativeClipboardAddon,
} from "../srcs/clipboard-read.ts";

const ok = (text: string): ClipboardReadOutcome => ({ ok: true, text });
const unavailable: ClipboardReadOutcome = { ok: false, reason: "unavailable" };
const empty: ClipboardReadOutcome = { ok: false, reason: "empty" };

/** Build a channel whose read resolves to an outcome / rejects. */
function channel(name: string, outcome: ClipboardReadOutcome | Error): ClipboardReadChannel {
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
      { name: "a", read: async () => { calls += 1; return ok("text-a"); } },
      { name: "b", read: async () => { calls += 1; return ok("text-b"); } },
    ];
    await expect(readClipboardText(channels)).resolves.toEqual(ok("text-a"));
    expect(calls).toBe(1);
  });

  test("falls back to the next channel when the primary is unavailable", async () => {
    const result = await readClipboardText([
      channel("a", unavailable),
      channel("b", ok("fallback text")),
    ]);
    expect(result).toEqual(ok("fallback text"));
  });

  test("falls back when the primary throws (never rethrows)", async () => {
    const result = await readClipboardText([
      channel("a", new Error("boom")),
      channel("b", ok("recovered")),
    ]);
    expect(result).toEqual(ok("recovered"));
  });

  test("an explicitly empty clipboard is a definitive answer, no fallback", async () => {
    let calls = 0;
    const channels: ClipboardReadChannel[] = [
      { name: "a", read: async () => { calls += 1; return empty; } },
      { name: "b", read: async () => { calls += 1; return ok("later"); } },
    ];
    await expect(readClipboardText(channels)).resolves.toEqual(empty);
    expect(calls).toBe(1);
  });

  test("returns unavailable when every channel is unavailable", async () => {
    await expect(
      readClipboardText([channel("a", unavailable), channel("b", unavailable)]),
    ).resolves.toEqual(unavailable);
  });

  test("returns unavailable when every channel throws", async () => {
    await expect(
      readClipboardText([
        channel("a", new Error("x")),
        channel("b", new Error("y")),
      ]),
    ).resolves.toEqual(unavailable);
  });

  test("returns unavailable for an empty channel list", async () => {
    await expect(readClipboardText([])).resolves.toEqual(unavailable);
  });
});

describe("channel factories", () => {
  test("powershell channel reads Get-Clipboard -Raw and strips the tool newline", async () => {
    let captured: { command: string; args: string[] } | undefined;
    const exec: ExecFn = (command, args) => {
      captured = { command, args: [...args] };
      return { ok: true, stdout: "hello world\r\n" };
    };
    const outcome = await makePowerShellChannel({ exec }).read();
    expect(outcome).toEqual(ok("hello world"));
    expect(captured?.command).toBe("powershell.exe");
    expect(captured?.args[0]).toBe("-NoProfile");
    expect(captured?.args[1]).toBe("-Command");
    expect(captured?.args[2]).toContain("Get-Clipboard -Raw");
  });

  test("powershell channel reports unavailable on failure / missing tool", async () => {
    await expect(makePowerShellChannel({ exec: execFail }).read()).resolves.toEqual(
      unavailable,
    );
    await expect(
      makePowerShellChannel({ exec: () => { throw new Error("spawn"); } }).read(),
    ).resolves.toEqual(unavailable);
  });

  test("powershell channel reports empty for an exit-0 empty clipboard", async () => {
    await expect(makePowerShellChannel({ exec: execOk("") }).read()).resolves.toEqual(
      empty,
    );
  });

  test("powershell channel preserves interior newlines (only the tool one is stripped)", async () => {
    await expect(
      makePowerShellChannel({ exec: execOk("line1\r\nline2\r\n") }).read(),
    ).resolves.toEqual(ok("line1\r\nline2"));
  });

  test("pbpaste channel reads via pbpaste", async () => {
    let captured: { command: string; args: string[] } | undefined;
    const exec: ExecFn = (command, args) => {
      captured = { command, args: [...args] };
      return { ok: true, stdout: "mac text\n" };
    };
    await expect(makePbpasteChannel({ exec }).read()).resolves.toEqual(ok("mac text"));
    expect(captured?.command).toBe("pbpaste");
    expect(captured?.args).toEqual([]);
  });

  test("pbpaste channel reports unavailable on failure", async () => {
    await expect(makePbpasteChannel({ exec: execFail }).read()).resolves.toEqual(
      unavailable,
    );
    await expect(
      makePbpasteChannel({ exec: () => { throw new Error("spawn"); } }).read(),
    ).resolves.toEqual(unavailable);
  });

  test("osc52 channel writes the query and decodes the reply", async () => {
    const written: string[] = [];
    const chan = makeOsc52Channel({
      write: (s) => written.push(s),
      readReply: async () => osc52Reply("osc payload"),
    });
    await expect(chan.read()).resolves.toEqual(ok("osc payload"));
    expect(written).toEqual([OSC52_QUERY]);
  });

  test("osc52 channel reports unavailable when the terminal never replies", async () => {
    const chan = makeOsc52Channel({
      write: () => {},
      readReply: async () => null,
    });
    await expect(chan.read()).resolves.toEqual(unavailable);
  });

  test("osc52 channel reports unavailable for an empty / echoed-query reply", async () => {
    for (const reply of ["\x1b]52;c;\x07", "\x1b]52;c;?\x07", "not a reply"]) {
      const chan = makeOsc52Channel({
        write: () => {},
        readReply: async () => reply,
      });
      await expect(chan.read()).resolves.toEqual(unavailable);
    }
  });

  test("native channel reads via the addon's getText", async () => {
    const addon: NativeClipboardAddon = { getText: async () => "native text" };
    await expect(
      makeNativeChannel({ loadNative: () => addon }).read(),
    ).resolves.toEqual(ok("native text"));
  });

  test("native channel reports empty when the addon sees no text", async () => {
    for (const value of [null, ""]) {
      const addon: NativeClipboardAddon = { getText: async () => value };
      await expect(
        makeNativeChannel({ loadNative: () => addon }).read(),
      ).resolves.toEqual(empty);
    }
  });

  test("native channel reports unavailable when the addon is missing / throws", async () => {
    await expect(makeNativeChannel({ loadNative: () => null }).read()).resolves.toEqual(
      unavailable,
    );
    const boom: NativeClipboardAddon = {
      getText: async () => {
        throw new Error("addon exploded");
      },
    };
    await expect(makeNativeChannel({ loadNative: () => boom }).read()).resolves.toEqual(
      unavailable,
    );
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
  test("win32: native primary, PowerShell fallback, OSC 52 last", () => {
    const names = buildPlatformChannels({
      platform: "win32",
      exec: execFail,
      loadNative: () => null,
    }).map((c) => c.name);
    expect(names).toEqual(["native", "powershell", "osc52"]);
  });

  test("darwin: native primary, pbpaste fallback, OSC 52 last", () => {
    const names = buildPlatformChannels({
      platform: "darwin",
      exec: execFail,
      loadNative: () => null,
    }).map((c) => c.name);
    expect(names).toEqual(["native", "pbpaste", "osc52"]);
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
    const outcome = await readClipboardTextFromSystem({
      platform: "win32",
      exec: execOk("from powershell\r\n"),
      loadNative: () => null, // native addon unavailable — PowerShell path
      write: (s) => written.push(s),
      readReply: async () => null,
    });
    expect(outcome).toEqual(ok("from powershell"));
    expect(written).toEqual([]); // primary succeeded — no OSC 52 query
  });

  test("win32: empty primary is a definitive answer (no OSC 52 query)", async () => {
    const written: string[] = [];
    const outcome = await readClipboardTextFromSystem({
      platform: "win32",
      exec: execOk(""),
      loadNative: () => null, // native addon unavailable — PowerShell path
      write: (s) => written.push(s),
      readReply: async () => null,
    });
    expect(outcome).toEqual(empty);
    expect(written).toEqual([]); // empty is definitive — cascade stops
  });

  test("win32: primary fails, OSC 52 fallback succeeds", async () => {
    const written: string[] = [];
    const outcome = await readClipboardTextFromSystem({
      platform: "win32",
      exec: execFail,
      loadNative: () => null, // native addon unavailable — PowerShell path
      write: (s) => written.push(s),
      readReply: async () => osc52Reply("from osc52"),
    });
    expect(outcome).toEqual(ok("from osc52"));
    expect(written).toEqual([OSC52_QUERY]);
  });

  test("darwin: pbpaste fails, OSC 52 fallback succeeds", async () => {
    const written: string[] = [];
    const outcome = await readClipboardTextFromSystem({
      platform: "darwin",
      exec: execFail,
      loadNative: () => null, // native addon unavailable — pbpaste path
      write: (s) => written.push(s),
      readReply: async () => osc52Reply("mac fallback"),
    });
    expect(outcome).toEqual(ok("mac fallback"));
    expect(written).toEqual([OSC52_QUERY]);
  });

  test("linux: OSC 52 success", async () => {
    const written: string[] = [];
    const outcome = await readClipboardTextFromSystem({
      platform: "linux",
      write: (s) => written.push(s),
      readReply: async () => osc52Reply("linux clipboard"),
    });
    expect(outcome).toEqual(ok("linux clipboard"));
    expect(written).toEqual([OSC52_QUERY]);
  });

  test("win32: native addon success short-circuits (no subprocess, no OSC 52)", async () => {
    const written: string[] = [];
    let execCalls = 0;
    const outcome = await readClipboardTextFromSystem({
      platform: "win32",
      exec: () => {
        execCalls += 1;
        return { ok: true, stdout: "should not run" };
      },
      write: (s) => written.push(s),
      readReply: async () => null,
      loadNative: () => ({ getText: async () => "from native addon" }),
    });
    expect(outcome).toEqual(ok("from native addon"));
    expect(execCalls).toBe(0); // PowerShell never spawned
    expect(written).toEqual([]); // no OSC 52 query
  });

  test("win32: native empty is definitive (no subprocess, no OSC 52)", async () => {
    const written: string[] = [];
    let execCalls = 0;
    const outcome = await readClipboardTextFromSystem({
      platform: "win32",
      exec: () => {
        execCalls += 1;
        return { ok: true, stdout: "should not run" };
      },
      write: (s) => written.push(s),
      readReply: async () => null,
      loadNative: () => ({ getText: async () => null }),
    });
    expect(outcome).toEqual(empty);
    expect(execCalls).toBe(0);
    expect(written).toEqual([]);
  });

  test("win32: native unavailable falls through to PowerShell, then OSC 52", async () => {
    const written: string[] = [];
    const outcome = await readClipboardTextFromSystem({
      platform: "win32",
      exec: execFail,
      write: (s) => written.push(s),
      readReply: async () => osc52Reply("deep fallback"),
      loadNative: () => null,
    });
    expect(outcome).toEqual(ok("deep fallback"));
    expect(written).toEqual([OSC52_QUERY]);
  });

  test("all channels fail → unavailable, never throws", async () => {
    await expect(
      readClipboardTextFromSystem({
        platform: "win32",
        exec: () => { throw new Error("powershell missing"); },
        loadNative: () => null, // native addon unavailable too
        write: () => {},
        readReply: async () => null,
      }),
    ).resolves.toEqual(unavailable);
  });
});
