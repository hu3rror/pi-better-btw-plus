# Fork surface mouse routing: fullscreen via pi component dispatch, regular via captured SGR

pi 1.0.0 (2026-10-01) made fullscreen the default TUI mode. The side chat's mouse
model — designed for regular mode, where the extension owns the terminal's raw
xterm reporting stream — silently broke in fullscreen: a double-click inside the
fork selected *main-agent* text and (with `fullscreenCopyOnSelect` defaulting to
true) auto-copied it to the system clipboard. This ADR records why, and the
dual-channel routing model that replaces the single SGR channel.

## Context: the failure chain in fullscreen

`TuiAltScreen` (`mode: "fullscreen"`) owns the viewport. Its `handleViewportInput`
consumes every parsed SGR mouse sequence (`{ consume: true }`), so the
extension's `tui.addInputListener` SGR channel never fires in fullscreen — the
comment in `srcs/index.ts` already stated this. Pi instead reroutes mouse events
through its component dispatch: `TuiBase.dispatchMouseToOverlay` (driven by
`renderedOverlayLayouts`, populated during fullscreen compositing) sends events
whose coordinates fall inside a visible overlay to that overlay's
`component.handleMouse(event)`.

`SideChatOverlay` implements `Component` and `Focusable` (public pi-tui
interfaces) but only `render` and `handleInput` — no `handleMouse`. Every event
inside the fork therefore fell through to pi's own `handleSelectionMouseEvent`,
which anchors text selection on the **underlying Pi transcript** at those screen
coordinates (the fork visually covers the document rows; the document cells
underneath are still the main session's). Release with `fullscreenCopyOnSelect:
true` (the default, `settings.md`) copied that main-agent text to the clipboard.
The same root cause broke, in fullscreen: drag/double/triple-click selection on
both the chat and the input-editor surfaces, right-click copy/paste (on win32 it
fell into pi's own right-click-paste-to-main-editor), and wheel-over-fork when
the fork was not focused (scrolled the main transcript).

## Decision

1. **The fork owns every event in its region, in both modes.** `SideChatOverlay`
   implements `Component.handleMouse` and returns a non-undefined result for
   every event dispatched into the fork: `handled: true` for all types (including
   no-op clicks, header/border hits included), `focus: true` on left-press
   (matches the regular-mode `isLeftPress` focus rule), `capture: true` on
   left-press (pi's `mouseCapture` keeps drags clamped to the fork surface even
   when the pointer leaves it). Returning results keeps pi's
   `mousePressTarget` / `mouseCapture` / `getComponentClickCount` bookkeeping
   coherent, and pi never starts its own selection in-region.
2. **One classifier, two feeds, pi's extra metadata ignored.** A thin adapter
   module translates `TuiMouseEvent` (type press/drag/release, decoded button,
   absolute `screenX/screenY`; `click`/`move` absorbed) into the existing
   `SgrMouseEvent` vocabulary and feeds `PointerGesture` unchanged. Pi's
   `clickCount` (arrives on a separate `click` event *after* release and demands
   pixel-identical press positions) and `wheelDelta` (already multiplied by pi's
   `fullscreenWheelScrollLines`, ×5 with Alt) are ignored: btw's own
   multi-click classifier (±1 line / ±2 cols, 500 ms) and its
   `wheelScrollLines` setting remain the single truth. The classifier and its
   table tests are untouched; both modes behave byte-identically.
3. **Mouse reporting ownership is mode-bound.** In fullscreen, the extension
   never writes xterm reporting enable/disable sequences — pi owns the stream
   and overlay visibility already gates dispatch. In regular mode the extension
   keeps the SGR channel exactly as today. Rationale: the extension's
   `MOUSE_DISABLE` (`1006l`/`1002l`/`1000l`) overlaps pi's own enable set, and
   pi re-enables reporting only at alt-screen entry — a hide/close mid-session
   would kill pi's fullscreen mouse until the alt screen re-enters.
4. **No semantic changes across modes**: layout (top-center, up to 88%),
   double/triple-click granularity (chat → whole rendered line, editor → word /
   line), and copy semantics (hotkey/right-click only) stay identical in
   regular and fullscreen. The one opt-in difference:
   `features.fullscreenCopyOnSelect` (default `false`, active only in
   fullscreen) mirrors pi's copy-on-select inside the fork — a release that
   just formed a selection copies it **without consuming it**, so the
   highlight survives as the copy's source.

## Verified facts (implementation references, pi-tui 1.0.2)

- `TuiAltScreen.handleViewportInput` consumes every parsed SGR event
  (`dist/tui-alt-screen.js` L470-520); wheel is deferred to later input
  listeners only while an overlay is focused (`shouldDeferViewportInputToOverlay`).
- `handleMouseEvent` (L694+) dispatches to the visually topmost overlay under the
  pointer (`dispatchMouseToOverlay`, `tui.js` L508, driven by
  `renderedOverlayLayouts` from `compositeOverlays` at alt-screen render L1449);
  with no overlay result it falls to `handleSelectionMouseEvent` (L1085) and
  `if (this.copyOnSelect) copySelectionToClipboard()` on release (L1132).
- `TuiMouseEvent` contract (`tui.d.ts` L13): type `press|release|move|drag|click|
  wheel`, decoded `button`, local `x/y` plus absolute `screenX/screenY`, optional
  `wheelDelta`/`clickCount`; `getComponentClickCount` (L800) demands identical
  press positions, 500 ms window.
- `wheelDelta` sign: negative scrolls up — the d.ts documents it and it derives
  from pi's own SGR direction (`parseWheelEvent` maps wheel-up button 64 to
  direction -1, then `wheelDelta = direction * lines`); the adapter therefore
  maps negative → SGR wheel button 64 (up), positive → 65 (down).
- `Component.handleMouse?` is public (`tui.d.ts` L78); `TUI.mode` is public
  (`tui.d.ts` L214, `"regular" | "fullscreen"`).
- Extension `MOUSE_DISABLE` (`srcs/side-chat-mouse.ts`) overlaps pi's
  `ENABLE_BUTTON_MOTION_MOUSE` set; pi enables at enter-alt-screen (L189) and
  disables only at exit (L201).

## SWAP POINT

`Component.handleMouse` and `TUI.mode` are public but young interfaces — verified
against pi-tui 1.0.2 (devDep and runtime). No private surface is patched (unlike
ADR 0009's runner patch). Re-verify on every pi-tui bump; if pi later offers a
first-class overlay mouse contract (e.g. normalized wheel steps / click counts
for all overlays), the adapter simplifies to a pure passthrough.

## Test strategy

- Fullscreen seam tests (`test/fullscreen-mouse.test.ts`): one entry point —
  `SideChatOverlay.handleMouse(TuiMouseEvent)` driven with pi-style events via
  the make-overlay harness (mock TUI gains `mode`) — covering press / drag /
  release / wheel / move / click, in-region no-ops, right press (no focus),
  capture/focus flags, the defensive regular-mode gate, and the opt-in
  copy-on-select mirror.
- Existing `pointer-gesture.test.ts` stays untouched as the classifier contract.
- `docs/manual-testing.md` gains a fullscreen matrix: drag / double / triple /
  right-click / wheel / Alt+W / close, once over the fork region and once over
  the main region.

## Considered options

- **Disable fork mouse in fullscreen (degrade)**: rejected — a feature
  regression for every existing mouse convenience.
- **Patch pi-tui to defer SGR to the extension**: rejected — a private-surface
  patch (ADR 0009 discipline), and duplicate routing state.
- **Adopt pi's `clickCount`/`wheelDelta` as fullscreen truth**: rejected — mode
  split in double-click tolerance (0-cell vs the classifier's 2-cell) and wheel
  step (pi's per-platform default vs `wheelScrollLines: 3`); behavior would
  differ depending only on which mode is active.