/**
 * Provider-level retry injection (spec #20, issue #21): a pure assembly
 * helper that forwards `settings.retry.provider` (`timeoutMs` / `maxRetries`
 * / `maxRetryDelayMs`) into the fork's stream function so pi's streamSimple
 * applies its built-in HTTP-layer retry (`retryProviderRequest`: 429/408/409/
 * 5xx with exponential backoff + jitter, honoring `Retry-After`, capped by
 * `maxRetryDelayMs`) BEFORE any assistant message is produced — mirroring the
 * main session's provider layer.
 *
 * The helper does NOT implement retry: it only injects options (D1, along
 * with the pre-agreed reason to not port pi's backoff algorithm or deep-import
 * `dist/utils/provider-retry.js`). The `??` fallback order mirrors pi-coding-
 * agent 0.85.1 `dist/core/sdk.js` streamFn wiring verbatim:
 * `options?.X ?? providerRetrySettings.X` — explicit caller options win.
 *
 * Zero-cost identity (D3): with no settings (or no injectable keys) the
 * original stream function is returned unchanged, so unconfigured behavior is
 * byte-identical to the bare `streamFn: streamSimple` wiring.
 */
import type {
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";

/** The `settings.retry.provider` block (D4): HTTP-layer retry knobs. */
export interface ProviderRetrySettings {
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
}

/** Shape shared by the fork's stream functions (pi `StreamFn` surface). */
export type ProviderStreamFn = (
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
/** The keys `settings.retry.provider` can carry (D2, spec #20) — single source
 * of truth shared by the config extraction (config.ts) and the identity check. */
export const PROVIDER_RETRY_KEYS = [
  "timeoutMs",
  "maxRetries",
  "maxRetryDelayMs",
] as const;
function hasInjectableKeys(
  settings: ProviderRetrySettings | undefined,
): settings is ProviderRetrySettings {
  if (!settings) return false;
  return PROVIDER_RETRY_KEYS.some((key) => settings[key] !== undefined);
}

/**
 * Wrap `streamFn` so that missing provider-retry options are filled from
 * `settings` (caller-provided options always win, `??` order — mirrors pi's
 * sdk.js streamFn chain). With no settings / no injectable keys, returns the
 * original function reference (identity, D3).
 */
export function injectProviderRetry(
  streamFn: ProviderStreamFn,
  settings: ProviderRetrySettings | undefined,
): ProviderStreamFn {
  if (!hasInjectableKeys(settings)) return streamFn;
  const injected = settings; // narrowed by the guard; has ≥1 injectable key
  return (model, context, options) =>
    streamFn(model, context, {
      ...options,
      timeoutMs: options?.timeoutMs ?? injected.timeoutMs,
      maxRetries: options?.maxRetries ?? injected.maxRetries,
      maxRetryDelayMs: options?.maxRetryDelayMs ?? injected.maxRetryDelayMs,
    });
}
