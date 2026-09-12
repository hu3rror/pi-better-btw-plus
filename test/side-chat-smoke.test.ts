/**
 * Side chat overlay smoke suite (issue #11, T2): the overlay runs every turn
 * through ForkTurnRunner (fork-turn.ts) and renders its TurnPhase events.
 * These three cases drive the REAL overlay + a real ForkTurnRunner with a
 * scripted fake agent injected through the runnerFactory test seam (agentFactory
 * → fake), and assert ONLY the rendered frame — zero private-field pokes, no
 * direct turn-loop access. The old poke-based retry wiring suite (retry-wiring.
 * test.ts) is superseded by this thin public-surface suite; the full retry
 * matrix lives in fork-turn.test.ts (T1), which drives the runner directly.
 */
import { describe, expect, test } from "bun:test";
import type { Agent } from "@earendil-works/pi-agent-core";
import {
  ForkTurnRunner,
  type ForkTurnRunnerOptions,
} from "../srcs/fork-turn.ts";
import {
  makeOverlay as sharedMakeOverlay,
  OVERLAY_TEST_WIDTH,
} from "./helpers/make-overlay.ts";

const { SideChatOverlay } = await import("../srcs/side-chat-overlay.ts");

// --- Scripted fake agent ----------------------------------------------------

type AgentBehavior =
  | { kind: "fail"; errorMessage: string; partialText?: string; noMessageEnd?: boolean }
  | { kind: "succeed"; text?: string };

/**
 * Agent-shaped scripted fake. `emit()` fires synthetic agent events through
 * the runner's subscription (lane-detection paths); `holdNext`/`releaseHeld`
 * stall one attempt so tests can observe mid-turn state.
 */
function makeFakeAgent(behaviors: AgentBehavior[]) {
  const listeners: Array<(event: any) => void> = [];
  const state: any = {
    messages: [],
    model: { id: "test-model", contextWindow: 128000 },
  };
  const calls: Array<{ kind: "prompt" | "continue" }> = [];
  const held: Array<() => void> = [];
  let next = 0;
  let holdNextAttempt = false;
  let aborted = false;

  const emit = (event: any) => {
    for (const listener of listeners) listener(event);
  };

  const runBehavior = async (kind: "prompt" | "continue") => {
    calls.push({ kind });
    if (holdNextAttempt) {
      holdNextAttempt = false;
      await new Promise<void>((resolve) => held.push(resolve));
    }
    const behavior = behaviors[Math.min(next, behaviors.length - 1)];
    next++;
    if (behavior.kind === "fail") {
      const partialText = behavior.partialText ?? "";
      if (partialText) {
        emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: partialText },
        });
      }
      state.messages.push({
        role: "assistant",
        content: partialText ? [{ type: "text", text: partialText }] : [],
        stopReason: "error",
        errorMessage: behavior.errorMessage,
      });
      if (!behavior.noMessageEnd) emit({ type: "message_end" });
    } else {
      state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: behavior.text ?? "ok" }],
        stopReason: "stop",
      });
      emit({ type: "message_end" });
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

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Frame text of the overlay's current render (the mock theme emits no ANSI). */
function frameText(overlay: { render(width: number): string[] }): string {
  return overlay.render(OVERLAY_TEST_WIDTH).join("\n");
}

/**
 * Overlay + real ForkTurnRunner wired to a scripted fake agent: the overlay
 * assembles the runner's deps as in production, and `agentFactory` returns
 * the fake. Submitting goes through the editor (public input); the lane smoke
 * is driven via `fake.emit()`; assertions read `overlay.render()`.
 */
function makeSmokeHarness(
  behaviors: AgentBehavior[],
  overrides: Record<string, unknown> = {},
): { overlay: ReturnType<typeof sharedMakeOverlay>; fake: FakeAgent } {
  const fake = makeFakeAgent(behaviors);
  const overlay = sharedMakeOverlay(SideChatOverlay, [], {
    ...overrides,
    runnerFactory: (runnerOptions: ForkTurnRunnerOptions) =>
      new ForkTurnRunner({
        ...runnerOptions,
        agentFactory: () => fake as unknown as Agent,
      }),
  });
  return { overlay, fake };
}

// --- Smoke cases --------------------------------------------------------------

describe("side-chat-overlay smoke (#11, T2)", () => {
  test("submit renders the agent reply in the frame", async () => {
    const { overlay } = makeSmokeHarness([
      { kind: "succeed", text: "hello there" },
    ]);

    overlay.handleInput("hello");
    overlay.handleInput("\r"); // Enter submits via the editor
    await tick();
    await tick();

    const frame = frameText(overlay);
    expect(frame).toContain("[You]: hello");
    expect(frame).toContain("[Assistant]: hello there");
  });

  test("Esc during the backoff wait cancels it and the final error renders", async () => {
    const { overlay, fake } = makeSmokeHarness(
      [
        { kind: "fail", errorMessage: "rate limit reached" },
        { kind: "succeed", text: "must not run" },
      ],
      { retryPolicy: { enabled: true, maxRetries: 3, baseDelayMs: 600 } },
    );

    overlay.handleInput("hi");
    overlay.handleInput("\r");
    await tick();

    // The retry countdown ticker is live while the backoff wait is pending.
    expect(frameText(overlay)).toContain("Retrying (1/3)");

    overlay.handleInput("\x1b"); // Esc cancels the wait
    await tick();

    const frame = frameText(overlay);
    expect(frame).toContain("[Error]: rate limit reached");
    expect(fake.aborted).toBe(true);
    expect(fake.calls.map((c) => c.kind)).toEqual(["prompt"]);
  });

  test("a mid-turn lane violation renders the blocked status", async () => {
    const { overlay, fake } = makeSmokeHarness([{ kind: "succeed" }]);
    fake.holdNext(); // attempt 1 stays in flight so the turn cannot settle

    overlay.handleInput("hi");
    overlay.handleInput("\r");
    await tick(); // attempt 1 in flight (held)

    // Detection signal: an error result for a tool not in the read-only lane
    // (absent tools produce "Tool X not found" errors).
    fake.emit({ type: "tool_execution_end", toolName: "bash", isError: true });
    fake.emit({ type: "tool_execution_end", toolName: "bash", isError: true });

    const frame = frameText(overlay);
    expect(frame).toContain("🚧 lane blocked");
    expect(frame).toContain("🚧 lane blocked — escalating");

    fake.releaseHeld();
    await tick();
  });

  test("a retry wait drops the failed attempt's partial text when no message_end arrives", async () => {
    // Transport-level failures may cut the stream without a message_end; the
    // retry wait must not keep rendering the stale partial text (mirrors the
    // attempt-boundary cleanup the pre-runner wiring did).
    const { overlay } = makeSmokeHarness(
      [
        { kind: "fail", errorMessage: "connection lost", partialText: "partial reply", noMessageEnd: true },
        { kind: "succeed", text: "recovered" },
      ],
      { retryPolicy: { enabled: true, maxRetries: 3, baseDelayMs: 600 } },
    );

    overlay.handleInput("hi");
    overlay.handleInput("\r");
    await tick();

    // Retry wait is live: the countdown shows, and the stale partial text must not.
    const waiting = frameText(overlay);
    expect(waiting).toContain("Retrying (1/3)");
    expect(waiting).not.toContain("[Assistant]: partial reply");
  });
});
