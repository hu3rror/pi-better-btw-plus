import { describe, expect, test } from "bun:test";
import {
  StatusChannel,
  type SteadySourceOptions,
} from "../srcs/status-channel.ts";

function makeClock() {
  let now = 0;
  const timers = new Map<
    number,
    { fn: () => void; at: number; repeat: number | null }
  >();
  let nextId = 1;

  const schedule = (fn: () => void, ms: number, repeat: number | null) => {
    const id = nextId++;
    timers.set(id, { fn, at: now + ms, repeat });
    return id;
  };

  const advance = (ms: number) => {
    now += ms;
    for (;;) {
      let fired = false;
      for (const [id, timer] of timers) {
        if (timer.at <= now) {
          if (timer.repeat !== null) timer.at += timer.repeat;
          else timers.delete(id);
          timer.fn();
          fired = true;
          break;
        }
      }
      if (!fired) break;
    }
  };

  return {
    now: () => now,
    advance,
    setInterval: (fn: () => void, ms: number) => schedule(fn, ms, ms),
    clearInterval: (id: unknown) => void timers.delete(id as number),
    setTimeout: (fn: () => void, ms: number) => schedule(fn, ms, null),
    clearTimeout: (id: unknown) => void timers.delete(id as number),
  };
}

function makeHarness() {
  const clock = makeClock();
  const rendered: string[] = [];
  const channel = new StatusChannel({
    render: (text) => rendered.push(text),
    now: clock.now,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  return { clock, channel, rendered };
}

const spinnerSource = (): SteadySourceOptions => ({
  tickMs: 80,
  text: (frame) => `spin${frame}`,
});

describe("status-channel: steady sources", () => {
  test("steady sources replace each other; reset clears everything", () => {
    const { channel, rendered } = makeHarness();
    channel.setSteady("spinner", spinnerSource());
    expect(rendered.at(-1)).toBe("spin0");
    channel.setSteady("tool", { text: () => "Running bash..." });
    expect(rendered.at(-1)).toBe("Running bash...");
    channel.setSteady("lane", { text: () => "🚧 lane blocked" });
    expect(rendered.at(-1)).toBe("🚧 lane blocked");
    channel.reset();
    expect(rendered.at(-1)).toBe("");
  });

  test("ticker advances frames, stops when replaced, resets when re-set", () => {
    const { channel, clock, rendered } = makeHarness();
    channel.setSteady("spinner", { tickMs: 80, text: (f) => `f${f}` });
    clock.advance(80);
    expect(rendered.at(-1)).toBe("f1");
    clock.advance(160);
    expect(rendered.at(-1)).toBe("f3");
    channel.setSteady("tool", { text: () => "Running X..." });
    clock.advance(400);
    expect(rendered.at(-1)).toBe("Running X...");
    channel.setSteady("spinner", { tickMs: 80, text: (f) => `f${f}` });
    expect(rendered.at(-1)).toBe("f0");
  });
});

describe("status-channel: flash", () => {
  test("flash overlays the steady source and falls back on expiry (spinner ticks never clobber it)", () => {
    const { channel, clock, rendered } = makeHarness();
    channel.setSteady("spinner", spinnerSource());
    channel.flash("✓ Copied 5 chars", 1200);
    expect(rendered.at(-1)).toBe("✓ Copied 5 chars");
    clock.advance(80);
    expect(rendered.at(-1)).toBe("✓ Copied 5 chars");
    clock.advance(800);
    expect(rendered.at(-1)).toBe("✓ Copied 5 chars");
    clock.advance(400);
    expect(rendered.at(-1)).toBe("spin16");
  });

  test("flash without a steady source clears to empty on expiry", () => {
    const { channel, clock, rendered } = makeHarness();
    channel.flash("Clipboard is empty", 1200);
    expect(rendered.at(-1)).toBe("Clipboard is empty");
    clock.advance(1200);
    expect(rendered.at(-1)).toBe("");
  });

  test("a second flash replaces the first and resets its expiry", () => {
    const { channel, clock, rendered } = makeHarness();
    channel.flash("a", 1200);
    clock.advance(500);
    channel.flash("b", 300);
    expect(rendered.at(-1)).toBe("b");
    clock.advance(250);
    expect(rendered.at(-1)).toBe("b");
    clock.advance(60);
    expect(rendered.at(-1)).toBe("");
  });

  test("flash falls back to the current steady source when the steady changed mid-flash", () => {
    const { channel, clock, rendered } = makeHarness();
    channel.setSteady("spinner", spinnerSource());
    channel.flash("Copied", 1200);
    clock.advance(100);
    channel.setSteady("tool", { text: () => "Running X..." });
    clock.advance(1100);
    expect(rendered.at(-1)).toBe("Running X...");
  });
});

describe("status-channel: expiry + clear", () => {
  test("expiresMs clears the source and fires onExpired (retry → spinner hand-off)", () => {
    const { channel, clock, rendered } = makeHarness();
    const expired = { fired: false };
    channel.setSteady(
      "retry",
      {
        tickMs: 250,
        text: (f) => `retry${f}`,
        expiresMs: 2000,
        onExpired: () => {
          expired.fired = true;
          channel.setSteady("spinner", { text: () => "spin-settled" });
        },
      },
    );
    expect(rendered.at(-1)).toBe("retry0");
    clock.advance(250);
    expect(rendered.at(-1)).toBe("retry1");
    clock.advance(1750);
    expect(expired.fired).toBe(true);
    expect(rendered.at(-1)).toBe("spin-settled");
  });

  test("clearSteady keeps an active flash (stream lets the status line rest)", () => {
    const { channel, clock, rendered } = makeHarness();
    channel.setSteady("spinner", spinnerSource());
    channel.flash("✓ Copied 5 chars", 1200);
    channel.clearSteady();
    expect(rendered.at(-1)).toBe("✓ Copied 5 chars");
    clock.advance(1200);
    expect(rendered.at(-1)).toBe("");
  });

  test("reset clears a mid-flight flash and its timer", () => {
    const { channel, clock, rendered } = makeHarness();
    channel.setSteady("spinner", spinnerSource());
    channel.flash("✓ Copied 5 chars", 1200);
    channel.reset();
    expect(rendered.at(-1)).toBe("");
    clock.advance(5000);
    expect(rendered.at(-1)).toBe("");
  });
});
