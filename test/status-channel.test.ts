/**
 * StatusChannel unit tests (spec issue #19): fake-clock driven assertions
 * against the injected render sink. Only external behavior is tested — the
 * text sequence the channel emits — never internal fields. All timers run
 * on a scripted scheduler so no real time elapses.
 *
 * Prior art: retry.test.ts (injected delay/clock), fork-turn.test.ts
 * (phase log), pointer-gesture.test.ts (injected now).
 */
import { describe, expect, test } from "bun:test";
import {
  StatusChannel,
  type SteadySourceOptions,
} from "../srcs/status-channel.ts";

/** Scripted scheduler: advance(ms) fires due timers against a fake clock. */
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
    // Fire due timers one at a time; firing may schedule or clear timers.
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
    clock.advance(400); // the tool source has no ticker: nothing changes
    expect(rendered.at(-1)).toBe("Running X...");
    channel.setSteady("spinner", { tickMs: 80, text: (f) => `f${f}` });
    expect(rendered.at(-1)).toBe("f0"); // frame reset on re-set
  });
});

describe("status-channel: flash", () => {
  test("flash overlays the steady source and falls back on expiry (spinner ticks never clobber it)", () => {
    const { channel, clock, rendered } = makeHarness();
    channel.setSteady("spinner", spinnerSource()); // "spin0"
    channel.flash("✓ Copied 5 chars", 1200);
    expect(rendered.at(-1)).toBe("✓ Copied 5 chars");
    clock.advance(80); // a spinner tick fires — must NOT clobber the flash
    expect(rendered.at(-1)).toBe("✓ Copied 5 chars");
    clock.advance(800); // 880ms: still inside the 1200ms window
    expect(rendered.at(-1)).toBe("✓ Copied 5 chars");
    clock.advance(400); // 1280ms ≥ 1200: flash expires, falls back to the spinner
    // spinner ticked at 80..1280 → 16 ticks → frame 16
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
    clock.advance(250); // 750: first flash was cleared; second expires at 800
    expect(rendered.at(-1)).toBe("b");
    clock.advance(60); // 810 ≥ 800: second expires, nothing to fall back to
    expect(rendered.at(-1)).toBe("");
  });

  test("flash falls back to the current steady source when the steady changed mid-flash", () => {
    const { channel, clock, rendered } = makeHarness();
    channel.setSteady("spinner", spinnerSource());
    channel.flash("Copied", 1200);
    clock.advance(100);
    channel.setSteady("tool", { text: () => "Running X..." }); // spinner replaced mid-flash
    clock.advance(1100); // flash expires at 1200
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
    clock.advance(1750); // now 2000: the expiry tick fires
    expect(expired.fired).toBe(true);
    expect(rendered.at(-1)).toBe("spin-settled");
  });

  test("clearSteady keeps an active flash (stream lets the status line rest)", () => {
    const { channel, clock, rendered } = makeHarness();
    channel.setSteady("spinner", spinnerSource());
    channel.flash("✓ Copied 5 chars", 1200);
    channel.clearSteady();
    expect(rendered.at(-1)).toBe("✓ Copied 5 chars"); // flash survives
    clock.advance(1200);
    expect(rendered.at(-1)).toBe(""); // no steady left to fall back to
  });

  test("reset clears a mid-flight flash and its timer", () => {
    const { channel, clock, rendered } = makeHarness();
    channel.setSteady("spinner", spinnerSource());
    channel.flash("✓ Copied 5 chars", 1200);
    channel.reset();
    expect(rendered.at(-1)).toBe("");
    clock.advance(5000); // nothing left scheduled: no further renders
    expect(rendered.at(-1)).toBe("");
  });
});