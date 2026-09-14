# Editor selection is a separate, transient, visual-line-space model from chat selection

When drag-select + hotkey copy was extended to the input editor (a pi-tui `Editor`
widget with no public selection/highlight API), we chose to model editor
selection as its own holder (`srcs/editor-selection.ts`) distinct from
`SideChatMessages`' chat selection, living in editor visual-line space with a
transient lifecycle (cleared by any non-drag editor input or a plain click), and
never crossing a paste marker. The `PointerGesture` module was generalized with a
second surface via a `surface` discriminator on `select`/`selectLine`/`selectWord`/
`copy` actions and a second `PointerHit` query set (`editorAt` / `clampToEditor` /
`hasEditorSelection` / `getEditorSelectionAnchor`), keeping the module a pure
classifier over two abstract surfaces rather than teaching it about the editor or
clipboard.

## Considered options

- **Unified single model in `SideChatMessages`** (rejected): the chat selection's
  anchor lives in messages for window-shift translation during a drag, its
  coordinates are message-rendered lines, and it persists until overwritten.
  Editor selection has none of those properties — it lives in wrapped visual-line
  space, must vanish on the next keystroke, and must be clipped at paste-marker
  boundaries. Folding both into one holder would force it to manage two
  coordinate spaces and two lifecycles, blurring the existing spec #22 contract.
- **Editor-drag logic in the overlay, `PointerGesture` untouched** (rejected):
  would duplicate the press/drag/double-/triple-click classification for one more
  surface instead of generalizing the existing state machine with a second query
  set.

## Consequences

- Two selections can coexist in state; cross-surface exclusivity (a new drag on
  either surface clears the other) is enforced at the overlay's
  `applyGestureAction` translation, not in the module.
- `Ctrl+C` routing gains a third tier (chat selection → editor selection → clear
  input), preserving spec #22's "copy consumes the selection → Ctrl+C returns to
  clearing" chain.
- Highlight is rendered by post-processing `Editor.render()` output
  (`decorateEditorSelection`) since the widget exposes no selection API; this seam
  must track the editor's visual-line layout (and is disabled while the editor's
  autocomplete popup is showing to avoid row-index drift).
