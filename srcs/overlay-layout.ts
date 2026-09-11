/**
 * Overlay layout — single source of truth for how the side chat occupies the
 * terminal (spec #16 / ticket #17). Zero TUI / zero pi-tui runtime dependency
 * (types only): pure (terminal size, frame size) → geometry functions, table
 * tested in test/overlay-layout.test.ts.
 *
 * Previously the layout knowledge lived in three hand-synced copies: the inline
 * overlayOptions in index.ts ("85%" + bare margins), the overlay's private
 * ChatGeometry math mirroring pi's resolver, and getViewport's own
 * maxHeight/percent/clamp. Now rendering, mouse hit-testing and the mouse
 * viewport all derive from LAYOUT + these functions, so a one-line LAYOUT
 * change propagates everywhere together.
 */
import type { OverlayAnchor, OverlayOptions, SizeValue } from "@earendil-works/pi-tui";

/**
 * The side chat's overlay options — the single layout spec. Consumed verbatim
 * by index.ts (ui.custom overlayOptions) and by the geometry functions below.
 */
export const LAYOUT: OverlayOptions = {
  width: "85%",
  maxHeight: "88%",
  anchor: "top-center",
  margin: { top: 1, left: 2, right: 2 },
  nonCapturing: true,
};

/** Frame rows above the message area: top border, header, separator. */
export const FRAME_HEADER_LINES = 3;
/**
 * Frame cells between the outer box edge and the message content, per side
 * (border cell + padding cell). Content starts at outer col + 2 and the
 * message area is outer width − 4 wide.
 */
export const FRAME_SIDE_PADDING = 2;

/** Screen geometry of the overlay widgets (0-based terminal coordinates). */
export interface ChatGeometry {
  /** Screen row of the first message line. */
  msgTopRow: number;
  /** Screen column of the first message cell (inside the left border). */
  contentCol: number;
  /** Message area width in cells. */
  innerWidth: number;
  /** Number of visible message lines. */
  msgHeight: number;
  /** Screen row of the input editor widget's top border. */
  editorTopRow: number;
  /** Height of the input editor widget in rows (border + content + border). */
  editorHeight: number;
}

/** Screen band the overlay occupies, used to route mouse events to the chat. */
export interface OverlayViewport {
  topRow: number;
  height: number;
}

/** Result of resolving the overlay box, mirroring pi's resolver return shape. */
export interface ResolvedOverlayLayout {
  width: number;
  row: number;
  col: number;
  /** Undefined when the options set no maxHeight (no clamp). */
  maxHeight: number | undefined;
}

/** pi's margin branch: number applies to all sides, object per side, clamped ≥ 0. */
function layoutMargins(
  options: OverlayOptions,
): { top: number; right: number; bottom: number; left: number } {
  const margin =
    typeof options.margin === "number"
      ? { top: options.margin, right: options.margin, bottom: options.margin, left: options.margin }
      : (options.margin ?? {});
  return {
    top: Math.max(0, margin.top ?? 0),
    right: Math.max(0, margin.right ?? 0),
    bottom: Math.max(0, margin.bottom ?? 0),
    left: Math.max(0, margin.left ?? 0),
  };
}

/** pi's parseSizeValue: absolute numbers pass through, "NN%" floors to cells. */
function parseSizeValue(value: SizeValue | undefined, reference: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value;
  const match = /^(\d+(?:\.\d+)?)%$/.exec(value);
  if (!match) return undefined;
  return Math.floor((reference * parseFloat(match[1])) / 100);
}

/**
 * Mirror of pi's resolveOverlayLayout maxHeight branch (parse + clamp to
 * available height). Factored out of {@link resolveLayout} because
 * computeOverlayViewport needs the same value — the percent/clamp math has
 * exactly one home in this module instead of the old getViewport's third copy.
 */
function resolveOverlayMaxHeight(options: OverlayOptions, termHeight: number): number | undefined {
  const { top, bottom } = layoutMargins(options);
  const availHeight = Math.max(1, termHeight - top - bottom);
  const parsed = parseSizeValue(options.maxHeight, termHeight);
  if (parsed === undefined) return undefined;
  return Math.max(1, Math.min(parsed, availHeight));
}

/** pi's resolveAnchorRow: row anchor semantics (all anchor variants). */
function resolveAnchorRow(
  anchor: OverlayAnchor,
  height: number,
  availHeight: number,
  marginTop: number,
): number {
  switch (anchor) {
    case "top-left":
    case "top-center":
    case "top-right":
      return marginTop;
    case "bottom-left":
    case "bottom-center":
    case "bottom-right":
      return marginTop + availHeight - height;
    case "left-center":
    case "center":
    case "right-center":
      return marginTop + Math.floor((availHeight - height) / 2);
  }
}

/** pi's resolveAnchorCol: column anchor semantics (all anchor variants). */
function resolveAnchorCol(
  anchor: OverlayAnchor,
  width: number,
  availWidth: number,
  marginLeft: number,
): number {
  switch (anchor) {
    case "top-left":
    case "left-center":
    case "bottom-left":
      return marginLeft;
    case "top-right":
    case "right-center":
    case "bottom-right":
      return marginLeft + availWidth - width;
    case "top-center":
    case "center":
    case "bottom-center":
      return marginLeft + Math.floor((availWidth - width) / 2);
  }
}

/**
 * Resolve the overlay's outer box — a mirror of pi-tui's private
 * TuiBase.resolveOverlayLayout, verified byte-identical between the versions
 * this extension runs against: pi-tui 0.84.2 (dist/tui.js L679-800, devDep)
 * and 0.85.1 (dist/tui.js L781-902, runtime); parseSizeValue 0.84.2 L24-35 /
 * 0.85.1 L57-68.
 *
 * SWAP POINT: if pi ever exposes this resolver publicly, replace the whole
 * body with `return resolveOverlayLayout(options, frameHeight, termWidth,
 * termHeight);` — the mirror's tests keep guarding the behavior either way.
 *
 * @param termWidth terminal columns
 * @param termHeight terminal rows
 * @param frameHeight the overlay's rendered height (used for the anchor row and
 *   the final clamp, exactly like pi's second resolveOverlayLayout call)
 * @param options the overlay options to resolve; defaults to {@link LAYOUT}
 */
export function resolveLayout(
  termWidth: number,
  termHeight: number,
  frameHeight: number,
  options: OverlayOptions = LAYOUT,
): ResolvedOverlayLayout {
  const { top: marginTop, right: marginRight, bottom: marginBottom, left: marginLeft } =
    layoutMargins(options);
  const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
  const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

  // width: parse, then minWidth, then clamp to available space.
  let width = parseSizeValue(options.width, termWidth) ?? Math.min(80, availWidth);
  if (options.minWidth !== undefined) width = Math.max(width, options.minWidth);
  width = Math.max(1, Math.min(width, availWidth));

  // maxHeight + effective overlay height (clamped by maxHeight).
  const maxHeight = resolveOverlayMaxHeight(options, termHeight);
  const effectiveHeight =
    maxHeight !== undefined ? Math.min(frameHeight, maxHeight) : frameHeight;

  // row: explicit (percent/absolute) or anchor-based.
  let row: number;
  if (options.row !== undefined) {
    if (typeof options.row === "string") {
      const match = /^(\d+(?:\.\d+)?)%$/.exec(options.row);
      if (match) {
        const maxRow = Math.max(0, availHeight - effectiveHeight);
        row = marginTop + Math.floor(maxRow * (parseFloat(match[1]) / 100));
      } else {
        row = resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
      }
    } else {
      row = options.row;
    }
  } else {
    row = resolveAnchorRow(options.anchor ?? "center", effectiveHeight, availHeight, marginTop);
  }

  // col: explicit (percent/absolute) or anchor-based.
  let col: number;
  if (options.col !== undefined) {
    if (typeof options.col === "string") {
      const match = /^(\d+(?:\.\d+)?)%$/.exec(options.col);
      if (match) {
        const maxCol = Math.max(0, availWidth - width);
        col = marginLeft + Math.floor(maxCol * (parseFloat(match[1]) / 100));
      } else {
        col = resolveAnchorCol("center", width, availWidth, marginLeft);
      }
    } else {
      col = options.col;
    }
  } else {
    col = resolveAnchorCol(options.anchor ?? "center", width, availWidth, marginLeft);
  }

  // Offsets, then clamp to terminal bounds (respecting margins).
  if (options.offsetY !== undefined) row += options.offsetY;
  if (options.offsetX !== undefined) col += options.offsetX;
  row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
  col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));

  return { width, row, col, maxHeight };
}

/**
 * Chat area geometry for mouse hit-testing: the overlay's outer box (from
 * resolveLayout, so rendering and hit-testing can never drift) plus the named
 * frame offsets — messages start after the header, content cells after the
 * side padding, and the input editor band sits below the message separator.
 *
 * @param termCols terminal columns
 * @param termRows terminal rows (the outer row/col depend on it for non-top
 *   anchors, so it is passed through to resolveLayout — keep it real)
 * @param msgHeight rendered message lines
 * @param editorHeight rendered editor lines
 */
export function computeChatGeometry(
  termCols: number,
  termRows: number,
  msgHeight: number,
  editorHeight: number,
): ChatGeometry {
  // Frame's own height: header (FRAME_HEADER_LINES) + messages + editor +
  // footer chrome (separator + hints + bottom border). pi resolves row/col with
  // the rendered overlay height (tui.js L815-823); for the fixed top-center
  // LAYOUT the exact estimate cannot change the result (row pins to marginTop,
  // col centers on width), so this only stands in for that second call.
  const frameHeight = msgHeight + editorHeight + FRAME_HEADER_LINES * 2;
  const { width, row, col } = resolveLayout(termCols, termRows, frameHeight);
  return {
    msgTopRow: row + FRAME_HEADER_LINES,
    contentCol: col + FRAME_SIDE_PADDING,
    innerWidth: width - FRAME_SIDE_PADDING * 2,
    msgHeight,
    // Separator after the messages sits at msgTopRow + msgHeight; the input
    // editor widget band starts on the next row.
    editorTopRow: row + FRAME_HEADER_LINES + msgHeight + 1,
    editorHeight,
  };
}

/**
 * Chat area height (message lines): 2.5x the original (~0.35 * rows - 10),
 * adapted to small terminals so the overlay never overflows the screen and
 * always leaves a few rows of the main editor visible.
 */
export function computeSideChatHeight(rows: number): number {
  const original = Math.max(3, Math.floor(rows * 0.35) - 10);
  const desired = Math.round(original * 2.5);
  // 7 fixed rows (borders, header, editor, hints) around the message area.
  const overlayCap = Math.max(9, Math.min(Math.floor(rows * 0.88), rows - 4));
  return Math.max(3, Math.min(desired, overlayCap - 7));
}

/**
 * Screen band the overlay occupies, used to route mouse events to the chat.
 * The maxHeight comes from the same percent+clamp branch as resolveLayout
 * (resolveOverlayMaxHeight) — the overlay no longer keeps its own copy; pi
 * itself clamps the rendered overlay to maxHeight at composition time
 * (tui.js L819-821), so the band is lastRenderHeight capped by maxHeight.
 */
export function computeOverlayViewport(
  termRows: number,
  lastRenderHeight: number,
): OverlayViewport {
  const maxHeight = resolveOverlayMaxHeight(LAYOUT, termRows);
  return {
    topRow: layoutMargins(LAYOUT).top,
    height: maxHeight === undefined ? lastRenderHeight : Math.min(lastRenderHeight, maxHeight),
  };
}
