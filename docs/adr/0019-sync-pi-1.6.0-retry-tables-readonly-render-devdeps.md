# Sync to pi 1.6.0: retry tables re-synced (five retryable patterns), readonly render adaptation, devDeps bumped

The host pi moved 1.5.0 → 1.6.0 (npm latest, 2026-11-20), so this ADR records
the re-verification obligation from ADR 0009 and the sync pattern for the
1.6.0 series. Unlike 1.5.0, this release carries **one breaking change on this
extension's surface**: `Component.render()` now returns `readonly string[]` and
containers return a cached array while children are unchanged (#9549, the
fullscreen wheel-scroll CPU fix). The SDK typecheck gate is green against
1.6.0 and the full suite (455 tests) passes. The behavior-relevant drift is
again in pi-ai's `dist/utils/retry.js`: five new retryable patterns under
Fixed (semantic changes hiding under Fixed, per the sync checklist).

## Decision

- **`retry.js` mirror gains five retryable patterns, verbatim** from pi-ai
  1.6.0 `dist/utils/retry.js`: `"connection.?closed"` (#12064), the bare Node
  socket-code pattern
  `"(?<![a-z0-9_])(?:ECONNRESET|ECONNABORTED|ECONNREFUSED|ETIMEDOUT|EPIPE)(?![a-z0-9_])"`
  plus `"connection reset by peer"` (#12128),
  `"websocket.?connection.?limit.?reached"` (#12124), and
  `"cut short after the reply had begun"` (#11879), each in upstream's
  position. The 1.5.0 → 1.6.0 diff of `retry.js` is exactly these five
  additions. **Behavior-affecting**: these provider failures previously ended
  the side-chat turn as final errors; they now retry with backoff, matching
  the main session (ADR 0013/0015's parity rationale).
- **Readonly render adapted at the editor-selection seam**: pi's
  `Editor.render()` output now flows into `editor-selection.ts` as
  `readonly string[]`, so `contentBandPlainLines`,
  `decorateEditorSelection`, and `EditorSelectionState.decorate` widen their
  input params to `readonly string[]`, and both no-selection pass-through
  paths return `rendered.slice()` — every path now returns a fresh array the
  caller owns, never a reference to pi's (possibly cached) render output,
  which is exactly what #9549's contract forbids handing back as mutable.
  Type-only for every caller except array-identity assertions. No in-place
  mutation exists anywhere in the fork's render pipeline:
  `SideChatMessages.render` builds fresh arrays, and the overlay pads
  `msgLines` — its own component's output — never pi's.
- **Seams re-verified against the 1.6.0 dist** (the ADR 0009 upgrade
  obligation):
  - pi-ai `dist/utils/overflow.js`: **byte-identical** — the fork's
    `OVERFLOW_PATTERNS`/`NON_OVERFLOW_PATTERNS` are current.
  - pi-tui `dist/word-navigation.js`: **byte-identical**; `dist/utils.js`:
    the three inlined helpers (`getWordSegmenter`, `PUNCTUATION_REGEX`,
    `isWhitespaceChar`) unchanged — 1.6.0 only adds grapheme-cluster
    fast-path functions, which the fork does not mirror.
  - pi-tui `dist/tui.js`: `resolveOverlayLayout` (L861 → L955) and
    `parseSizeValue` are **byte-identical** (region diff empty); the 193-line
    diff is render-caching and terminal-image machinery — the new
    `renderChildLines`/`ChildLines`, a suspend-signal mechanism,
    `contentChanged`/`requestViewRender` renames, `hideImagesUnderOverlay`,
    CURSOR-marker cleanup, terminal-image imports — none of it mirrored by the
    fork. pi-tui `dist/keys.js` (mouse parser):
    **byte-identical**. `dist/tui-alt-screen.js` changed `requestRender` →
    `requestViewRender` for viewport-only repaints — not mirrored; the fork
    renders its own overlay each frame.
  - pi-coding-agent `dist/core/sdk.js`: the `buildRequestOptions` block is
    line-for-line identical to 1.5.0 (`getProviderRetrySettings` L194, the
    retry `??` chain L200–203, `identity` L205, `streamFn` L261–262), so
    `provider-retry.ts`'s comment refs are still accurate — no change.
  - pi-tui 1.6.0's new public exports (`ChildLines`, `renderChildLines`,
    `dispatchMouseToChildLines`): additive, unused by the fork.
- **devDependencies bumped** `^1.5.0` → `^1.6.0` for all four
  `@earendil-works/pi-*` packages; `bun run typecheck` is green against 1.6.0
  and the full suite passes (455 tests: +7 retryable fixture wordings for the
  new patterns, and the no-selection assertion retargeted from `.toBe` to
  `.toEqual` because the readonly input contract removed the same-reference
  property it tested).

## Considered options

- **Copy at the overlay call site instead of widening editor-selection
  params** (rejected): the module's input contract should mirror pi's actual
  surface — `Editor.render()` output is readonly by contract now; the overlay
  is the only caller today, but the module is the seam.
- **Widen the output types to `readonly string[]` too** (rejected): cascades
  into `renderSideChatFrame` and every consumer for no gain — both paths
  already return fresh arrays, so the output contract stays `string[]`.
- **Keep the identity pass-through with a cast** (rejected): hands out a
  mutable view of pi's cached render array — exactly the hazard #9549's
  contract change exists to remove.
- **Adopt pi-tui's grapheme fast-path helpers** (`segmentGraphemes` etc.,
  `dist/utils.js`) (not adopted): internal fast-paths behind the fork's own
  `Intl.Segmenter` loops; the peer dependency is `*`, so adoption needs a
  fallback branch for older pi (same rationale as ADR 0018's
  `keyHint()`/`keyText()`).
- **Adopt `renderChildLines`/`ChildLines`** (not adopted): the fork's overlay
  is a single flat component; it has no child-container concatenation.

## Consequences

- Runtime behavior change (adopted): provider failures reading "Connection
  closed.", bare Node socket codes (`read ECONNRESET` …), Codex
  WebSocket-connection-limit drops, and "cut short after the reply had begun"
  now retry in the side chat's turn loop instead of ending the turn; verified
  at the `classifyRetryable` unit level (fixtures). End-to-end behavior in a
  live session `[NEEDS MANUAL VERIFICATION]`.
- README.md / README.zh-CN.md compatibility notes now pin pi 1.6.0.
- A release is warranted (1.7.5 per the fork's sync-release convention);
  releases follow the repo's release flow, not this sync.
