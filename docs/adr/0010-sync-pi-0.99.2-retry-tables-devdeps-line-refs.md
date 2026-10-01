# Sync to pi 0.99.2: retry/overflow tables completed, devDeps bumped, internal-surface references re-verified

The extension's devDependencies moved from `^0.87.1` to `^0.99.2`, pinning the
typecheck and test surface to the pi version the host currently runs (0.99.2,
mise since 2026-09-30). npm never published a 0.88.0–0.98.x series; 0.99.0
(2026-09-29) folded the week's changes between 0.87.1 (2026-09-22) and 0.99.2
(2026-09-30). A throwaway-tsconfig typecheck against the 0.99.2 packages was
green with zero source changes — no public-type drift on any surface the
extension uses (`pi-ai/compat`, `pi-tui` deep imports, `pi-agent-core`, the
`ExtensionRunner`/`wrapRegisteredTools`/`buildSessionContext` API). The drift
was confined to the mirrored internal tables and line-number references.

## Decision

- **Retry/overflow mirror tables completed verbatim** against pi-ai 0.99.2
  `dist/utils/retry.js` and `dist/utils/overflow.js`:
  - `RETRYABLE_PROVIDER_ERROR_PATTERN` gains `"subscription_sharing_usage_unavailable"`
    and `"subscription_sharing_user_unavailable"` (Sign in with ChatGPT, 0.99.0:
    usage/user data temporarily unavailable, can arrive mid-stream without an
    HTTP 503). **Behavior-affecting**: with a ChatGPT-subscription login, the
    fork's turn loop now retries these transient failures, matching the main
    session. Sign-off granted in ticket #36.
  - `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN` gains
    `"subscription_sharing_usage_limit_exceeded"` (shared usage limit, resets
    after hours). No outcome change — the string matched no retryable pattern
    before, so it already classified non-retryable; the addition makes the
    mirror verbatim.
  - `OVERFLOW_PATTERNS` gains `/prompt exceeds max length/i` (z.ai CN
    endpoint). No user-visible outcome change for the fork (both old and new
    classify non-retryable), but classification semantics align with pi.
- **devDependencies bumped** to `^0.99.2` for all four `@earendil-works/pi-*`
  packages; the repo's own `bun run typecheck` now guards the real runtime
  types.
- **Internal-surface line references re-verified against the 0.99.2 dist**
  (source comments and test headers updated):
  - pi-tui `dist/tui.js`: `resolveOverlayLayout` L827-915 (was L781-869),
    `parseSizeValue` L72 (was L57-68), maxHeight→availHeight clamp L852,
    composition effectiveHeight clamp L855, second row/col resolve call L975
    (was L929). The `resolveLayout` mirror body is unchanged — re-verified
    byte-identical against 0.99.2.
  - pi-coding-agent `dist/core/sdk.js`: `buildRequestOptions` L181-191 (was
    L179-188), `streamFn` L250 (was L233). The injection order is unchanged;
    the new `?? effectiveTimeoutMs` leg sits downstream of the injector, so
    `injectProviderRetry` semantics are identical.
  - `dist/core/extensions/runner.d.ts`: `getAllRegisteredTools` L132 (was
    L125); still a prototype method, so the `ExtensionRunner` patch keeps
    intercepting.
- **README compatibility note** (both languages) pins the verified pi version
  to 0.99.2.

## Considered options

- **Import pi-ai's `utils/*` instead of copying the tables** (rejected): breaks
  the D9 purity/testability contract (ADR 0007) — the engine stays a pure,
  pi-runtime-free module driven by fakes in tests.
- **Skip the retryable-table addition** (rejected): the fork's retry decision
  would silently diverge from the main session on ChatGPT-subscription
  transient failures — the mirror's whole purpose is parity.
- **Rewrite line-number claims in ADRs 0004/0007/0008/0009** (rejected): per
  the convention recorded in ADRs 0008/0009, older ADRs are historical records
  of what was verified at decision time; this ADR is the current verification
  record, and the live source comments carry the fresh numbers.

## Consequences

- `test/retry.test.ts` gained fixtures for the four patterns at the
  `classifyRetryable` seam (five list entries: the two
  `subscription_sharing_*_unavailable` strings in the retryable list,
  `subscription_sharing_usage_limit_exceeded` in the quota/billing list, and
  both z.ai CN "Prompt exceeds max length" variants — JSON-wrapped and bare —
  in the overflow list); the full suite stays green (396 pass) and
  `bun run typecheck` is green against 0.99.2.
- The behavior-affecting item (ChatGPT-subscription transient failures now
  retried by the fork) is code-inferred; runtime confirmation
  [NEEDS MANUAL VERIFICATION].
- ADRs 0001–0009 remain historical records, untouched.
