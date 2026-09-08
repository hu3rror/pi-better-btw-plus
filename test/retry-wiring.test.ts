/**
 * Retry wiring (issue #8, D9/D10): the fork's turn loop wraps agent.prompt in
 * runWithRetry — transient provider errors auto-retry with exponential backoff,
 * the status area shows the attempt countdown, Esc cancels the backoff wait and
 * surfaces the last error as the final result, context overflow / aborts never
 * retry, and the failed assistant message is stripped before the retry (pi's
 * _prepareRetry semantics) so it never re-enters the next request.
 *
 * The overlay is driven with a scripted fake agent (prompt → continue) and real
 * (small) backoff timers; the countdown/status is captured by spying on the
 * messages widget's setToolStatus.
 */
import { describe, expect, test } from "bun:test";
import type { RetryPolicy } from "../srcs/retry.ts";
import type { SideChatOverlay as SideChatOverlayType } from "../srcs/side-chat-overlay.ts";
import {
  makeOverlay as sharedMakeOverlay,
  OVERLAY_TEST_WIDTH,
} from "./helpers/make-overlay.ts";

const { SideChatOverlay } = await import("../srcs/side-chat-overlay.ts");
const makeOverlay = (retryPolicy: RetryPolicy) =>
  sharedMakeOverlay(SideChatOverlay, undefined, { retryPolicy });

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

function makeFakeAgent(behaviors: AgentBehavior[]) {
  const state: any = {
    messages: [],
    model: { id: "test-model", contextWindow: 128000 },
  };
  const calls: AgentCall[] = [];
  let next = 0;
  const runBehavior = async (kind: "prompt" | "continue") => {
    calls.push({ kind, messagesAtStart: state.messages.slice() });
    const behavior = behaviors[Math.min(next, behaviors.length - 1)];
    next++;
    switch (behavior.kind) {
      case "fail":
        state.messages.push({
          role: "assistant",
          content: behavior.partialText
            ? [{ type: "text", text: behavior.partialText }]
            : [],
          stopReason: "error",
          errorMessage: behavior.errorMessage,
        });
        break;
      case "succeed":
        state.messages.push({
          role: "assistant",
          content: [{ type: "text", text: behavior.text ?? "ok" }],
          stopReason: "stop",
        });
        break;
      case "abort":
        state.messages.push({
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
    prompt: (text: string) => {
      state.messages.push({ role: "user", content: text, timestamp: 1 });
      return runBehavior("prompt");
    },
    continue: () => runBehavior("continue"),
    subscribe: () => {},
    abort: () => {},
  };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Spy on the messages widget's tool-status line (retry countdown + spinner). */
function captureStatus(overlay: SideChatOverlayType): string[] {
  const msgs: any = (overlay as any).messages;
  const statuses: string[] = [];
  const orig = msgs.setToolStatus.bind(msgs);
  msgs.setToolStatus = (s: string) => {
    statuses.push(s);
    orig(s);
  };
  return statuses;
}


function submitText(overlay: SideChatOverlayType, text: string): Promise<void> {
  // Drive the turn loop directly: editor onSubmit is fire-and-forget, but the
  // wiring tests must await the full retry cycle (backoff waits included).
  return (overlay as any).handleSubmit(text) as Promise<void>;
}

describe("side-chat-overlay.ts retry wiring (#8)", () => {
  test("transient error auto-retries via continue; status shows attempt countdown", async () => {
    const overlay = makeOverlay({ enabled: true, maxRetries: 3, baseDelayMs: 10 });
    const fake = makeFakeAgent([
      { kind: "fail", errorMessage: "model overloaded" },
      { kind: "succeed", text: "recovered" },
    ]);
    (overlay as any).agent = fake;
    const statuses = captureStatus(overlay);

    await submitText(overlay, "hello");

    expect(fake.calls.map((c) => c.kind)).toEqual(["prompt", "continue"]);
    expect(statuses.some((s) => s.includes("Retrying (1/3)"))).toBe(true);
    // Final transcript: one user message (never re-submitted), success reply.
    expect(fake.state.messages.filter((m: any) => m.role === "user")).toHaveLength(1);
    expect(
      fake.state.messages[fake.state.messages.length - 1].stopReason,
    ).toBe("stop");
  });

  test("failed assistant message is stripped before the retry (never re-sent)", async () => {
    const overlay = makeOverlay({ enabled: true, maxRetries: 3, baseDelayMs: 1 });
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
    (overlay as any).agent = fake;

    await submitText(overlay, "hi");

    expect(fake.calls).toHaveLength(2);
    // continue() ran from a transcript that no longer carries the error…
    const atContinue = fake.calls[1].messagesAtStart as any[];
    expect(atContinue.some((m) => m.errorMessage === "503 Service Unavailable")).toBe(false);
    // …but still holds the successful prior turn and both user messages.
    expect(atContinue.some((m) => m.role === "assistant" && m.stopReason === "stop")).toBe(true);
    expect(atContinue.filter((m) => m.role === "user")).toHaveLength(2);
  });

  test("budget exhausted: the final error stays in the transcript and renders", async () => {
    const overlay = makeOverlay({ enabled: true, maxRetries: 2, baseDelayMs: 1 });
    const fake = makeFakeAgent([
      { kind: "fail", errorMessage: "still overloaded" },
      { kind: "fail", errorMessage: "still overloaded" },
      { kind: "fail", errorMessage: "still overloaded" },
    ]);
    (overlay as any).agent = fake;
    const statuses = captureStatus(overlay);

    await submitText(overlay, "hi");

    expect(fake.calls.map((c) => c.kind)).toEqual(["prompt", "continue", "continue"]);
    expect(statuses.some((s) => s.includes("Retrying (1/2)"))).toBe(true);
    expect(statuses.some((s) => s.includes("Retrying (2/2)"))).toBe(true);
    const last = fake.state.messages[fake.state.messages.length - 1];
    expect(last.stopReason).toBe("error");
    expect(last.errorMessage).toBe("still overloaded");
    expect((overlay as any).isStreaming).toBe(false);
    const lines = overlay.render(OVERLAY_TEST_WIDTH).join("\n");
    expect(lines).toContain("[Error]: still overloaded");
  });

  test("a mid-stream failure with partial text still surfaces the error as the final result", async () => {
    const overlay = makeOverlay({ enabled: true, maxRetries: 1, baseDelayMs: 1 });
    const fake = makeFakeAgent([
      { kind: "fail", errorMessage: "connection lost", partialText: "partial reply" },
      { kind: "fail", errorMessage: "connection lost", partialText: "partial reply 2" },
    ]);
    (overlay as any).agent = fake;

    await submitText(overlay, "hi");

    const lines = overlay.render(OVERLAY_TEST_WIDTH).join("\n");
    expect(lines).toContain("[Error]: connection lost");
    expect(lines).not.toContain("[Assistant]: partial reply");
  });

  test("context overflow never retries", async () => {
    const overlay = makeOverlay({ enabled: true, maxRetries: 3, baseDelayMs: 1 });
    const fake = makeFakeAgent([
      { kind: "fail", errorMessage: "This model's maximum context length is 128000 tokens" },
    ]);
    (overlay as any).agent = fake;

    await submitText(overlay, "hi");

    expect(fake.calls.map((c) => c.kind)).toEqual(["prompt"]);
    const lines = overlay.render(OVERLAY_TEST_WIDTH).join("\n");
    expect(lines).toContain("[Error]: This model's maximum context length");
  });

  test("an aborted turn never retries", async () => {
    const overlay = makeOverlay({ enabled: true, maxRetries: 3, baseDelayMs: 1 });
    const fake = makeFakeAgent([{ kind: "abort" }]);
    (overlay as any).agent = fake;

    await submitText(overlay, "hi");

    expect(fake.calls.map((c) => c.kind)).toEqual(["prompt"]);
  });

  test("a thrown attempt (real abort) propagates without retrying", async () => {
    const overlay = makeOverlay({ enabled: true, maxRetries: 3, baseDelayMs: 1 });
    const fake = makeFakeAgent([{ kind: "throw", error: new Error("Aborted") }]);
    (overlay as any).agent = fake;
    const statuses = captureStatus(overlay);

    await submitText(overlay, "hi");

    expect(fake.calls.map((c) => c.kind)).toEqual(["prompt"]);
    expect(statuses.some((s) => s.includes("Retrying"))).toBe(false);
    expect((overlay as any).isStreaming).toBe(false);
  });

  test("enabled=false: single attempt, zero backoff (no delay, no countdown)", async () => {
    const overlay = makeOverlay({
      enabled: false,
      maxRetries: 3,
      baseDelayMs: 100_000, // an accidental wait would hang the test
    });
    const fake = makeFakeAgent([{ kind: "fail", errorMessage: "overloaded" }]);
    (overlay as any).agent = fake;
    const statuses = captureStatus(overlay);

    const started = Date.now();
    await submitText(overlay, "hi");
    expect(Date.now() - started).toBeLessThan(1000);

    expect(fake.calls.map((c) => c.kind)).toEqual(["prompt"]);
    expect(statuses.some((s) => s.includes("Retrying"))).toBe(false);
    const lines = overlay.render(OVERLAY_TEST_WIDTH).join("\n");
    expect(lines).toContain("[Error]: overloaded");
  });

  test("Esc during the backoff wait cancels it and shows the last error immediately", async () => {
    const overlay = makeOverlay({ enabled: true, maxRetries: 3, baseDelayMs: 600 });
    const fake = makeFakeAgent([
      { kind: "fail", errorMessage: "rate limit reached" },
      { kind: "succeed" },
    ]);
    (overlay as any).agent = fake;

    const submit = submitText(overlay, "hi"); // resolves only after the turn settles
    await tick();
    await tick(); // let attempt 1 fail and the wait start
    const started = Date.now();
    overlay.handleInput("\x1b"); // Esc cancels the backoff
    await submit;

    expect(Date.now() - started).toBeLessThan(500); // no hang on the 600ms wait
    expect(fake.calls.map((c) => c.kind)).toEqual(["prompt"]);
    const last = fake.state.messages[fake.state.messages.length - 1];
    expect(last.stopReason).toBe("error");
    expect(last.errorMessage).toBe("rate limit reached");
    expect((overlay as any).isStreaming).toBe(false);
    const lines = overlay.render(OVERLAY_TEST_WIDTH).join("\n");
    expect(lines).toContain("[Error]: rate limit reached");
  });

});
