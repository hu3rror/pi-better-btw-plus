# Sync to pi 0.87.1: overflow pattern aligned, native clipboard and registry auth adopted

The extension's devDependencies moved from `^0.86.0` to `^0.87.1`, pinning the
typecheck and test surface to the pi version the host currently runs (0.87.1).
Three behavioral drifts and one dependency drift were found against the host:

- the turn-level retry mirror classified context overflow against pi-ai 0.86.0's
  patterns, so z.ai-style "Prompt too long" wording was retried instead of
  stopped;
- the native clipboard read channel loaded `@mariozechner/clipboard`, a package
  the host no longer ships, so every Windows paste fell through to the ~1s
  PowerShell `Get-Clipboard -Raw` subprocess;
- the fork resolved provider auth itself (`agentOptions.getApiKey`) although the
  model registry resolves auth at request time, leaving two paths that can drift;
- the tree carried two typebox versions plus the legacy `@sinclair/typebox`
  specifier.

## Decision

- **Overflow pattern aligned**: `OVERFLOW_PATTERNS` in `srcs/retry.ts` widens
  its Anthropic entry from `/prompt is too long/i` to
  `/prompt (?:is )?too long/i`, matching pi-ai 0.87.1
  `dist/utils/overflow.js` — bare z.ai-style "Prompt too long" is now overflow.
  The overflow check already precedes the retryable check, so overflow wording
  wins even when the message also carries retryable wording. The mirror stays a
  transcription, not an import (ADR 0007's contract); the documented Cerebras
  provider-gate deviation stays.
- **Native clipboard channel adopted**: the native read channel loads pi-tui's
  `getNativeClipboard()` — the bundled helper the main session's
  `readClipboardText` uses too. `NativeClipboard.getText`'s tri-state maps to
  the `{ok:true|empty|unavailable}` outcome contract: string → ok, `null` →
  empty, `undefined` → unavailable, rejection → unavailable. The PowerShell /
  `pbpaste` / OSC 52 fallbacks are unchanged, and linux now leads with the
  native channel (it self-gates on `DISPLAY`) before the OSC 52 query. The
  `@mariozechner/clipboard` loader, its cached state and its addon type are
  deleted.
- **Auth wiring switched to the registry**: `streamFn` becomes
  `injectProviderRetry(modelRegistry.streamSimple.bind(modelRegistry), …)`. The
  registry resolves auth at request time (API key / OAuth / baseUrl);
  `agentOptions.getApiKey` is removed. `injectProviderRetry` remains because the
  registry does not inject `settings.retry.provider`.
- **Typebox consolidated**: `typebox` moves to `1.3.27` and imports migrate from
  `@sinclair/typebox` to the `typebox` specifier; the tsconfig path alias and
  the `@sinclair/typebox` peer entry go away.
- **Version annotations swept**: comments and test names that claimed a `pi
  0.86.0` verification for a claim re-checked in this sync now name 0.87.1.
  ADRs 0001–0007 stay historical records.

## Considered options

- **Leave the clipboard channel as-is** (rejected): the host no longer ships
  `@mariozechner/clipboard`, so the fast path can never load and every Windows
  paste pays the subprocess cold-start — the regression this sync exists to fix.
- **Replace the whole read path with the native helper** (rejected): the helper
  is absent on linux without `DISPLAY` and on non-x64/arm64 archs, so a
  native-only path would fail instead of degrading. The injected-channel seam and
  the fallback cascade stay.
- **Change the copy path too** (rejected): the write side already delegates to
  pi's public `copyToClipboard`; there is nothing to align.
- **Keep the hand-wired `getApiKey`** (rejected): two auth-resolution paths can
  drift (e.g. OAuth token refresh), and the registry is the host's own seam.
- **Keep the `@sinclair/typebox` alias** (rejected): leaves a duplicate typebox
  and the legacy specifier in the tree for no benefit.
- **Keep the 0.86.0 overflow pattern** (rejected): "Prompt too long" is
  unrecoverable, so retrying it burns attempts and diverges from the main
  session's classification.

## Consequences

- Windows right-click and Ctrl+V paste regain the native read path;
  `[NEEDS MANUAL VERIFICATION]` on Windows latency until measured by hand.
- The overlay-layout mirror (`srcs/overlay-layout.ts`) was re-verified against
  pi-tui 0.87.1 `dist/tui.js`: `resolveOverlayLayout` L781-869 (was L781-902),
  `parseSizeValue` L57-68, composition maxHeight clamp L925-926, second row/col
  resolution L929, private declaration at `dist/tui.d.ts` L350. The mirror body
  is unchanged; source line references in comments and tests were updated.
- `provider-retry.ts` needs no behavioral change: pi-coding-agent 0.87.1
  `dist/core/sdk.js` still injects `options?.X ?? providerRetrySettings.X`
  (`buildRequestOptions` L179-188, `streamFn` L233).
- `config.ts`'s `maxAgentDelayMs` forwarding still mirrors the host:
  `getRetrySettings()` applies `DEFAULT_MAX_AGENT_RETRY_DELAY_MS` (60s) in
  0.87.1.
- README (both languages) now carries a compatibility note pinning the verified
  pi version to 0.87.1.
- Version claims in older ADRs (0004/0005/0007) are historical records of what
  was verified at decision time and were left untouched.
