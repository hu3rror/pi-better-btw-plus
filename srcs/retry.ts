/**
 * Turn-level retry engine (issue #6, D9 seam): the classifier and the
 * injectable retry loop the fork's turn cycle wraps around `agent.prompt()`.
 *
 * The engine mirrors pi's turn retry semantics verbatim — classification
 * patterns are transcribed from `@earendil-works/pi-ai@0.85.1` (see
 * `dist/utils/retry.js` and `dist/utils/overflow.js`, themselves the pieces
 * `AgentSession._isRetryableError` composes). The fork targets pi 0.85.1 but
 * the repo's devDependencies pin pi-ai 0.84.2, which does not export those
 * helpers, so the tables are copied here (with their source annotations)
 * rather than imported — "照抄语义，不发明私有协议".
 *
 * The loop is fully injected so tests drive it with a fake agent (scripted
 * attempt results) and a fake clock (recorded delays); the engine itself has
 * no overlay / TUI / pi-runtime dependency.
 */
import type { ProviderRetrySettings } from "./provider-retry.ts";

/** Assistant-message-shaped failure the classifier accepts (pi's message shape). */
export interface RetryableFailure {
  stopReason?: string;
  errorMessage?: string;
  usage?: { input?: number; output?: number; cacheRead?: number };
}

// =============================================================================
// Classifier (pi-ai 0.85.1 semantics)
// =============================================================================

/** Non-retryable provider limit / billing exhaustion patterns (pi retry.js). */
function buildProviderErrorPattern(patterns: string[]): RegExp {
  return new RegExp(patterns.join("|"), "i");
}

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
  // OpenCode Go/free-tier limits returned as 429 JSON error types by OpenCode's
  // Zen API. These are subscription/account limits, not transient throttles.
  "GoUsageLimitError",
  "FreeUsageLimitError",
  // OpenCode Go subscription-limit text asks users to enable available-balance
  // usage after rolling/weekly/monthly limits are reached.
  "Monthly usage limit reached",
  "available balance",
  // Generic quota/budget/billing exhaustion. `insufficient_quota` is OpenAI's
  // quota/billing error code; the other strings cover common gateway wording.
  "insufficient_quota",
  "out of budget",
  "quota exceeded",
  "billing",
]);

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
  // Generic provider load, HTTP status, and server-side transient failures.
  "overloaded",
  "rate.?limit",
  "too many requests",
  "429",
  "500",
  "502",
  "503",
  "504",
  "524",
  "service.?unavailable",
  "server.?error",
  "internal.?error",
  // Wrapper/provider text for transient upstream failures, including OpenRouter
  // "Provider returned error" responses (#2264).
  "provider.?returned.?error",
  "exceeded request buffer limit while retrying upstream",
  // Network, proxy, and fetch transport failures. This includes OpenAI Codex
  // raw-fetch failures such as "upstream connect", "connection refused", and
  // "reset before headers" (#733), plus OpenRouter connection drops (#3317).
  "network.?error",
  "connection.?error",
  "connection.?refused",
  "connection.?lost",
  "other side closed",
  "fetch failed",
  "getaddrinfo",
  "ENOTFOUND",
  "EAI_AGAIN",
  "upstream.?connect",
  "reset before headers",
  "socket hang up",
  "socket connection was closed",
  "timed? out",
  "timeout",
  "terminated",
  // WebSocket transports can report close/error text instead of HTTP/fetch text.
  "websocket.?closed",
  "websocket.?error",
  // Premature stream endings from SDKs and transports. Anthropic can throw
  // "stream ended without ..." and "Anthropic stream ended before message_stop"
  // (#4433); Bedrock/Smithy can throw an HTTP/2 no-response error (#3594).
  "ended without",
  "stream ended before message_stop",
  "stream ended before a terminal response event",
  "http2 request did not get a response",
  // Provider-requested retry delay cap failures should flow through the outer
  // retry policy so callers can surface/abort the backoff (#1123).
  "retry delay",
  // Explicit retry guidance emitted mid-stream by OpenAI Responses and Bedrock
  // stream exceptions (#6019).
  "you can retry your request",
  "try your request again",
  "please retry your request",
  // gRPC based providers (e.g. NVIDIA NIM)
  "ResourceExhausted",
]);

/**
 * Context-overflow error patterns (pi overflow.js). The engine reimplements
 * the fork's retry decision on top of these, so overflow never retries (it is
 * handled by compaction in the main session and shown as a final error here).
 */
const OVERFLOW_PATTERNS = [
  /prompt is too long/i, // Anthropic token overflow
  /request_too_large/i, // Anthropic request byte-size overflow (HTTP 413)
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI (Completions & Responses API)
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, // OpenAI-compatible proxies (LiteLLM)
  /input token count.*exceeds the maximum/i, // Google (Gemini)
  /maximum prompt length is \d+/i, // xAI (Grok)
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter (most backends)
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
  /exceeds the limit of \d+/i, // GitHub Copilot
  /exceeds the available context size/i, // llama.cpp server
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi For Coding
  /too large for model with \d+ maximum context length/i, // Mistral
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, // DS4 server
  /model_context_window_exceeded/i, // z.ai non-standard finish_reason surfaced as error text
  /prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow error
  /range of input length should be/i, // DashScope / Qwen Token Plan
  /context[_ ]length[_ ]exceeded/i, // Generic fallback
  /too many tokens/i, // Generic fallback
  /token limit exceeded/i, // Generic fallback
  /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i, // Cerebras: 400/413 with no body
];

/**
 * Non-overflow patterns excluded from overflow detection (pi overflow.js):
 * throttling/rate-limit text that would otherwise match an overflow pattern
 * (e.g. Bedrock "ThrottlingException: Too many tokens, please wait...").
 */
const NON_OVERFLOW_PATTERNS = [
  /^(Throttling error|Service unavailable):/i, // AWS Bedrock non-overflow errors
  /rate limit/i, // Generic rate limiting
  /too many requests/i, // Generic HTTP 429 style
];

/** Anything the classifier can be handed: a message-shaped failure, an Error, or text. */
export type RetryableInput = RetryableFailure | Error | string | null | undefined;

/** Normalize loose error shapes to the assistant-message shape pi classifies. */
function toRetryableFailure(error: RetryableInput): RetryableFailure | null {
  if (error == null) return null;
  if (typeof error === "string") return { stopReason: "error", errorMessage: error };
  if (error instanceof Error) return { stopReason: "error", errorMessage: error.message };
  if (typeof error === "object") return error;
  return null;
}

/** isContextOverflow mirror (pi-ai 0.85.1 dist/utils/overflow.js). */
function isContextOverflow(message: RetryableFailure, contextWindow?: number): boolean {
  // Case 1: error-message patterns.
  if (message.stopReason === "error" && message.errorMessage) {
    const isNonOverflow = NON_OVERFLOW_PATTERNS.some((p) =>
      p.test(message.errorMessage as string),
    );
    if (
      !isNonOverflow &&
      OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage as string))
    ) {
      return true;
    }
  }
  // Case 2: silent overflow (z.ai style) — successful but usage exceeds context.
  if (contextWindow && message.stopReason === "stop") {
    const inputTokens = (message.usage?.input ?? 0) + (message.usage?.cacheRead ?? 0);
    if (inputTokens > contextWindow) return true;
  }
  // Case 3: length-stop overflow (Xiaomi MiMo style) — the server truncates
  // oversized input to fit the context window, leaving no room for output.
  if (contextWindow && message.stopReason === "length" && message.usage?.output === 0) {
    const inputTokens = (message.usage?.input ?? 0) + (message.usage?.cacheRead ?? 0);
    if (inputTokens >= contextWindow * 0.99) return true;
  }
  return false;
}

/** isRetryableAssistantError mirror (pi-ai 0.85.1 dist/utils/retry.js). */
function isRetryableAssistantError(message: RetryableFailure): boolean {
  if (message.stopReason !== "error" || !message.errorMessage) return false;
  if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(message.errorMessage)) return false;
  return RETRYABLE_PROVIDER_ERROR_PATTERN.test(message.errorMessage);
}

/**
 * Classify a failed turn as retryable, mirroring pi's `_isRetryableError`
 * semantics: transient provider errors (overloaded / rate limit / 5xx /
 * transport) retry; context overflow, aborts, non-error stops, and
 * quota/billing exhaustion never do. When the caller knows the model's
 * context window it can be passed to also catch silent overflow (pi's
 * `isContextOverflow` cases 2/3); the fork's wiring binds it via the
 * injected `classify` when it is available.
 */
export function classifyRetryable(
  error: RetryableInput,
  contextWindow?: number,
): boolean {
  const failure = toRetryableFailure(error);
  if (!failure) return false;
  if (isContextOverflow(failure, contextWindow)) return false;
  return isRetryableAssistantError(failure);
}

// =============================================================================
// Retry loop
// =============================================================================

/** The `settings.retry` budget/backoff block, same shape pi reads. */
export interface RetryPolicy {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
  /**
   * HTTP-layer retry knobs (`settings.retry.provider`, spec #20 D4): consumed
   * only by the overlay's stream assembly (injectProviderRetry) — pi's
   * streamSimple retries at the request layer before any assistant message
   * exists. The turn loop (runWithRetry) never reads this block.
   */
  provider?: ProviderRetrySettings;
}

/** Status payload for `onAttempt`, emitted before each backoff wait. */
export interface RetryAttemptInfo {
  /** Retry number, 1-based (the n-th retry after the original failed attempt). */
  attempt: number;
  /** Total retry budget (`policy.maxRetries`). */
  maxAttempts: number;
  /** Backoff for this retry: `baseDelayMs * 2^(attempt-1)`. */
  delayMs: number;
  /** Error text of the failed result. */
  errorMessage: string;
}

export interface RunWithRetryOptions {
  /** Runs one turn attempt and resolves with its result (the fake agent in tests). */
  attempt: () => Promise<unknown>;
  /**
   * Retryability decision for a result; defaults to `classifyRetryable`.
   * Injected so tests can classify arbitrary shapes and the wiring can bind
   * the model's context window.
   */
  classify?: (result: unknown) => boolean;
  /**
   * Backoff sleep; injected for a fake clock. Defaults to {@link sleep}.
   * Must settle (resolve or reject) when `signal` aborts — the engine treats
   * an aborted signal after the wait as "stop retrying, return the last error".
   */
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Cancellation (Esc): interrupts the backoff wait. */
  signal?: AbortSignal;
  /** Called before each backoff wait (e.g. to render "Retrying (attempt n)…"). */
  onAttempt?: (info: RetryAttemptInfo) => void | Promise<void>;
  /** Retry budget + backoff base (`settings.retry` shape). */
  policy: RetryPolicy;
}

/** Abortable setTimeout sleep, mirroring pi's retry sleep behavior. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function extractErrorMessage(result: unknown): string {
  if (
    typeof result === "object" &&
    result !== null &&
    "errorMessage" in result
  ) {
    const errorMessage = (result as { errorMessage?: unknown }).errorMessage;
    if (typeof errorMessage === "string" && errorMessage.length > 0) {
      return errorMessage;
    }
  }
  if (typeof result === "string" && result.length > 0) return result;
  if (result instanceof Error && result.message.length > 0) return result.message;
  return "Unknown error";
}

/**
 * Run one turn attempt with bounded retry, mirroring pi's turn retry loop
 * (`retryAssistantCall` + `_prepareRetry`):
 *
 * - A non-retryable result (success, abort, overflow, quota, …) returns as-is;
 * - a retryable failure retries up to `policy.maxRetries` times with
 *   `baseDelayMs * 2^(n-1)` backoff, emitting `onAttempt` before each wait;
 * - budget exhaustion returns the final error result unchanged;
 * - an aborted `signal` interrupts the backoff wait — an abort that lands
 *   before a wait is scheduled skips it entirely — and returns the last
 *   error result (so "Esc cancel" and "budget exhausted" are isomorphic —
 *   the wiring shows the final error either way);
 * - `policy.enabled === false` runs a single attempt with zero overhead
 *   (no classify / delay / onAttempt).
 *
 * A thrown rejection from `attempt` propagates to the caller (pi's stream
 * encodes failures as messages instead of throwing; the fork's wiring decides
 * how to surface its own throws).
 */
export async function runWithRetry(options: RunWithRetryOptions): Promise<unknown> {
  const { attempt, signal, onAttempt } = options;
  const policy = options.policy;
  const classify =
    options.classify ?? ((result: unknown) => classifyRetryable(result as RetryableInput));
  const delay = options.delay ?? sleep;

  const maxAttempts = policy.enabled ? (policy.maxRetries ?? 0) : 0;
  const baseDelayMs = policy.baseDelayMs ?? 0;

  let result: unknown = await attempt();
  let retryCount = 0;
  while (retryCount < maxAttempts && classify(result)) {
    // Esc may have fired between the failed attempt and this decision point:
    // skip scheduling a wait that would be interrupted immediately.
    if (signal?.aborted) return result;
    retryCount++;
    const delayMs = baseDelayMs * 2 ** (retryCount - 1);
    await onAttempt?.({
      attempt: retryCount,
      maxAttempts,
      delayMs,
      errorMessage: extractErrorMessage(result),
    });
    try {
      await delay(delayMs, signal);
    } catch (error) {
      if (signal?.aborted) return result;
      throw error;
    }
    if (signal?.aborted) return result;
    result = await attempt();
  }
  return result;
}
