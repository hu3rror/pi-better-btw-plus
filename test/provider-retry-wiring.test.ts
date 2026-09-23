/**
 * Provider retry assembly seam (spec #20, issue #21; rewired in #33 to the
 * registry-auth stream function): the overlay wraps the fork agent's stream
 * function (the model registry's `streamSimple`, bound) with the
 * `settings.retry.provider` injection when a provider block is configured,
 * and passes it through unchanged (identity) when it is not — so unconfigured
 * behavior is byte-identical to the bare `modelRegistry.streamSimple`
 * wiring, and auth resolves inside the registry at request time (no
 * hand-wired `getApiKey`).
 *
 * Seam: the `runnerFactory` test hook captures the assembled
 * `ForkTurnRunnerOptions`; a fake registry records what its `streamSimple`
 * receives. With no provider block the exact options object flows through
 * untouched (reference identity — `injectProviderRetry` returns its input);
 * with a block the options are replaced and the injected keys reach the
 * registry.
 */
import { describe, expect, test } from "bun:test";
import type { ForkTurnRunnerOptions } from "../srcs/fork-turn.ts";
import { makeOverlay as sharedMakeOverlay } from "./helpers/make-overlay.ts";

const { SideChatOverlay } = await import("../srcs/side-chat-overlay.ts");

const makeOverlay = (overrides: Record<string, unknown> = {}) =>
  sharedMakeOverlay(SideChatOverlay, [], overrides);

/**
 * Build the overlay with a fake runner via the factory seam, returning a
 * getter for the assembled options.
 */
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

/** Fake registry: records every streamSimple call's third argument (options). */
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

/** Invoke the assembled streamFn and return what the registry received. */
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
    // Caller options still spread through (spec #20 D2: explicit options win).
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
    // Reference identity: injectProviderRetry returns its input unchanged, so
    // the very object the agent loop passed reaches the registry.
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
