# Sync to pi 1.0.2: "model is at capacity" retryable, devDeps bumped, all internal-surface seams re-verified

The host pi moved 0.99.2 → 1.0.2 (mise, 2026-10-04), so this ADR records the
re-verification obligation from ADR 0009 and the sync pattern from ADR 0010
for the 1.0.x series. pi 1.0.0 (2026-10-01) is the 1.0 cut — notably fullscreen
TUI by default and fullscreen rendering fixes — and 1.0.1/1.0.2 carried one
retry-relevant fix. The sync diff is the smallest possible: one retryable
pattern added verbatim, devDeps bumped, version comments refreshed.

## Decision

- **`retry.js` mirror gains `"model is at capacity"`** verbatim from pi-ai
  1.0.2 `dist/utils/retry.js` (added by pi 1.0.1, issue #10278: "Selected
  model is at capacity" provider errors end the turn instead of being
  retried). **Behavior-affecting**: with a provider that reports capacity as
  an error message (no HTTP status), the fork's turn loop now retries,
  matching the main session. The diff 0.99.2 → 1.0.2 is exactly this one
  string — verified with a byte diff of the two `dist/utils/retry.js` files;
  `dist/utils/overflow.js` is byte-identical.
- **devDependencies bumped** `^0.99.2` → `^1.0.2` for all four
  `@earendil-works/pi-*` packages; `bun run typecheck` is green against 1.0.2
  with zero source-shape changes — no public-type drift on any surface the
  extension uses (`pi-ai/compat`, `pi-tui` deep imports, `pi-agent-core`
  `AgentMessage`/`AgentTool`/`ThinkingLevel`, the
  `ExtensionRunner`/`wrapRegisteredTools`/`buildSessionContext` API).
- **All internal-surface seams re-verified against the 1.0.2 dist** (the ADR
  0009 upgrade obligation; the new numbers live in the source comments):
  - pi-tui `dist/tui.js`: `resolveOverlayLayout` still L827-915, body
    byte-identical (diff of the extracted method bodies is empty);
    `parseSizeValue` still L72. The `resolveLayout` mirror is unchanged.
  - pi-tui `dist/word-navigation.js`: byte-identical; the deep import and
    `WordNavigationOptions` call shape hold.
  - pi-tui `dist/native-platform.js`: byte-identical; `getNativeClipboard`
    still exported (the clipboard-read delegate loader holds).
  - pi-coding-agent `dist/core/sdk.js`: byte-identical; the
    `injectProviderRetry` `??`-fallback injection point
    (`buildRequestOptions` L181-191, `streamFn` L250) holds.
  - pi-coding-agent `dist/core/extensions/runner`: `getAllRegisteredTools`
    still a prototype method (runner.js L411, runner.d.ts L132), so the
    `ExtensionRunner` patch keeps intercepting.
  - pi-ai `dist/utils/retry.js`: `DEFAULT_MAX_AGENT_RETRY_DELAY_MS` still
    60_000; the only table change is the `"model is at capacity"` addition.
- **Version comments refreshed** across `srcs/` and `test/` (0.99.2 → 1.0.2)
  for the surfaces just re-verified; READMEs (both languages) pin 1.0.2.
- **Fullscreen-by-default (1.0.0) needs no code change**: the overlay's mouse
  handler already treats the alt-screen branch (pi consumes every SGR sequence
  in fullscreen; the extension's own mouse reporting only fires in regular
  mode) and the layout mirror resolves against term geometry that pi-tui
  provides either way.

## Considered options

- **Import pi-ai's `utils/*` instead of copying the tables** (rejected,
  again): breaks the D9 purity/testability contract (ADR 0007) — the engine
  stays a pure, pi-runtime-free module driven by fakes in tests.
- **Skip the retryable-table addition** (rejected): the fork's retry decision
  would silently diverge from the main session on capacity-style failures —
  the mirror's whole purpose is parity.
- **Rewrite line-number claims in ADRs 0004/0007/0008/0009/0010** (rejected):
  per the convention recorded in ADRs 0008/0009/0010, older ADRs are
  historical records of what was verified at decision time; this ADR is the
  current verification record, and the live source comments carry the fresh
  numbers.
- **Wait for pi 1.1 before syncing** (rejected): the running host is already
  1.0.2; the extension's README version contract and ADR 0009 re-check
  obligation bind to the runtime, not to a "stable enough" milestone.

## Consequences

- `test/retry.test.ts` gained `"Selected model is at capacity"` in the
  retryable list fixture at the `classifyRetryable` seam (covers the exact
  provider wording from issue #10278); the full suite stays green (396 pass)
  and `bun run typecheck` is green against 1.0.2.
- The behavior-affecting item (capacity errors now retried by the fork) is
  code-inferred; runtime confirmation [NEEDS MANUAL VERIFICATION].
- ADRs 0001–0010 remain historical records, untouched.
