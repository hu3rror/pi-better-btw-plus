/**
 * ForkTurnRunner direct-drive suite (issue #10, T1): the full retry matrix and
 * lane enforcement are driven through the runner's public seam — run / cancel /
 * isRunning and the TurnPhase log — with a scripted fake agent injected via
 * agentFactory and synthetic agent events via the fake's emit() helper. No TUI,
 * no mocked overlay, no private-field pokes: phases are read like a log.
 *
 * The matrix is the frozen spec from issue #9 (Implementation Decisions +
 * Testing Decisions), moved here nearly verbatim from the overlay's retry
 * wiring suite, with render assertions replaced by phase-sequence assertions.
 * Prior art: retry.test.ts (scripted attempt / fake clock driving runWithRetry).
 */
import { describe, expect, test } from "bun:test";
import type { Agent, AgentOptions } from "@earendil-works/pi-agent-core";
import { ForkTurnRunner, type TurnPhase } from "../srcs/fork-turn.ts";
import type { PromptPack } from "../srcs/prompt-pack.ts";
import type { RetryPolicy } from "../srcs/retry.ts";

// --- Scripted fake agent ----------------------------------------------------

type AgentBehavior =
  | { kind: "fail"; errorMessage: string; partialText?: string }
  | { kind: "succeed"; text?: string }
  | { kind: "abort" }
  | { kind: "throw"; error: Error };

interface AgentCall {
  kind: "prompt" | "continue";
  /** Transcript snapshot at call time (proves the failed message was stripped). */
  messagesAtStart: unknown[];
}

/**
 * Agent-shaped scripted fake. `emit()` fires synthetic agent events through the
 * runner's subscription (lane-detection paths); `holdNext`/`releaseHeld` stall
 * one attempt so tests can observe mid-turn state; `lastContext` records the
 * transient context the runner's transformContext returned for the latest call.
 */
function makeFakeAgent(behaviors: AgentBehavior[]) {
  const listeners: Array<(event: any) => void> = [];
  const state: any = {
    messages: [],
    model: { id: "test-model", contextWindow: 128000 },
  };
  const calls: AgentCall[] = [];
  const held: Array<() => void> = [];
  let next = 0;
  let holdNextAttempt = false;
  let aborted = false;
  let transformContext: ((messages: any[]) => Promise<any[]>) | undefined;
  let lastContext: any[] | null = null;

  const emit = (event: any) => {
    for (const listener of listeners) listener(event);
  };

  const pushAssistant = (message: any) => {
    state.messages.push(message);
    emit({ type: "message_end", message });
  };

  const runBehavior = async (kind: "prompt" | "continue") => {
    calls.push({ kind, messagesAtStart: state.messages.slice() });
    if (holdNextAttempt) {
      holdNextAttempt = false;
      await new Promise<void>((resolve) => held.push(resolve));
    }
    // The real agent applies transformContext before every LLM call (transient
    // request-only additions); the fake records the returned context so tests
    // can assert what was injected.
    if (transformContext) lastContext = await transformContext(state.messages.slice());
    const behavior = behaviors[Math.min(next, behaviors.length - 1)];
    next++;
    switch (behavior.kind) {
      case "fail": {
        const partialText = behavior.partialText ?? "";
        if (partialText) {
          emit({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: partialText },
          });
        }
        pushAssistant({
          role: "assistant",
          content: partialText ? [{ type: "text", text: partialText }] : [],
          stopReason: "error",
          errorMessage: behavior.errorMessage,
        });
        break;
      }
      case "succeed":
        pushAssistant({
          role: "assistant",
          content: [{ type: "text", text: behavior.text ?? "ok" }],
          stopReason: "stop",
        });
        break;
      case "abort":
        pushAssistant({
          role: "assistant",
          content: [],
          stopReason: "aborted",
          errorMessage: "cancelled",
        });
        break;
      case "throw":
        throw behavior.error;
    }
  };

  return {
    state,
    calls,
    emit,
    holdNext: () => {
      holdNextAttempt = true;
    },
    releaseHeld: () => held.shift()?.(),
    get aborted() {
      return aborted;
    },
    get lastContext() {
      return lastContext;
    },
    setTransformContext: (fn?: (messages: any[]) => Promise<any[]>) => {
      transformContext = fn;
    },
    prompt: async (text: string) => {
      state.messages.push({ role: "user", content: text, timestamp: 1 });
      await runBehavior("prompt");
    },
    continue: () => runBehavior("continue"),
    subscribe: (listener: any) => {
      listeners.push(listener);
      return () => {};
    },
    abort: () => {
      aborted = true;
    },
  };
}

type FakeAgent = ReturnType<typeof makeFakeAgent>;

// --- Harness -----------------------------------------------------------------

const DEFAULT_RETRY: RetryPolicy = { enabled: true, maxRetries: 3, baseDelayMs: 10 };
const PROMPT_PACK: PromptPack = {
  framing: "",
  focusAnchor: "focus: answer the latest user message only",
  laneReminders: {
    base: "base reminder for {{tool}}",
    escalated: "escalated reminder for {{tool}} ({{count}} attempts)",
    failedNote: "[btw] that call failed; read-only tools only",
    preamble: "read-only lane preamble",
  },
};

interface HarnessOptions {
  retryPolicy?: RetryPolicy;
  isReadOnlyLane?: () => boolean;
  isReadOnlyTool?: (name: string) => boolean;
}

/** Wire the runner to a fake agent and collect the TurnPhase log. */
function makeHarness(fake: FakeAgent, options: HarnessOptions = {}) {
  const phases: TurnPhase[] = [];
  const runner = new ForkTurnRunner({
    agentOptions: {
      streamFn: (() => {
        throw new Error("fake agent never streams");
      }) as any,
    },
    retryPolicy: options.retryPolicy ?? DEFAULT_RETRY,
    promptPack: PROMPT_PACK,
    isReadOnlyLane: options.isReadOnlyLane ?? (() => false),
    isReadOnlyTool: options.isReadOnlyTool ?? (() => true),
    onPhase: (phase) => phases.push(phase),
    agentFactory: (agentOptions: AgentOptions) => {
      fake.setTransformContext(agentOptions.transformContext);
      return fake as unknown as Agent;
    },
  });
  return { runner, phases, fake };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const phaseKinds = (phases: TurnPhase[]) => phases.map((p) => p.kind);
const retryWaits = (phases: TurnPhase[]) =>
  phases.filter(
    (p): p is Extract<TurnPhase, { kind: "retry-wait" }> => p.kind === "retry-wait",
  );
const lanes = (phases: TurnPhase[]) =>
  phases.filter((p): p is Extract<TurnPhase, { kind: "lane" }> => p.kind === "lane");
const streams = (phases: TurnPhase[]) =>
  phases.filter((p): p is Extract<TurnPhase, { kind: "stream" }> => p.kind === "stream");

// --- Retry matrix -------------------------------------------------------------

describe("fork-turn: retry matrix (T1)", () => {
  test("a transient error retries via continue; retry-wait carries attempt/maxAttempts/delayMs", async () => {
    const fake = makeFakeAgent([
      { kind: "fail", errorMessage: "model overloaded" },
      { kind: "succeed", text: "recovered" },
    ]);
    const { runner, phases, fake: f } = makeHarness(fake);

    await runner.run("hello");

    expect(f.calls.map((c) => c.kind)).toEqual(["prompt", "continue"]);
    // The phase log: failed attempt's transcript, the wait, the success
    // transcript, the final transcript, then turn-end.
    expect(phaseKinds(phases)).toEqual([
      "messages",
      "retry-wait",
      "messages",
      "messages",
      "turn-end",
    ]);
    const waits = retryWaits(phases);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({
      attempt: 1,
      maxAttempts: 3,
      delayMs: 10, // baseDelayMs * 2^0
      errorMessage: "model overloaded",
    });
    // Final transcript: one user message (never re-submitted), success reply.
    expect(f.state.messages.filter((m: any) => m.role === "user")).toHaveLength(1);
    expect(f.state.messages[f.state.messages.length - 1].stopReason).toBe("stop");
  });

  test("the failed assistant message is stripped before the retry (never re-sent)", async () => {
    const fake = makeFakeAgent([
      { kind: "fail", errorMessage: "503 Service Unavailable" },
      { kind: "succeed" },
    ]);
    // Seed a prior successful turn: it must survive the cleanup.
    fake.state.messages.push(
      { role: "user", content: "earlier", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "earlier reply" }],
        stopReason: "stop",
      },
    );
    const { runner, fake: f } = makeHarness(fake);

    await runner.run("hi");

    expect(f.calls).toHaveLength(2);
    // continue() ran from a transcript that no longer carries the error…
    const atContinue = f.calls[1].messagesAtStart as any[];
    expect(atContinue.some((m) => m.errorMessage === "503 Service Unavailable")).toBe(false);
    // …but still holds the successful prior turn and both user messages.
    expect(atContinue.some((m) => m.role === "assistant" && m.stopReason === "stop")).toBe(true);
    expect(atContinue.filter((m) => m.role === "user")).toHaveLength(2);
  });

  test("budget exhausted: the final error stays in the transcript; waits show 1/2 then 2/2", async () => {
    const fake = makeFakeAgent([
      { kind: "fail", errorMessage: "still overloaded" },
      { kind: "fail", errorMessage: "still overloaded" },
      { kind: "fail", errorMessage: "still overloaded" },
    ]);
    const { runner, phases, fake: f } = makeHarness(fake, {
      retryPolicy: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
    });

    await runner.run("hi");

    expect(f.calls.map((c) => c.kind)).toEqual(["prompt", "continue", "continue"]);
    const waits = retryWaits(phases);
    expect(waits.map((w) => w.attempt)).toEqual([1, 2]);
    expect(waits.map((w) => w.maxAttempts)).toEqual([2, 2]);
    expect(waits.map((w) => w.delayMs)).toEqual([1, 2]); // 2^(n-1) backoff
    const last = f.state.messages[f.state.messages.length - 1];
    expect(last.stopReason).toBe("error");
    expect(last.errorMessage).toBe("still overloaded");
  });

  test("a mid-stream failure streams its partial text, then surfaces the error as the final result", async () => {
    const fake = makeFakeAgent([
      { kind: "fail", errorMessage: "connection lost", partialText: "partial reply" },
      { kind: "fail", errorMessage: "connection lost", partialText: "partial reply 2" },
    ]);
    const { runner, phases, fake: f } = makeHarness(fake, {
      retryPolicy: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
    });

    await runner.run("hi");

    expect(streams(phases).map((p) => p.delta)).toEqual([
      "partial reply",
      "partial reply 2",
    ]);
    expect(phaseKinds(phases)).toEqual([
      "stream",
      "messages",
      "retry-wait",
      "stream",
      "messages",
      "messages",
      "turn-end",
    ]);
    const last = f.state.messages[f.state.messages.length - 1];
    expect(last.stopReason).toBe("error");
    expect(last.errorMessage).toBe("connection lost");
  });

  test("context overflow never retries", async () => {
    const fake = makeFakeAgent([
      {
        kind: "fail",
        errorMessage: "This model's maximum context length is 128000 tokens",
      },
    ]);
    const { runner, phases, fake: f } = makeHarness(fake);

    await runner.run("hi");

    expect(f.calls.map((c) => c.kind)).toEqual(["prompt"]);
    expect(retryWaits(phases)).toEqual([]);
    const last = f.state.messages[f.state.messages.length - 1];
    expect(last.stopReason).toBe("error");
    expect(last.errorMessage).toContain("maximum context length");
  });

  test("an aborted turn never retries", async () => {
    const fake = makeFakeAgent([{ kind: "abort" }]);
    const { runner, phases, fake: f } = makeHarness(fake);

    await runner.run("hi");

    expect(f.calls.map((c) => c.kind)).toEqual(["prompt"]);
    expect(retryWaits(phases)).toEqual([]);
    expect(f.state.messages[f.state.messages.length - 1].stopReason).toBe("aborted");
  });

  test("a thrown attempt (real abort) propagates out of run() without retrying", async () => {
    const fake = makeFakeAgent([{ kind: "throw", error: new Error("Aborted") }]);
    const { runner, phases, fake: f } = makeHarness(fake);

    await expect(runner.run("hi")).rejects.toThrow("Aborted");

    expect(f.calls.map((c) => c.kind)).toEqual(["prompt"]);
    expect(retryWaits(phases)).toEqual([]);
    // No message_end arrived; the finally block still closes the turn.
    expect(phaseKinds(phases)).toEqual(["messages", "turn-end"]);
    expect(runner.isRunning).toBe(false);
  });

  test("enabled=false: single attempt, zero backoff (no retry-wait phases)", async () => {
    const fake = makeFakeAgent([{ kind: "fail", errorMessage: "overloaded" }]);
    const { runner, phases, fake: f } = makeHarness(fake, {
      retryPolicy: { enabled: false, maxRetries: 3, baseDelayMs: 100_000 },
    });

    const started = Date.now();
    await runner.run("hi");
    expect(Date.now() - started).toBeLessThan(1000);

    expect(f.calls.map((c) => c.kind)).toEqual(["prompt"]);
    expect(retryWaits(phases)).toEqual([]);
    expect(f.state.messages[f.state.messages.length - 1].errorMessage).toBe("overloaded");
  });

  test("cancel() during the backoff wait cancels it and surfaces the last error immediately", async () => {
    const fake = makeFakeAgent([
      { kind: "fail", errorMessage: "rate limit reached" },
      { kind: "succeed" },
    ]);
    const { runner, phases, fake: f } = makeHarness(fake, {
      retryPolicy: { enabled: true, maxRetries: 3, baseDelayMs: 600 },
    });

    const run = runner.run("hi"); // resolves only after the turn settles
    await tick();
    await tick(); // attempt 1 failed; the 600ms wait is now pending
    expect(runner.isRunning).toBe(true); // true during the backoff wait
    const started = Date.now();
    runner.cancel(); // Esc cancels the backoff
    await run;

    expect(Date.now() - started).toBeLessThan(500); // no hang on the 600ms wait
    expect(f.calls.map((c) => c.kind)).toEqual(["prompt"]);
    expect(retryWaits(phases).map((w) => w.attempt)).toEqual([1]);
    const last = f.state.messages[f.state.messages.length - 1];
    expect(last.stopReason).toBe("error");
    expect(last.errorMessage).toBe("rate limit reached");
    expect(runner.isRunning).toBe(false);
  });

  test("features.retry=false arrives as an already-ANDed disabled policy (D11): zero backoff", async () => {
    // D11: the overlay ANDs features.retry with settings.retry.enabled before
    // constructing the runner — the disabled feature lands here as enabled:false.
    const fake = makeFakeAgent([{ kind: "fail", errorMessage: "overloaded" }]);
    const { runner, phases, fake: f } = makeHarness(fake, {
      retryPolicy: { enabled: false, maxRetries: 3, baseDelayMs: 100_000 },
    });

    const started = Date.now();
    await runner.run("hi");
    expect(Date.now() - started).toBeLessThan(1000);

    expect(f.calls.map((c) => c.kind)).toEqual(["prompt"]);
    expect(retryWaits(phases)).toEqual([]);
  });
});

// --- Lane enforcement ---------------------------------------------------------

describe("fork-turn: lane enforcement (T1)", () => {
  test("violations: base reminder on the first, escalated + abort-after-inject on the second", async () => {
    const fake = makeFakeAgent([{ kind: "succeed", text: "ok" }]);
    fake.holdNext();
    const { runner, phases, fake: f } = makeHarness(fake, {
      isReadOnlyLane: () => true,
      isReadOnlyTool: () => false,
    });

    const run = runner.run("hi");
    await tick(); // attempt 1 in flight (held)
    f.emit({ type: "tool_execution_end", toolName: "bash", isError: true });
    f.emit({ type: "tool_execution_end", toolName: "bash", isError: true });
    f.releaseHeld();
    await run;
    await tick(); // let the scheduled abort-after-inject land

    expect(lanes(phases).map((l) => l.count)).toEqual([1, 2]);
    expect(lanes(phases).map((l) => l.escalated)).toEqual([false, true]);
    expect(lanes(phases).map((l) => l.tool)).toEqual(["bash", "bash"]);
    // The escalated reminder was injected into the next context, and the
    // turn was aborted right after the injection (abort-after-inject).
    const injected = (f.lastContext ?? []).filter((m: any) => m.role === "user");
    expect(
      injected.some((m: any) =>
        m.content.includes("escalated reminder for bash (2 attempts)"),
      ),
    ).toBe(true);
    expect(f.aborted).toBe(true);
  });

  test("per-turn lane state resets at the top of run()", async () => {
    const fake = makeFakeAgent([{ kind: "succeed" }, { kind: "succeed" }]);
    fake.holdNext();
    const { runner, phases, fake: f } = makeHarness(fake, {
      isReadOnlyLane: () => true,
      isReadOnlyTool: () => false,
    });

    const first = runner.run("first");
    await tick();
    f.emit({ type: "tool_execution_end", toolName: "bash", isError: true });
    f.emit({ type: "tool_execution_end", toolName: "bash", isError: true });
    f.releaseHeld();
    await first;

    fake.holdNext();
    const second = runner.run("second");
    await tick();
    f.emit({ type: "tool_execution_end", toolName: "bash", isError: true });
    f.releaseHeld();
    await second;

    expect(lanes(phases).map((l) => l.count)).toEqual([1, 2, 1]);
    expect(lanes(phases).map((l) => l.escalated)).toEqual([false, true, false]);
  });

  test("a read-only tool error is not a lane violation", async () => {
    const fake = makeFakeAgent([{ kind: "succeed" }]);
    const { runner, phases, fake: f } = makeHarness(fake, {
      isReadOnlyLane: () => true,
      isReadOnlyTool: (name) => name === "read",
    });

    await runner.run("hi");
    f.emit({ type: "tool_execution_end", toolName: "read", isError: true });

    expect(lanes(phases)).toEqual([]);
  });
});

// --- Run lifecycle ------------------------------------------------------------

describe("fork-turn: run lifecycle (T1)", () => {
  test("isRunning is true while an attempt is in flight, false once the turn settles", async () => {
    const fake = makeFakeAgent([{ kind: "succeed" }]);
    fake.holdNext();
    const { runner, fake: f } = makeHarness(fake);

    const run = runner.run("hi");
    await tick();
    expect(runner.isRunning).toBe(true);
    f.releaseHeld();
    await run;
    expect(runner.isRunning).toBe(false);
  });

  test("cancel() also aborts an in-flight agent run", async () => {
    const fake = makeFakeAgent([{ kind: "succeed" }]);
    fake.holdNext();
    const { runner, fake: f } = makeHarness(fake);

    const run = runner.run("hi");
    await tick();
    runner.cancel();
    expect(f.aborted).toBe(true);
    f.releaseHeld();
    await run;
  });

  test("a run() while a turn is in flight is ignored (submit guard mirror)", async () => {
    const fake = makeFakeAgent([{ kind: "succeed" }]);
    fake.holdNext();
    const { runner, fake: f } = makeHarness(fake);

    const first = runner.run("first");
    await tick();
    await runner.run("second"); // ignored: no second prompt
    expect(f.calls.map((c) => c.kind)).toEqual(["prompt"]);
    f.releaseHeld();
    await first;
    expect(f.calls.map((c) => c.kind)).toEqual(["prompt"]);
  });

  test("blank text is ignored", async () => {
    const fake = makeFakeAgent([{ kind: "succeed" }]);
    const { runner, fake: f } = makeHarness(fake);

    await runner.run("   ");

    expect(f.calls).toEqual([]);
  });
});
