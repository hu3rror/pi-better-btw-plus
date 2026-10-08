# Sync to pi 1.1.0: busy/cancelled-stream errors retryable, devDeps bumped, all internal-surface seams re-verified

The host pi moved 1.0.2 → 1.1.0 (mise, 2026-10-07), so this ADR records the
re-verification obligation from ADR 0009 and the sync pattern from ADRs
0010/0011 for the 1.1.0 series. pi 1.1.0's breaking changes are type-only for
this extension: pi-ai requires stream functions to return an
`AssistantMessageEventStream` (the fork's `ProviderStreamFn` already does —
no hand-written subclass), and pi-tui requires `Terminal` implementations to
provide `setProgramStatus()` (the fork never implements `Terminal`). The sync
diff is the smallest possible: two retryable pattern groups added verbatim,
devDeps bumped, version comments refreshed.

## Decision

- **`retry.js` mirror gains `"server_busy"` / `"servers are currently busy"`
  and `"pending stream has been canceled"`** verbatim from pi-ai 1.1.0
  `dist/utils/retry.js` (issues #10543 and #10379: "server_busy" /
  "servers are currently busy" provider errors and Bedrock HTTP/2 stream
  cancels end the turn instead of being retried at 1.0.2). **Behavior-
  affecting**: with a provider that reports busy/cancelled-stream as an error
  message (no HTTP status), the fork's turn loop now retries, matching the
  main session. The diff 1.0.2 → 1.1.0 of `dist/utils/retry.js` is exactly
  these two additions — verified with a byte diff of the two files;
  `dist/utils/overflow.js` is byte-identical.
- **devDependencies bumped** `^1.0.2` → `^1.1.0` for all four
  `@earendil-works/pi-*` packages; `bun run typecheck` is green against 1.1.0
  with zero source-shape changes — no public-type drift on any surface the
  extension uses (`pi-ai/compat`, `pi-tui` deep imports, `pi-agent-core`
  `AgentMessage`/`AgentTool`/`ThinkingLevel`, the
  `ExtensionRunner`/`wrapRegisteredTools` API).
- **All internal-surface seams re-verified against the 1.1.0 dist** (the ADR
  0009 upgrade obligation; the new numbers live in the source comments):
  - pi-tui `dist/tui.js`: byte-identical — `resolveOverlayLayout` still
    L827-915, `parseSizeValue` still L72; `tui.d.ts` byte-identical
    (`Component.handleMouse`, `TUI.mode`, `TuiMouseEvent` surface
    unchanged). `dist/tui-alt-screen.js` gains only
    `TuiAltScreen.resetTextSelection` (+5 lines after L133); the mouse-routing
    seams hold with a uniform +5 shift — `handleSelectionMouseEvent` L1090,
    `copyOnSelect` release L1136, `compositeOverlays` L1454, enter/exit mouse
    writes L192/L203. `dist/terminal.d.ts` gains the required
    `setProgramStatus` on the `Terminal` interface (no fork `Terminal`
    implementation to update).
  - pi-tui `dist/word-navigation.js`/`.d.ts`: byte-identical; the deep import
    and `WordNavigationOptions` call shape hold.
  - pi-tui `dist/native-platform.js`: byte-identical; `getNativeClipboard`
    still exported (the clipboard-read delegate loader holds).
  - pi-coding-agent `dist/core/sdk.js`: the `injectProviderRetry`
    `??`-fallback injection point (`buildRequestOptions` L193-211, `streamFn`
    L262) holds; lines shifted from L181-191/L250.
  - pi-coding-agent `dist/core/extensions/runner.d.ts`:
    `getAllRegisteredTools` still a prototype method at L132, so the
    `ExtensionRunner` patch keeps intercepting.
  - pi-ai `dist/compat.js`/`.d.ts`: byte-identical; `clampThinkingLevel` and
    the compat imports hold. `dist/utils/provider-retry.js` gains optional
    `noRetryStatuses` support (additive; the fork does not inject it).
- **Version comments refreshed** across `srcs/` and `test/` (1.0.2 → 1.1.0)
  for the surfaces just re-verified; READMEs (both languages) pin 1.1.0.

## Considered options

- **Import pi-ai's `utils/*` instead of copying the tables** (rejected,
  again): breaks the D9 purity/testability contract (ADR 0007) — the engine
  stays a pure, pi-runtime-free module driven by fakes in tests.
- **Skip the retryable-table additions** (rejected): the fork's retry decision
  would silently diverge from the main session on busy/cancelled-stream
  failures — the mirror's whole purpose is parity.
- **Expose `noRetryStatuses` in `ProviderRetrySettings`** (rejected): no
  demand for status exemptions from the fork's settings surface; adding it
  widens D2's single source of truth for no current caller.
- **Adopt 1.1.0 additions elsewhere** (rejected): program-status reporting,
  `TuiAltScreen.resetTextSelection`, tool `durationMs`/`outputPad`,
  `Box`/`Text.setPaddingX`, classifier images, `LoginOptions.agentName` — none
  touch a surface the fork's overlay uses.
- **Rewrite line-number claims in ADRs 0004/0007/0008/0009/0010/0011/0012**
  (rejected): per the convention recorded in ADRs 0008/0009/0010, older ADRs
  are historical records of what was verified at decision time; this ADR is
  the current verification record, and the live source comments carry the
  fresh numbers.

## Consequences

- `test/retry.test.ts` gained `"server_busy"`, `"servers are currently busy"`,
  and `"pending stream has been canceled"` in the retryable list fixture at
  the `classifyRetryable` seam (covers the exact provider wordings from issues
  #10543/#10379); the full suite stays green (412 pass) and
  `bun run typecheck` is green against 1.1.0.
- The behavior-affecting item (busy/cancelled-stream errors now retried by the
  fork) is code-inferred; runtime confirmation [NEEDS MANUAL VERIFICATION].
- ADRs 0001–0012 remain historical records, untouched.
