/**
 * Pointer gesture state machine for the side chat overlay (spec #12/#13,
 * #24/#26): consumes raw SGR mouse events, produces `GestureAction[]` action
 * objects over two surfaces — the chat area and the input editor.
 *
 * The module is deliberately ignorant of the TUI, clipboard and editor: it
 * only classifies press/drag/double-/triple-click/wheel/right-click sequences
 * and reports WHAT happened and on WHICH surface; the overlay owns the
 * "action → render" translation. All coordinates handed to the injected hit
 * queries are 0-based screen coordinates (the SGR 1-based → 0-based
 * conversion happens here); positions the queries return live in each
 * surface's own coordinate space (chat cells or editor visual cells).
 */
import {
  isLeftDrag,
  isLeftPress,
  isLeftRelease,
  isRightPress,
  isRightRelease,
  isWheelEvent,
  wheelDirection,
  type SgrMouseEvent,
} from "./side-chat-mouse.ts";
import type { CellPos } from "./side-chat-messages.ts";
import type { EditorPos } from "./editor-selection.ts";

/**
 * Two (or three) quick presses within this window count as a multi-click
 * (double-click → word/line, triple-click → line), same surface only.
 */
export const DOUBLE_CLICK_INTERVAL_MS = 500;

/**
 * True when a drag release ended within the double-click tolerance (same
 * line, within a couple of cells). Real terminals report motion even for
 * 1-cell hand shake during a multi-click, so a selection this small is a
 * click, not a drag — it must not suppress the next press's multi-click
 * classification. Only the same line counts: a real cross-line drag of a
 * couple of cells stays a drag, never a click.
 */
export function selectionWithinClickTolerance(a: CellPos, b: CellPos): boolean {
  return a.line === b.line && Math.abs(a.col - b.col) <= 2;
}

/**
 * Drag-render coalescing: mouse motion events fire per cell moved, and every
 * render redraws the whole frame (main screen + overlay). Capping drag
 * renders to ~30fps keeps the highlight fluid without saturating the event
 * loop on long drags. The selection state still updates on every event;
 * only the paint is throttled, and the release always paints the final look.
 */
export const DRAG_RENDER_INTERVAL_MS = 32;

/**
 * The two selection surfaces the gesture module classifies over (spec #24).
 * Positions on each surface live in that surface's own coordinate space:
 * chat cells for "chat", editor visual cells for "editor".
 */
export type Surface = "chat" | "editor";

/**
 * One output of the gesture state machine. At most one action per event;
 * no-op situations (release outside the press area, right-click without a
 * selection, header/border hits) produce an empty array. Selection actions
 * carry the surface they act on; the overlay resolves surface-local geometry
 * (column bounds, word bounds) from its own state.
 */
export type GestureAction =
  | {
      kind: "select";
      surface: Surface;
      anchor: CellPos;
      focus: CellPos;
      /** False on throttled drag updates: the selection changed but the frame need not repaint. */
      paint: boolean;
    }
  | {
      kind: "selectLine";
      surface: Surface;
      /** Rendered line to select; column bounds are filled in by the overlay from its own geometry. */
      line: number;
    }
  | {
      kind: "selectWord";
      surface: Surface;
      /** Visual cell under the double-click; word bounds are resolved by the overlay (editor surface only). */
      line: number;
      col: number;
    }
  | { kind: "scroll"; lines: number }
  | { kind: "copy"; surface: Surface }
  | { kind: "paste" };

/**
 * Injected hit-testing queries (0-based screen coordinates). The module never
 * touches the TUI or the message store directly — the overlay supplies these
 * closures. `getSelectionAnchor` is a hard constraint: the authoritative copy
 * of the anchor lives in SideChatMessages (window-shift translation moves it),
 * so the module must read it back instead of hoarding a private copy.
 */
export interface PointerHit {
  /** Map a screen position to a chat cell, or null off the chat area (header/border). */
  chatAt(row: number, col: number): CellPos | null;
  /** Like chatAt but clamps into the chat area (drag overshoot). */
  clampToChat(row: number, col: number): CellPos;
  /** True when a screen row falls inside the input editor widget band. */
  overEditor(row: number, col: number): boolean;
  /** Map a screen position to an editor visual cell, or null off the editor content band. */
  editorAt(row: number, col: number): EditorPos | null;
  /** Like editorAt but clamps into the editor content band (drag overshoot). */
  clampToEditor(row: number, col: number): EditorPos;
  /** True when a non-empty chat selection is active (right-click copy precondition). */
  hasSelection(): boolean;
  /** The current chat selection anchor (window coordinates), or null when no selection. */
  getSelectionAnchor(): CellPos | null;
  /** True when a non-empty editor selection is active. */
  hasEditorSelection(): boolean;
  /** The current editor selection anchor, or null when no selection. */
  getEditorSelectionAnchor(): EditorPos | null;
}

export interface PointerGestureOptions {
  hit: PointerHit;
  /** D11 gate: when false, right presses are not recorded and releases produce no actions. */
  rightClickEnabled?: boolean;
  /** Editor-selection gate (spec #24): when false, left presses never classify onto the editor surface. */
  editorSelectionEnabled?: boolean;
  /** Wheel scroll step in lines (default 3, matching the previous mouse handler). */
  wheelScrollLines?: number;
  /** Clock for the click-count window and drag throttle (test seam; defaults to Date.now). */
  now?: () => number;
}

/**
 * Pointer gesture state machine. One instance per overlay; `onEvent` is
 * called for every SGR event routed to the overlay (the Ctrl+L modal gate
 * lives in the overlay, the module knows nothing about the modal).
 */
export class PointerGesture {
  /** Options with defaults already merged in (rightClickEnabled / editorSelectionEnabled / wheelScrollLines / now). */
  private readonly options: Required<PointerGestureOptions>;
  /** Set while a left-button selection drag is in progress. */
  private dragging = false;
  /** The surface the in-flight left drag is on (null when not dragging). */
  private surface: Surface | null = null;
  /** Right-press landed in the chat area; the copy action fires on release there. */
  private rightPressInChat = false;
  /** Right-press landed in the input editor; the paste action fires on release there. */
  private rightPressInEditor = false;
  private mouseAnchor: CellPos = { line: 0, col: 0 };
  private lastPressTime = 0;
  private lastPressPos: CellPos | null = null;
  /** The surface of the last press (a surface change resets the click count). */
  private lastPressSurface: Surface | null = null;
  /** Consecutive-click count of the current series (1–3), resolved at press time. */
  private clickCount = 1;
  /** The last release ended a drag; a quick follow-up click must not count as a multi-click. */
  private lastReleaseWasDrag = false;
  /** Timestamp of the last paint-triggering drag motion (coalescing). */
  private lastDragRenderAt = 0;

  constructor(options: PointerGestureOptions) {
    this.options = {
      rightClickEnabled: true,
      editorSelectionEnabled: true,
      wheelScrollLines: 3,
      now: () => Date.now(),
      ...options,
    };
  }

  /** Clamp a screen position into the active surface's coordinate space. */
  private clampTo(surface: Surface, row: number, col: number): CellPos {
    const { hit } = this.options;
    return surface === "chat"
      ? hit.clampToChat(row, col)
      : hit.clampToEditor(row, col);
  }

  /**
   * Read the selection anchor back from the active surface's store. The
   * authoritative copy of the chat anchor lives in SideChatMessages
   * (window-shift translation moves it mid-drag), so the module reads it back
   * instead of hoarding a private copy; the editor anchor needs no shift.
   */
  private selectionAnchor(surface: Surface): CellPos {
    const { hit } = this.options;
    const anchor =
      surface === "chat"
        ? hit.getSelectionAnchor()
        : hit.getEditorSelectionAnchor();
    return anchor ?? this.mouseAnchor;
  }

  /** True when the active surface holds a non-empty selection. */
  private hasSelection(surface: Surface): boolean {
    return surface === "chat"
      ? this.options.hit.hasSelection()
      : this.options.hit.hasEditorSelection();
  }

  /** Classify one SGR mouse event and return the actions it produces. */
  onEvent(event: SgrMouseEvent): GestureAction[] {
    const {
      hit,
      rightClickEnabled,
      editorSelectionEnabled,
      wheelScrollLines,
    } = this.options;

    if (isWheelEvent(event)) {
      return [
        { kind: "scroll", lines: wheelDirection(event) * wheelScrollLines },
      ];
    }

    if (isLeftPress(event)) {
      const row = event.row - 1;
      const col = event.col - 1;
      const chatPos = hit.chatAt(row, col);
      let surface: Surface;
      let pos: CellPos;
      if (chatPos) {
        surface = "chat";
        pos = chatPos;
      } else if (editorSelectionEnabled) {
        const editorPos = hit.editorAt(row, col);
        if (!editorPos) return [];
        surface = "editor";
        pos = editorPos;
      } else {
        return [];
      }
      const now = this.options.now();
      // Consecutive-click classification (spec #24/#26): the click count
      // advances only when this press lands on the same surface, within the
      // double-click window and tolerance, and the previous release was not a
      // drag. Any of those failing resets the count to a fresh single click.
      const isMultiClick =
        this.lastPressPos !== null &&
        this.lastPressSurface === surface &&
        !this.lastReleaseWasDrag &&
        now - this.lastPressTime <= DOUBLE_CLICK_INTERVAL_MS &&
        Math.abs(pos.line - this.lastPressPos.line) <= 1 &&
        Math.abs(pos.col - this.lastPressPos.col) <= 2;
      this.clickCount = isMultiClick ? Math.min(this.clickCount + 1, 3) : 1;
      this.dragging = true;
      this.surface = surface;
      this.mouseAnchor = pos;
      this.lastPressPos = pos;
      this.lastPressSurface = surface;
      this.lastPressTime = now;
      // Seed the selection with the anchor (empty range): the window-shift
      // translation in SideChatMessages.render then keeps the anchor aligned
      // with the same content when status/stream lines are appended mid-drag.
      return [{ kind: "select", surface, anchor: pos, focus: pos, paint: true }];
    }

    if (isLeftDrag(event)) {
      if (!this.dragging) return [];
      const surface = this.surface ?? "chat";
      const pos = this.clampTo(surface, event.row - 1, event.col - 1);
      const anchor = this.selectionAnchor(surface);
      // Coalesce drag paints: the selection state is always current (the next
      // render picks it up), only the number of full-frame redraws is capped.
      const now = this.options.now();
      const paint = now - this.lastDragRenderAt >= DRAG_RENDER_INTERVAL_MS;
      if (paint) this.lastDragRenderAt = now;
      return [{ kind: "select", surface, anchor, focus: pos, paint }];
    }

    if (isLeftRelease(event)) {
      if (!this.dragging) return [];
      this.dragging = false;
      const surface = this.surface ?? "chat";
      const clickCount = this.clickCount;
      const pos = this.clampTo(surface, event.row - 1, event.col - 1);

      if (clickCount === 2) {
        // Double-click (no auto-copy; the hotkey copies it): chat selects the
        // whole rendered line, the editor selects the word under the click
        // (word bounds resolved by the overlay from its own geometry).
        this.lastReleaseWasDrag = false;
        if (surface === "editor") {
          return [
            { kind: "selectWord", surface, line: pos.line, col: pos.col },
          ];
        }
        return [{ kind: "selectLine", surface, line: pos.line }];
      }

      if (clickCount === 3) {
        // Triple-click: select the whole rendered/visual line on both surfaces.
        this.lastReleaseWasDrag = false;
        return [{ kind: "selectLine", surface, line: pos.line }];
      }

      // clickCount === 1: a single press — either finalize a drag or end a click.
      if (this.hasSelection(surface)) {
        // Drag-release: finalize the selection (the anchor may have been
        // window-shifted by appended status/stream lines mid-drag). The
        // selection stays highlighted so Ctrl+C copies it (hotkey-only copy).
        const anchor = this.selectionAnchor(surface);
        // A selection that ends within the double-click tolerance is a click
        // with hand shake, not a drag: real terminals report motion (button 32)
        // even for 1-cell moves, so without this the tiniest movement while
        // multi-clicking marks the release as a drag and the next press is
        // never classified as a multi-click (bug: line/word-select never fires).
        this.lastReleaseWasDrag = !selectionWithinClickTolerance(anchor, pos);
        return [{ kind: "select", surface, anchor, focus: pos, paint: true }];
      }
      // Plain click without drag: the press-seeded empty selection (anchor === focus)
      // is inert (no highlight rendered), so no explicit clear action is needed;
      // left to be overwritten on the next press/scroll.
      this.lastReleaseWasDrag = false;
      return [];
    }

    if (isRightPress(event)) {
      // Track where the right press landed; the actual action fires on
      // release, so a press-then-move-out-then-release does nothing. The
      // feature switch (D11) disables both right-click branches entirely —
      // an unrecorded press leaves the release branch a no-op.
      if (rightClickEnabled) {
        this.rightPressInChat =
          hit.chatAt(event.row - 1, event.col - 1) !== null;
        this.rightPressInEditor = hit.overEditor(event.row - 1, event.col - 1);
      }
      return [];
    }

    if (isRightRelease(event)) {
      // Right-click (release-triggered), one shared hit branch: a press+release
      // over the chat area with an active mouse selection copies it; a
      // press+release over the input editor pastes the system clipboard. The
      // release position decides — pressing in one area and releasing in the
      // other does nothing, and a release elsewhere (header/border) is ignored.
      const pressInChat = this.rightPressInChat;
      const pressInEditor = this.rightPressInEditor;
      this.rightPressInChat = false;
      this.rightPressInEditor = false;
      if (pressInChat) {
        if (hit.chatAt(event.row - 1, event.col - 1) === null) return [];
        if (!hit.hasSelection()) return [];
        return [{ kind: "copy", surface: "chat" }];
      }
      if (pressInEditor) {
        if (!hit.overEditor(event.row - 1, event.col - 1)) return [];
        return [{ kind: "paste" }];
      }
      return [];
    }

    return [];
  }

  /** True while a left-button drag is captured (events stay consumed even off-overlay). */
  isDragging(): boolean {
    return this.dragging;
  }

  /**
   * Abort an in-flight drag without waiting for the release (used when the
   * overlay is hidden mid-drag and mouse reporting is turned off). Resets
   * only module state; clearing the message selection is the overlay's job.
   */
  cancel(): void {
    this.dragging = false;
    this.surface = null;
    this.rightPressInChat = false;
    this.rightPressInEditor = false;
    // The next press after an aborted drag is a fresh single click, never a
    // continuation of a multi-click series.
    this.clickCount = 1;
    this.lastReleaseWasDrag = true;
  }
}
