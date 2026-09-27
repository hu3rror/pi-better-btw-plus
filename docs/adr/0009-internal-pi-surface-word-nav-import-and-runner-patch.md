# Internal pi-surface seams: word-navigation deep import and ExtensionRunner prototype patch

Two seams reach into pi's private/internal surface because the public
extension API (`ExtensionAPI`, `ctx`, the `@earendil-works/pi-tui` package
entry) does not expose what the side chat needs: the Editor widget's word-jump
semantics, and the extension-runner instance behind `getExtensionAgentTools()`.
Both are verified against the pinned pi version (0.87.1 — devDependencies
pin the typecheck surface, the host runs the same version) and carry inline
SWAP POINT markers in the source. This ADR records the decision, the
verification anchor, the failure modes, and the upgrade re-check obligation,
so future version bumps and architecture reviews treat them as known, planned
seams instead of rediscovering them as bugs.

## Decision

- **Deep import of word navigation**: `srcs/editor-selection.ts` imports
  `findWordBackward` / `findWordForward` and calls them with
  `WordNavigationOptions`-shaped `{ segment, isAtomicSegment }` options (the
  type is not imported; the object is inferred) from
  `@earendil-works/pi-tui/dist/word-navigation.js` — the Editor widget's own
  word-jump helper. Not reimplemented: the paste-marker atomic-segment merging
  must stay token-identical with the editor's `segmentWithMarkers`, and the
  helper is pure (testable through `wordSelection`). Verified against pi-tui
  0.87.1 (`dist/word-navigation.d.ts`). SWAP POINT: a public export (package
  entry or Editor API) replaces the deep import.
- **Prototype patch of `ExtensionRunner.prototype.getAllRegisteredTools`**:
  `srcs/index.ts` wraps the prototype method once (guarded by a `Symbol.for`
  marker so `/reload` cannot nest the wrapper) to capture the runner instance,
  then hands the registered tools to pi's official `wrapRegisteredTools`
  adapter for the fork's tool list. The patch works because pi-coding-agent
  0.87.1 declares the method on the prototype
  (`dist/core/extensions/runner.d.ts` L125). SWAP POINT: a public runner /
  instance accessor removes the patch.
- **Verification anchor**: both seams verified against pi 0.87.1. The extension
  is an npm package whose runtime `*` peerDependencies can drift from the
  pinned devDependencies; the README compatibility note (pi 0.87.1) is the
  version contract, and this ADR is the re-check point on every version bump.
- **Tests are the drift guard**: `wordSelection` (editor-selection.test.ts) and
  the lifecycle tests pin *behavior*. A pi change that keeps behavior identical
  needs no rework; one that changes it fails tests loudly.

## Considered options

- **Reimplement word navigation locally** (rejected): duplicates the editor's
  paste-marker merging; two copies drift — the exact failure mode ADR 0004
  avoids for layout.
- **Hand-roll the RegisteredTool → AgentTool mapping instead of the patch**
  (rejected pre-ADR): already replaced by the official `wrapRegisteredTools`
  adapter; the patch exists only to obtain the runner instance that adapter
  requires.
- **Request public APIs before depending on internals** (deferred): pi has no
  public word-navigation or runner-instance accessor in 0.87.1; the SWAP POINT
  markers encode the replacement plan for when one appears.
- **Leave the seams unrecorded** (rejected): an unrecorded internal-surface
  dependency is rediscovered as a "bug" on every version bump; recording makes
  it a known, planned seam with an explicit re-check obligation.

## Consequences

- Upgrade workflow: on any pi version bump (a future 0.88 sync in the spirit
  of ADRs 0007/0008), re-verify both seams first — compile against the new
  types, re-check `dist/word-navigation.js` exports and the `ExtensionRunner`
  prototype shape, and run the full test suite. A dist re-layout breaks loudly
  at load; a prototype-method → class-field conversion breaks silently
  (extension tools vanish from the fork without an error).
- ADR 0004 stays the record for the layout mirror and ADR 0006 for the
  editor-selection model the word-navigation seam lives inside (same family —
  mirroring pi internals — but separate seams); ADRs 0001–0008 remain
  historical records.
- The inline annotations in `srcs/editor-selection.ts` and `srcs/index.ts`
  name their own swap conditions, so the code reads the same way at the call
  site as this ADR does at the planning level.
