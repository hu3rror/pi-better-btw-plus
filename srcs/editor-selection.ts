/**
 * Editor selection: a zero-TUI, visual-space selection model for the side chat's
 * input editor (pi-tui `Editor`), spec #24 / T1 (#25).
 *
 * The `Editor` widget exposes no selection or highlight API and keeps its
 * word-wrap map and scroll offset private, so selection lives in *visual/screen
 * space*: an anchor/focus pair of `{line, col}` positions relative to the
 * editor's content band — the lines of `Editor.render(width)` between the top
 * and bottom border rows (top border excluded, so band line 0 is `rendered[1]`).
 * Columns are cell columns (visible width), grapheme-aligned so a wide/CJK
 * grapheme is never split, and every range is clipped so it never includes a
 * paste-marker literal (`[paste #N …]`).
 *
 * Everything here is pure and unit-testable; the overlay (T3/T4) wires the
 * `EditorSelectionState` holder and `decorateEditorSelection` into `render()`.
 */
import {
  findWordBackward,
  findWordForward,
} from "@earendil-works/pi-tui/dist/word-navigation.js";
import {
  sliceByColumn,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";

/** A position in editor visual space. */
export interface EditorPos {
  /** Visual line index within the editor content band (0-based, top border excluded). */
  line: number;
  /** Cell column (visible width, 0-based), grapheme-aligned. */
  col: number;
}

/** A visual-space selection over the editor content band. */
export interface EditorSelection {
  anchor: EditorPos;
  focus: EditorPos;
}

/** One visual line's inverse-video highlight range (content-band coordinates). */
export interface EditorHighlightRange {
  /** Content-band line index. */
  line: number;
  /** Start cell column (inclusive). */
  start: number;
  /** End cell column (exclusive). */
  end: number;
}

// Paste markers the editor inserts for large pastes (mirrors the editor's own
// `PASTE_MARKER_REGEX`). Selection must never include their literal text.
const PASTE_MARKER_GLOBAL = /\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g;
const PASTE_MARKER_SINGLE = /^\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]$/;

const SELECTION_ON = "\x1b[7m";
const SELECTION_OFF = "\x1b[27m";

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

function isPasteMarkerText(segment: string): boolean {
  return segment.length >= 10 && PASTE_MARKER_SINGLE.test(segment);
}

/** Cell-column spans of every paste-marker literal in a plain line. */
function pasteMarkerSpans(
  plain: string,
): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  for (const m of plain.matchAll(PASTE_MARKER_GLOBAL)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    spans.push({
      start: visibleWidth(plain.slice(0, start)),
      end: visibleWidth(plain.slice(0, end)),
    });
  }
  return spans;
}

/** Map a cell column to the code-unit index of the grapheme containing it. */
function colToCharIndex(plain: string, col: number): number {
  let width = 0;
  for (const seg of graphemeSegmenter.segment(plain)) {
    const w = visibleWidth(seg.segment);
    if (width + w > col) return seg.index;
    width += w;
  }
  return plain.length;
}

/** Snap a cell column to a grapheme boundary ("start" floors, "end" ceils). */
function snapCol(plain: string, col: number, which: "start" | "end"): number {
  let width = 0;
  for (const { segment } of graphemeSegmenter.segment(plain)) {
    const w = visibleWidth(segment);
    const gStart = width;
    const gEnd = width + w;
    if (col > gStart && col < gEnd) return which === "start" ? gStart : gEnd;
    width = gEnd;
  }
  return col;
}

/** Clamp a cell column into [0, lineWidth]. */
function clampCol(col: number, width: number): number {
  return Math.max(0, Math.min(col, width));
}

/** Clip a cell range so it never includes a paste-marker literal. */
function clipRangeToMarkers(
  start: number,
  end: number,
  plain: string,
): { start: number; end: number } {
  let s = start;
  let e = end;
  for (const span of pasteMarkerSpans(plain)) {
    if (span.end <= s) continue; // marker entirely before the range
    if (span.start >= e) break; // markers are sorted; the rest are after
    if (span.start <= s && span.end >= e) return { start: s, end: s }; // fully inside
    if (span.start <= s) s = span.end; // marker covers the start
    else if (span.end >= e) e = span.start; // marker covers the end
    else e = span.start; // marker strictly inside → keep the left part
    if (s >= e) return { start: s, end: s };
  }
  return { start: s, end: e };
}

/** Topmost/leftmost endpoint of a selection. */
export function orderedStart(sel: EditorSelection): EditorPos {
  const { anchor, focus } = sel;
  if (
    anchor.line < focus.line ||
    (anchor.line === focus.line && anchor.col <= focus.col)
  ) {
    return anchor;
  }
  return focus;
}

/** Bottommost/rightmost endpoint of a selection. */
export function orderedEnd(sel: EditorSelection): EditorPos {
  const { anchor, focus } = sel;
  if (
    anchor.line > focus.line ||
    (anchor.line === focus.line && anchor.col > focus.col)
  ) {
    return anchor;
  }
  return focus;
}

/**
 * The editor content band: `Editor.render()` output with the top/bottom border
 * rows dropped, ANSI stripped, and trailing padding trimmed. Assumes the
 * overlay's editor config (`paddingX: 0`), so padding is trailing only.
 */
export function contentBandPlainLines(rendered: string[]): string[] {
  return rendered.slice(1, -1).map((l) => stripTerminalSequences(l).trimEnd());
}

/**
 * Per-visual-line inverse-video highlight ranges for a selection. Columns are
 * clamped to each line's visible width, snapped to grapheme boundaries, and
 * clipped so the range never crosses a paste marker.
 */
export function highlightRanges(
  plainLines: string[],
  sel: EditorSelection,
): EditorHighlightRange[] {
  const n = plainLines.length;
  if (n === 0) return [];
  const start = orderedStart(sel);
  const end = orderedEnd(sel);
  const first = Math.max(0, Math.min(start.line, n - 1));
  const last = Math.max(0, Math.min(end.line, n - 1));
  const ranges: EditorHighlightRange[] = [];
  for (let line = first; line <= last; line++) {
    const text = plainLines[line] ?? "";
    const width = visibleWidth(text);
    let s = line === start.line ? clampCol(start.col, width) : 0;
    let e = line === end.line ? clampCol(end.col, width) : width;
    if (s >= e) continue;
    s = snapCol(text, s, "start");
    e = snapCol(text, e, "end");
    const clipped = clipRangeToMarkers(s, e, text);
    if (clipped.end > clipped.start) {
      ranges.push({ line, start: clipped.start, end: clipped.end });
    }
  }
  return ranges;
}

/**
 * Copy text for a selection: each selected line is stripped to plain text and
 * sliced by cell column, then lines are joined with `\n` in top-to-bottom
 * reading order (soft wraps become hard newlines — accepted v1 behavior).
 */
export function selectedText(plainLines: string[], sel: EditorSelection): string {
  return highlightRanges(plainLines, sel)
    .map((r) => sliceByColumn(plainLines[r.line] ?? "", r.start, r.end - r.start))
    .join("\n");
}

// Word navigation mirroring the editor's own word-jump semantics: paste markers
// are merged into atomic segments (the editor's `segmentWithMarkers`), so
// findWordBackward/Forward treat a marker as a single unit and never land
// mid-marker.
function wordSegments(text: string): Intl.SegmentData[] {
  if (!text.includes("[paste #")) return [...wordSegmenter.segment(text)];
  const markers: Array<{ start: number; end: number }> = [];
  for (const m of text.matchAll(PASTE_MARKER_GLOBAL)) {
    const start = m.index ?? 0;
    markers.push({ start, end: start + m[0].length });
  }
  if (markers.length === 0) return [...wordSegmenter.segment(text)];
  const merged: Intl.SegmentData[] = [];
  let markerIdx = 0;
  for (const seg of wordSegmenter.segment(text)) {
    while (markerIdx < markers.length && markers[markerIdx].end <= seg.index) {
      markerIdx++;
    }
    const marker = markerIdx < markers.length ? markers[markerIdx] : null;
    if (marker && seg.index >= marker.start && seg.index < marker.end) {
      if (seg.index === marker.start) {
        merged.push({
          segment: text.slice(marker.start, marker.end),
          index: marker.start,
          input: text,
        });
      }
    } else {
      merged.push(seg);
    }
  }
  return merged;
}

const WORD_NAV_OPTIONS = {
  segment: (text: string) => wordSegments(text),
  isAtomicSegment: isPasteMarkerText,
};

/**
 * Double-click word selection around `(line, col)`: resolve the word bounds with
 * the editor's own `findWordBackward`/`findWordForward` on that visual line's
 * visible text, then clip the result at paste markers (so a double-click on a
 * marker selects nothing).
 */
export function wordSelection(
  plainLines: string[],
  line: number,
  col: number,
): EditorSelection {
  const text = plainLines[line] ?? "";
  const c = clampCol(col, visibleWidth(text));
  const idx = colToCharIndex(text, c);
  const back = findWordBackward(text, idx, WORD_NAV_OPTIONS);
  const fwd = findWordForward(text, idx, WORD_NAV_OPTIONS);
  const clipped = clipRangeToMarkers(
    visibleWidth(text.slice(0, back)),
    visibleWidth(text.slice(0, fwd)),
    text,
  );
  return {
    anchor: { line, col: clipped.start },
    focus: { line, col: clipped.end },
  };
}

/**
 * Triple-click visual-line selection: the whole line, from column 0 to the
 * line's visible width (paste-marker clipping still applies downstream).
 */
export function lineSelection(
  plainLines: string[],
  line: number,
): EditorSelection {
  const text = plainLines[line] ?? "";
  return {
    anchor: { line, col: 0 },
    focus: { line, col: visibleWidth(text) },
  };
}

/**
 * Post-process `Editor.render()` output with inverse-video highlight for a
 * selection. Only the content-band lines in the selection are rebuilt (from
 * their plain text, dropping the cursor's own ANSI highlight); border rows and
 * unselected lines pass through untouched. Rebuilt lines are re-padded to the
 * original content width. Assumes no autocomplete rows are present (the overlay
 * gates selection off while the popup is open — ADR 0006).
 */
export function decorateEditorSelection(
  rendered: string[],
  sel: EditorSelection,
): string[] {
  const plain = contentBandPlainLines(rendered);
  const ranges = highlightRanges(plain, sel);
  if (ranges.length === 0) return rendered;
  const out = rendered.slice();
  for (const r of ranges) {
    const text = plain[r.line];
    if (text === undefined) continue;
    const raw = out[r.line + 1];
    if (raw === undefined) continue;
    const contentWidth = visibleWidth(raw);
    const s = colToCharIndex(text, r.start);
    const e = colToCharIndex(text, r.end);
    const rebuilt =
      text.slice(0, s) + SELECTION_ON + text.slice(s, e) + SELECTION_OFF +
      text.slice(e);
    out[r.line + 1] =
      rebuilt + " ".repeat(Math.max(0, contentWidth - visibleWidth(rebuilt)));
  }
  return out;
}

/**
 * Stateful holder for the overlay (T3): stores the anchor/focus pair and
 * delegates all computation to the pure functions above. No window-shift
 * translation is needed (the editor does not grow mid-drag like the message
 * area does), and the lifecycle is transient — the overlay clears it on any
 * non-drag editor input or a plain click.
 */
export class EditorSelectionState {
  private selection: EditorSelection | null = null;

  setSelection(anchor: EditorPos, focus: EditorPos): void {
    this.selection = { anchor, focus };
  }

  clear(): void {
    this.selection = null;
  }

  get(): EditorSelection | null {
    return this.selection;
  }

  hasSelection(): boolean {
    const s = this.selection;
    if (!s) return false;
    return s.anchor.line !== s.focus.line || s.anchor.col !== s.focus.col;
  }

  getAnchor(): EditorPos | null {
    return this.selection?.anchor ?? null;
  }

  highlightRanges(plainLines: string[]): EditorHighlightRange[] {
    return this.selection ? highlightRanges(plainLines, this.selection) : [];
  }

  selectedText(plainLines: string[]): string {
    return this.selection ? selectedText(plainLines, this.selection) : "";
  }

  decorate(rendered: string[]): string[] {
    return this.selection ? decorateEditorSelection(rendered, this.selection) : rendered;
  }
}
