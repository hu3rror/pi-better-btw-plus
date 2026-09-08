/**
 * Turn-level retry engine (issue #6): pure classifier + injectable retry
 * loop unit tests. The engine is decoupled from the overlay/TUI — a fake
 * agent (scripted attempt results) and a fake clock (recorded delays) drive
 * every scenario; the abort signal stands in for Esc cancellation.
 */
import { describe, expect, test } from "bun:test";
import {
  classifyRetryable,
  runWithRetry,
  sleep,
  type RetryAttemptInfo,
  type RetryPolicy,
} from "../srcs/retry.ts";

// --- Fixtures ---------------------------------------------------------------

const err = (errorMessage: string) => ({ stopReason: "error", errorMessage });
const ok = () => ({ stopReason: "stop", content: [] });
const aborted = (errorMessage = "cancelled") => ({
  stopReason: "aborted",
  errorMessage,
});

/** Resolve-immediately fake clock that records every requested delay. */
function fakeDelay(record: number[]): (ms: number) => Promise<void> {
  return async (ms) => {
    record.push(ms);
  };
}

interface RunOutcome {
  attempts: unknown[];
  delays: number[];
  notices: RetryAttemptInfo[];
  result: unknown;
}

/**
 * Drive runWithRetry with a scripted fake agent. `results` are served in
 * order; the last one repeats once the list is exhausted (so a single
 * always-fail entry keeps failing).
 */
async function run(
  results: unknown[],
  options: {
    policy?: Partial<RetryPolicy>;
    delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
    signal?: AbortSignal;
    classify?: (result: unknown) => boolean;
  } = {},
): Promise<RunOutcome> {
  const attempts: unknown[] = [];
  const delays: number[] = [];
  const notices: RetryAttemptInfo[] = [];
  const result = await runWithRetry({
    attempt: async () => {
      const value =
        attempts.length < results.length
          ? results[attempts.length]
          : results[results.length - 1];
      attempts.push(value);
      return value;
    },
    classify: options.classify,
    delay: options.delay ?? fakeDelay(delays),
    signal: options.signal,
    onAttempt: (info) => {
      notices.push(info);
    },
    policy: {
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 2000,
      ...options.policy,
    },
  });
  return { attempts, delays, notices, result };
}

// --- classifyRetryable --------------------------------------------------------

describe("classifyRetryable", () => {
  test("transient provider errors are retryable (overloaded / rate limit / 5xx)", () => {
    const retryable = [
      "The model is overloaded, please try again later",
      "rate limit reached, slow down",
      "429 Too Many Requests",
      "500 Internal Server Error",
      "502 Bad Gateway",
      "503 Service Unavailable",
      "504 Gateway Timeout",
      "524 A Timeout Occurred",
      "upstream service unavailable",
      "internal server error",
      "Provider returned error",
      "network error while talking to upstream",
      "connection refused",
      "connection lost",
      "fetch failed",
      "getaddrinfo ENOTFOUND api.example.com",
      "socket hang up",
      "timed out",
      "request timeout",
      "websocket closed unexpectedly",
      "stream ended before message_stop",
      "you can retry your request",
      "ResourceExhausted",
    ];
    for (const message of retryable) {
      expect(classifyRetryable(err(message))).toBe(true);
    }
  });

  test("quota / billing exhaustion is not retryable", () => {
    const nonRetryable = [
      "insufficient_quota",
      "quota exceeded for this month",
      "out of budget",
      "billing error on your account",
      "Monthly usage limit reached",
      "GoUsageLimitError: free tier exhausted",
    ];
    for (const message of nonRetryable) {
      expect(classifyRetryable(err(message))).toBe(false);
    }
  });

  test("context overflow is not retryable", () => {
    const overflow = [
      "prompt is too long: 213462 tokens > 200000 maximum",
      "413 {\"error\":{\"type\":\"request_too_large\"}}",
      "Your input exceeds the context window of this model",
      "Requested token count exceeds the model's maximum context length of 131072 tokens",
      "The input token count (1196265) exceeds the maximum number of tokens allowed",
      "This model's maximum prompt length is 131072 but the request contains 537812 tokens",
      "Please reduce the length of the messages or completion",
      "This endpoint's maximum context length is 200000 tokens. However, you requested about 250000 tokens",
      "prompt token count of 99999 exceeds the limit of 200000",
      "the request exceeds the available context size",
      "too many tokens for the context window",
      "token limit exceeded",
      "context length exceeded",
      "invalid params, context window exceeds limit",
      "Prompt has 300000 tokens, but the configured context size is 200000 tokens",
    ];
    for (const message of overflow) {
      expect(classifyRetryable(err(message))).toBe(false);
    }
  });

  test("rate-limit text is excluded from overflow detection (NON_OVERFLOW)", () => {
    // "token limit exceeded" matches an overflow pattern, but the 429
    // "too many requests" prefix marks it as throttling → retryable.
    expect(
      classifyRetryable(
        err("429 Too Many Requests: token limit exceeded, please retry your request"),
      ),
    ).toBe(true);
  });

  test("aborted and non-error results are never retryable", () => {
    expect(classifyRetryable(aborted())).toBe(false);
    expect(classifyRetryable(ok())).toBe(false);
    expect(classifyRetryable({ stopReason: "length", errorMessage: "x" })).toBe(
      false,
    );
    expect(classifyRetryable({ stopReason: "toolUse" })).toBe(false);
  });

  test("an error result without an errorMessage is not retryable", () => {
    expect(classifyRetryable({ stopReason: "error" })).toBe(false);
    expect(classifyRetryable(err(""))).toBe(false);
  });

  test("nullish and shapeless inputs are not retryable", () => {
    expect(classifyRetryable(null)).toBe(false);
    expect(classifyRetryable(undefined)).toBe(false);
    expect(classifyRetryable({})).toBe(false);
  });

  test("an Error or a plain string is normalized to an error message", () => {
    expect(classifyRetryable(new Error("service unavailable"))).toBe(true);
    expect(classifyRetryable("rate limit exceeded")).toBe(true);
    expect(classifyRetryable(new Error("prompt is too long"))).toBe(false);
    expect(classifyRetryable(new Error("auth failed"))).toBe(false);
  });

  test("silent overflow via usage + contextWindow is excluded (parity with pi)", () => {
    const silentOverflow = {
      stopReason: "stop",
      usage: { input: 200000, cacheRead: 0, output: 0 },
    };
    // Not retryable regardless (a non-error result never is), matching pi's
    // _isRetryableError which checks isContextOverflow first.
    expect(classifyRetryable(silentOverflow, 128000)).toBe(false);
    expect(classifyRetryable(silentOverflow)).toBe(false);
  });
});

// --- runWithRetry --------------------------------------------------------------

describe("runWithRetry", () => {
  test("success on the first attempt: no backoff, no status", async () => {
    const success = ok();
    const outcome = await run([success]);
    expect(outcome.result).toBe(success);
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.delays).toEqual([]);
    expect(outcome.notices).toEqual([]);
  });

  test("a non-retryable failure returns immediately", async () => {
    const overflow = err("prompt is too long: 300000 tokens > 200000 maximum");
    const outcome = await run([overflow]);
    expect(outcome.result).toBe(overflow);
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.delays).toEqual([]);
    expect(outcome.notices).toEqual([]);
  });

  test("an aborted result is terminal and never retried", async () => {
    const outcome = await run([aborted()]);
    expect((outcome.result as { stopReason?: string }).stopReason).toBe("aborted");
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.delays).toEqual([]);
  });

  test("retryable failures retry with exponential backoff, then succeed", async () => {
    const f1 = err("overloaded");
    const f2 = err("503 Service Unavailable");
    const success = ok();
    const outcome = await run([f1, f2, success], {
      policy: { baseDelayMs: 1000 },
    });
    expect(outcome.result).toBe(success);
    expect(outcome.attempts).toEqual([f1, f2, success]);
    // baseDelayMs * 2^(n-1): 1000, 2000.
    expect(outcome.delays).toEqual([1000, 2000]);
    expect(outcome.notices.map((n) => n.attempt)).toEqual([1, 2]);
    expect(outcome.notices.map((n) => n.maxAttempts)).toEqual([3, 3]);
    expect(outcome.notices.map((n) => n.delayMs)).toEqual([1000, 2000]);
    expect(outcome.notices.map((n) => n.errorMessage)).toEqual([
      "overloaded",
      "503 Service Unavailable",
    ]);
  });

  test("budget exhausted returns the final error", async () => {
    const f = err("overloaded");
    const outcome = await run([f], { policy: { maxRetries: 3, baseDelayMs: 1000 } });
    // 1 original attempt + 3 retries.
    expect(outcome.attempts).toHaveLength(4);
    expect(outcome.result).toBe(f);
    expect(outcome.delays).toEqual([1000, 2000, 4000]);
    expect(outcome.notices).toHaveLength(3);
  });

  test("cancel during the backoff wait returns the last error without more attempts", async () => {
    const ctrl = new AbortController();
    const f = err("overloaded");
    // The fake clock aborts the signal and then resolves: the engine must
    // notice the cancellation right after the wait and stop.
    const outcome = await run([f], {
      signal: ctrl.signal,
      delay: async () => {
        ctrl.abort();
      },
    });
    expect(outcome.result).toBe(f);
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.notices).toHaveLength(1);
  });

  test("a pre-aborted signal still lets the first attempt run (cancel owns the wait, not the turn)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const f = err("overloaded");
    const outcome = await run([f], { signal: ctrl.signal });
    // First turn runs; the already-aborted signal then suppresses retries.
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.result).toBe(f);
    expect(outcome.delays).toEqual([]);
  });

  test("an injected classifier makes the loop shape-agnostic", async () => {
    const outcome = await run(["retryable", "retryable", "done"], {
      classify: (result) => result === "retryable",
      policy: { maxRetries: 5, baseDelayMs: 10 },
    });
    expect(outcome.result).toBe("done");
    expect(outcome.attempts).toEqual(["retryable", "retryable", "done"]);
    expect(outcome.delays).toEqual([10, 20]);
  });

  test("enabled=false runs a single attempt with zero overhead", async () => {
    const f = err("overloaded");
    const outcome = await run([f], {
      policy: { enabled: false },
      // Neither the classifier nor the clock may be touched.
      classify: () => {
        throw new Error("classify must not run when retry is disabled");
      },
      delay: () => {
        throw new Error("delay must not run when retry is disabled");
      },
    });
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.result).toBe(f);
    expect(outcome.notices).toEqual([]);
  });

  test("a delay rejection that is not an abort propagates", async () => {
    await expect(
      run([err("overloaded")], {
        delay: async () => {
          throw new Error("clock exploded");
        },
      }),
    ).rejects.toThrow("clock exploded");
  });
});

// --- sleep (the real default clock) ---------------------------------------------

describe("sleep", () => {
  test("resolves after its delay", async () => {
    const start = Date.now();
    await sleep(5);
    expect(Date.now() - start).toBeGreaterThanOrEqual(4);
  });

  test("rejects when the signal aborts before the delay elapses", async () => {
    const ctrl = new AbortController();
    const pending = sleep(60_000, ctrl.signal);
    ctrl.abort();
    await expect(pending).rejects.toThrow();
  });

  test("rejects immediately when the signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(sleep(60_000, ctrl.signal)).rejects.toThrow();
  });
});
