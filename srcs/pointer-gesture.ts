/**
 * Pointer gesture state machine for the side chat overlay (spec #12/#13):
 * consumes raw SGR mouse events, produces `GestureAction[]` action objects.
 *
 * The module is deliberately ignorant of the TUI, clipboard and editor: it
 * only classifies press/drag/double-click/wheel/right-click sequences and
 * reports WHAT happened; the overlay owns the "action → render" translation.
 * All coordinates handed to the injected hit queries are 0-based screen
 * coordinates (the SGR 1-based → 0-based conversion happens here).
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

/** Two quick presses within this window (same line) count as a double-click → select line. */
export const DOUBLE_CLICK_INTERVAL_MS = 500;

/**
 * True when a drag release ended within the double-click tolerance (same
 * line, within a couple of cells). Real terminals report motion even for
 * 1-cell hand shake during a double-click, so a selection this small is a
 * click, not a drag — it must not suppress the next press's double-click
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
 * One output of the gesture state machine. At most one action per event;
 * no-op situations (release outside the press area, right-click without a
 * selection, header/border hits) produce an empty array.
 */
export type GestureAction =
  | {
      kind: "select";
      anchor: CellPos;
      focus: CellPos;
      /** False on throttled drag updates: the selection changed but the frame need not repaint. */
      paint: boolean;
    }
  | {
      kind: "selectLine";
      /** Rendered line to select; column bounds are filled in by the overlay from its own geometry. */
      line: number;
    }
  | { kind: "scroll"; lines: number }
  | { kind: "copy" }
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
  /** True when a non-empty selection is active (right-click copy precondition). */
  hasSelection(): boolean;
  /** The current selection anchor (window coordinates), or null when no selection. */
  getSelectionAnchor(): CellPos | null;
}

export interface PointerGestureOptions {
  hit: PointerHit;
  /** D11 gate: when false, right presses are not recorded and releases produce no actions. */
  rightClickEnabled?: boolean;
  /** Wheel scroll step in lines (default 3, matching the previous mouse handler). */
  wheelScrollLines?: number;
  /** Clock for the double-click window and drag throttle (test seam; defaults to Date.now). */
  now?: () => number;
}

/**
 * Pointer gesture state machine. One instance per overlay; `onEvent` is
 * called for every SGR event routed to the overlay (the Alt+M modal gate
 * lives in the overlay, the module knows nothing about the modal).
 */
export class PointerGesture {
  /** Options with defaults already merged in (rightClickEnabled / wheelScrollLines / now). */
  private readonly options: Required<PointerGestureOptions>;
  /** Set while a left-button selection drag is in progress. */
  private dragging = false;
  /** Right-press landed in the chat area; the copy action fires on release there. */
  private rightPressInChat = false;
  /** Right-press landed in the input editor; the paste action fires on release there. */
  private rightPressInEditor = false;
  private mouseAnchor: CellPos = { line: 0, col: 0 };
  private lastPressTime = 0;
  private lastPressPos: CellPos | null = null;
  private pendingDoubleClick = false;
  /** The last release ended a drag; a quick follow-up click must not count as a double-click. */
  private lastReleaseWasDrag = false;
  /** Timestamp of the last paint-triggering drag motion (coalescing). */
  private lastDragRenderAt = 0;

  constructor(options: PointerGestureOptions) {
    this.options = {
      rightClickEnabled: true,
      wheelScrollLines: 3,
      now: () => Date.now(),
      ...options,
    };
  }

  /** Classify one SGR mouse event and return the actions it produces. */
  onEvent(event: SgrMouseEvent): GestureAction[] {
    const { hit, rightClickEnabled, wheelScrollLines } = this.options;

    if (isWheelEvent(event)) {
      return [
        { kind: "scroll", lines: wheelDirection(event) * wheelScrollLines },
      ];
    }

    if (isLeftPress(event)) {
      const pos = hit.chatAt(event.row - 1, event.col - 1);
      if (!pos) return [];
      const now = this.options.now();
      const doubleClick =
        this.lastPressPos !== null &&
        !this.lastReleaseWasDrag &&
        now - this.lastPressTime <= DOUBLE_CLICK_INTERVAL_MS &&
        Math.abs(pos.line - this.lastPressPos.line) <= 1 &&
        Math.abs(pos.col - this.lastPressPos.col) <= 2;
      this.dragging = true;
      this.mouseAnchor = pos;
      this.lastPressPos = pos;
      this.lastPressTime = now;
      this.pendingDoubleClick = doubleClick;
      // Seed the selection with the anchor (empty range): the window-shift
      // translation in SideChatMessages.render then keeps the anchor aligned
      // with the same content when status/stream lines are appended mid-drag.
      return [{ kind: "select", anchor: pos, focus: pos, paint: true }];
    }

    if (isLeftDrag(event)) {
      if (!this.dragging) return [];
      const pos = hit.clampToChat(event.row - 1, event.col - 1);
      const anchor = hit.getSelectionAnchor() ?? this.mouseAnchor;
      // Coalesce drag paints: the selection state is always current (the next
      // render picks it up), only the number of full-frame redraws is capped.
      const now = this.options.now();
      const paint = now - this.lastDragRenderAt >= DRAG_RENDER_INTERVAL_MS;
      if (paint) this.lastDragRenderAt = now;
      return [{ kind: "select", anchor, focus: pos, paint }];
    }

    if (isLeftRelease(event)) {
      if (!this.dragging) return [];
      this.dragging = false;
      if (this.pendingDoubleClick) {
        // Double-click: select the whole rendered line (no auto-copy; the
        // hotkey copies it).
        this.pendingDoubleClick = false;
        this.lastReleaseWasDrag = false;
        const pos = hit.clampToChat(event.row - 1, event.col - 1);
        return [{ kind: "selectLine", line: pos.line }];
      }
      this.pendingDoubleClick = false;
      const pos = hit.clampToChat(event.row - 1, event.col - 1);
      if (hit.hasSelection()) {
        // Drag-release: finalize the selection (the anchor may have been
        // window-shifted by appended status/stream lines mid-drag). The
        // selection stays highlighted so Ctrl+C copies it (hotkey-only copy).
        const anchor = hit.getSelectionAnchor() ?? this.mouseAnchor;
        // A selection that ends within the double-click tolerance is a click
        // with hand shake, not a drag: real terminals report motion (button 32)
        // even for 1-cell moves, so without this the tiniest movement while
        // double-clicking marks the release as a drag and the second press is
        // never classified as a double-click (bug: line-select never fires).
        this.lastReleaseWasDrag = !selectionWithinClickTolerance(anchor, pos);
        return [{ kind: "select", anchor, focus: pos, paint: true }];
      }
      // Plain click without drag: the press-seeded empty selection (anchor === focus)
      // is inert (hasSelection() === false, no highlight rendered), so no explicit
      // clear action is needed; left to be overwritten on the next press/scroll.
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
        return [{ kind: "copy" }];
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
    this.rightPressInChat = false;
    this.rightPressInEditor = false;
    this.pendingDoubleClick = false;
  }
}
