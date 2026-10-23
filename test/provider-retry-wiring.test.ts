import { describe, expect, test } from "bun:test";
import type { ForkTurnRunnerOptions } from "../srcs/fork-turn.ts";
import { makeOverlay as sharedMakeOverlay } from "./helpers/make-overlay.ts";

const { SideChatOverlay } = await import("../srcs/side-chat-overlay.ts");

const makeOverlay = (overrides: Record<string, unknown> = {}) =>
  sharedMakeOverlay(SideChatOverlay, [], overrides);

function captureRunnerOptions(overrides: Record<string, unknown> = {}): () =>
  | ForkTurnRunnerOptions
  | undefined {
  let runnerOptions: ForkTurnRunnerOptions | undefined;
  makeOverlay({
    ...overrides,
    runnerFactory: (options: ForkTurnRunnerOptions) => {
      runnerOptions = options;
      return {
        agent: { state: { messages: [] } },
        isRunning: false,
        run: async () => {},
        cancel: () => {},
      } as any;
    },
  });
  return () => runnerOptions;
}

function capturingRegistry() {
  const calls: unknown[] = [];
  const registry = {
    streamSimple(...args: unknown[]) {
      calls.push(args[2]);
      return {} as any;
    },
  };
  return { registry, calls };
}

async function invokeStreamFn(
  getOpts: () => ForkTurnRunnerOptions | undefined,
  callerOptions: Record<string, unknown>,
): Promise<unknown> {
  const streamFn = getOpts()?.agentOptions.streamFn as
    | ((model: unknown, context: unknown, options?: Record<string, unknown>) => Promise<unknown>)
    | undefined;
  await streamFn?.({}, {}, callerOptions as any);
  return undefined;
}

describe("provider retry assembly (settings.retry.provider)", () => {
  test("provider block configured: streamFn routes through the registry streamSimple with injected keys", async () => {
    const { registry, calls } = capturingRegistry();
    const getOpts = captureRunnerOptions({
      modelRegistry: registry,
      retryPolicy: {
        enabled: true,
        maxRetries: 3,
        baseDelayMs: 2000,
        provider: { timeoutMs: 10000, maxRetries: 15, maxRetryDelayMs: 60000 },
      },
    });
    const callerOptions = { signal: new AbortController().signal };
    await invokeStreamFn(getOpts, callerOptions);
    expect(calls).toHaveLength(1);
    const received = calls[0] as Record<string, unknown>;
    expect(received.timeoutMs).toBe(10000);
    expect(received.maxRetries).toBe(15);
    expect(received.maxRetryDelayMs).toBe(60000);
    expect(received.signal).toBe(callerOptions.signal);
  });

  test("no provider block: options flow to the registry untouched (identity)", async () => {
    const { registry, calls } = capturingRegistry();
    const getOpts = captureRunnerOptions({
      modelRegistry: registry,
      retryPolicy: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
    });
    const callerOptions = { signal: new AbortController().signal };
    await invokeStreamFn(getOpts, callerOptions);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(callerOptions);
  });

  test("empty provider block: unchanged identity pass-through", async () => {
    const { registry, calls } = capturingRegistry();
    const getOpts = captureRunnerOptions({
      modelRegistry: registry,
      retryPolicy: {
        enabled: true,
        maxRetries: 3,
        baseDelayMs: 2000,
        provider: {},
      },
    });
    const callerOptions = {};
    await invokeStreamFn(getOpts, callerOptions);
    expect(calls[0]).toBe(callerOptions);
  });

  test("agentOptions carries no getApiKey (registry resolves auth at request time)", () => {
    const getOpts = captureRunnerOptions({});
    expect(getOpts()?.agentOptions.getApiKey).toBeUndefined();
  });
});
