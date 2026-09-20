# Sync to pi 0.86.0: re-verified mirrors, aligned retry classifier and backoff cap

The extension's devDependencies moved from `^0.84.2` to `^0.86.0`, pinning the
typecheck and test surface to the pi version the host currently runs (0.86.0).
Type-level drift was zero: against the real 0.86.0 SDK types the extension
compiles clean with no source changes (all four `@earendil-works/pi-*` packages
and the runtime export surfaces — `pi-ai/compat`, `pi-tui` deep imports, the
`sdk.js` streamFn `??` injection order — verified intact). The only behavioral
drift found was in the turn-level retry mirror (`srcs/retry.ts`), which had been
transcribed against pi-ai 0.85.1 semantics; pi changed three things in 0.86.0.

## Decision

- **Classifier aligned**: `RETRYABLE_PROVIDER_ERROR_PATTERN` now includes the
  two patterns pi added in 0.86.0 — `"currently experiencing high demand"` and
  `"520"` — so the side chat retries exactly the error classes the main session
  does.
- **Backoff capped**: `runWithRetry` now mirrors pi 0.86.0's `retryDelayMs` —
  exponential delays are capped at `settings.retry.maxAgentDelayMs`, defaulting
  to 60s (`DEFAULT_MAX_AGENT_RETRY_DELAY_MS`), with the same
  `Number.isSafeInteger` overflow guard. `loadRetryPolicy` forwards
  `maxAgentDelayMs` (pi's `getRetrySettings()` already applies the 60s default).
- **Cerebras overflow gate not followed**: pi 0.86.0 classifies bodyless 400/413
  as overflow only when `provider === "cerebras"`; the fork keeps the pattern
  unconditional. Both classifications end in "not retryable" for the realistic
  error text, and the fork's `classify` wiring does not reliably carry a
  `provider` discriminant. Deliberate deviation, noted in the source.
- **Mirror kept, not imported**: pi-ai 0.86.0 now exports `./utils/*` (the
  previously private `retry.js`/`overflow.js` helpers), but the tables stay
  copied. The engine is a pure, pi-runtime-free module driven by fakes in tests
  (D9 seam); importing pi internals would couple the fork to pi's private
  implementation details.

## Considered options

- **Keep 0.85.1 semantics** (rejected): the fork's retry decision would silently
  diverge from the main session on two transient error classes and on long
  backoff chains — the mirror's whole purpose is parity.
- **Follow the Cerebras provider gate** (rejected): negligible practical impact,
  and the failure shape reaching `classifyRetryable` lacks a reliable provider
  discriminant.
- **Import the retry/overflow helpers from `@earendil-works/pi-ai/utils/*`**
  (rejected): breaks the D9 purity/testability contract; the mirror with source
  annotations stays the single source of the fork's retry semantics.

## Consequences

- The overlay-layout mirror (`srcs/overlay-layout.ts`) was re-verified against
  pi-tui 0.86.0 `dist/tui.js` (L781-902 for `resolveOverlayLayout`, L57-68 for
  `parseSizeValue`, private declaration at `dist/tui.d.ts` L350, composition
  maxHeight clamp L924-926, second row/col resolution L929); source line
  references in comments and tests updated.
- `provider-retry.ts` needs no change: pi's `sdk.js` streamFn injection order is
  verbatim identical in 0.86.0.
- Version claims in older ADRs (0004/0005) are historical records of what was
  verified at decision time and were left untouched.
- README (both languages) now carries a compatibility note pinning the verified
  pi version to 0.86.0.
