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


type AgentBehavior =
  | { kind: "fail"; errorMessage: string; partialText?: string; noMessageEnd?: boolean }
  | { kind: "succeed"; text?: string };

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
    overlay.handleInput("\r");
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

    expect(frameText(overlay)).toContain("Retrying (1/3)");

    overlay.handleInput("\x1b");
    await tick();

    const frame = frameText(overlay);
    expect(frame).toContain("[Error]: rate limit reached");
    expect(fake.aborted).toBe(true);
    expect(fake.calls.map((c) => c.kind)).toEqual(["prompt"]);
  });

  test("the compact bar swaps to Esc stop while a turn is running", async () => {
    const { overlay, fake } = makeSmokeHarness([{ kind: "succeed" }]);
    fake.holdNext();

    overlay.handleInput("hi");
    overlay.handleInput("\r");
    await tick();

    expect(frameText(overlay)).toContain("Esc stop");

    fake.releaseHeld();
    await tick();
  });

  test("a mid-turn lane violation renders the blocked status", async () => {
    const { overlay, fake } = makeSmokeHarness([{ kind: "succeed" }]);
    fake.holdNext();

    overlay.handleInput("hi");
    overlay.handleInput("\r");
    await tick();

    fake.emit({ type: "tool_execution_end", toolName: "bash", isError: true });
    fake.emit({ type: "tool_execution_end", toolName: "bash", isError: true });

    const frame = frameText(overlay);
    expect(frame).toContain("🚧 lane blocked");
    expect(frame).toContain("🚧 lane blocked — escalating");

    fake.releaseHeld();
    await tick();
  });

  test("a retry wait drops the failed attempt's partial text when no message_end arrives", async () => {
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

    const waiting = frameText(overlay);
    expect(waiting).toContain("Retrying (1/3)");
    expect(waiting).not.toContain("[Assistant]: partial reply");
  });
});
