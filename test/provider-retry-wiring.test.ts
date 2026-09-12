/**
 * Provider retry assembly seam (spec #20, issue #21): the overlay wraps the
 * fork agent's stream function with the `settings.retry.provider` injection
 * when a provider block is configured, and passes the bare `streamSimple`
 * through (identity) when it is not — so unconfigured behavior is
 * byte-identical with today's wiring.
 *
 * Seam: the `runnerFactory` test hook captures the assembled
 * `ForkTurnRunnerOptions`; we assert on `agentOptions.streamFn` identity.
 * The wrapped-assertion is RED on the pre-change code (which always assigned
 * the bare `streamSimple`).
 */
import { describe, expect, test } from "bun:test";
import type { ForkTurnRunnerOptions } from "../srcs/fork-turn.ts";
import { makeOverlay as sharedMakeOverlay } from "./helpers/make-overlay.ts";

const { SideChatOverlay } = await import("../srcs/side-chat-overlay.ts");
// Same module record the overlay imports from → identity comparisons work.
const { streamSimple } = await import("@earendil-works/pi-ai/compat");

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

describe("provider retry assembly (settings.retry.provider)", () => {
  test("provider block configured: streamFn is wrapped (not the bare streamSimple)", () => {
    const getOpts = captureRunnerOptions({
      retryPolicy: {
        enabled: true,
        maxRetries: 3,
        baseDelayMs: 2000,
        provider: { timeoutMs: 10000, maxRetries: 15, maxRetryDelayMs: 60000 },
      },
    });
    expect(getOpts()?.agentOptions.streamFn).not.toBe(streamSimple);
  });

  test("no provider block: streamFn is the bare streamSimple (identity)", () => {
    const getOpts = captureRunnerOptions({
      retryPolicy: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
    });
    expect(getOpts()?.agentOptions.streamFn).toBe(streamSimple);
  });

  test("empty provider block: streamFn stays the bare streamSimple (identity)", () => {
    const getOpts = captureRunnerOptions({
      retryPolicy: {
        enabled: true,
        maxRetries: 3,
        baseDelayMs: 2000,
        provider: {},
      },
    });
    expect(getOpts()?.agentOptions.streamFn).toBe(streamSimple);
  });
});
