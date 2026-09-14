/**
 * Unit tests for the editor-selection pure module (spec #24 T1, issue #25):
 * a zero-TUI visual-space selection holder for the input editor. Asserts the
 * external behaviors only — highlight ranges, copy text, word/line resolution,
 * paste-marker clipping, and the render post-processor — not internal fields.
 */
import { describe, expect, test } from "bun:test";
import {
  EditorSelectionState,
  contentBandPlainLines,
  decorateEditorSelection,
  highlightRanges,
  lineSelection,
  orderedEnd,
  orderedStart,
  selectedText,
  wordSelection,
  type EditorHighlightRange,
  type EditorSelection,
} from "../srcs/editor-selection.ts";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

const sel = (anchor: [number, number], focus: [number, number]): EditorSelection => ({
  anchor: { line: anchor[0], col: anchor[1] },
  focus: { line: focus[0], col: focus[1] },
});

/** Build a minimal `Editor.render(width)` output: top border, padded band, bottom border. */
function renderedBand(lines: string[], width: number): string[] {
  const top = "─".repeat(width);
  return [top, ...lines.map((l) => l + " ".repeat(Math.max(0, width - visibleWidth(l)))), top];
}

describe("orderedStart / orderedEnd", () => {
  test("orders same-line selections by column", () => {
    const s = sel([0, 5], [0, 2]);
    expect(orderedStart(s)).toEqual({ line: 0, col: 2 });
    expect(orderedEnd(s)).toEqual({ line: 0, col: 5 });
  });

  test("orders cross-line selections top-to-bottom regardless of direction", () => {
    const s = sel([2, 3], [0, 7]);
    expect(orderedStart(s)).toEqual({ line: 0, col: 7 });
    expect(orderedEnd(s)).toEqual({ line: 2, col: 3 });
  });
});

describe("contentBandPlainLines", () => {
  test("drops the top/bottom borders, strips ANSI, and trims padding", () => {
    expect(contentBandPlainLines(["──", "hi  ", "──"])).toEqual(["hi"]);
    expect(contentBandPlainLines(["──", "\x1b[7mh\x1b[0mi  ", "──"])).toEqual(["hi"]);
  });
});

describe("highlightRanges", () => {
  test("single-line selection", () => {
    expect(highlightRanges(["hello world"], sel([0, 0], [0, 5]))).toEqual([
      { line: 0, start: 0, end: 5 },
    ]);
  });

  test("clamps the end to the line's visible width", () => {
    expect(highlightRanges(["hello world"], sel([0, 3], [0, 99]))).toEqual([
      { line: 0, start: 3, end: 11 },
    ]);
  });

  test("clamps a negative start to 0", () => {
    expect(highlightRanges(["hello"], sel([0, -3], [0, 4]))).toEqual([
      { line: 0, start: 0, end: 4 },
    ]);
  });

  test("backward single-line selection is normalized", () => {
    expect(highlightRanges(["hello world"], sel([0, 5], [0, 0]))).toEqual([
      { line: 0, start: 0, end: 5 },
    ]);
  });

  test("cross-line selection covers middle lines fully", () => {
    expect(
      highlightRanges(["hello", "world", "again"], sel([0, 2], [2, 3])),
    ).toEqual([
      { line: 0, start: 2, end: 5 },
      { line: 1, start: 0, end: 5 },
      { line: 2, start: 0, end: 3 },
    ]);
  });

  test("empty selection (anchor === focus) produces no ranges", () => {
    expect(highlightRanges(["hello"], sel([0, 2], [0, 2]))).toEqual([]);
  });

  test("empty plain lines produce no ranges", () => {
    expect(highlightRanges([], sel([0, 0], [0, 5]))).toEqual([]);
  });

  test("snaps mid-grapheme columns to whole graphemes (wide chars)", () => {
    // 你好 = cells [0,4); col 1 is mid-"你", col 3 is mid-"好".
    expect(highlightRanges(["你好"], sel([0, 1], [0, 4]))).toEqual([
      { line: 0, start: 0, end: 4 },
    ]);
    expect(highlightRanges(["你好"], sel([0, 0], [0, 3]))).toEqual([
      { line: 0, start: 0, end: 4 },
    ]);
  });
});

describe("selectedText", () => {
  test("single-line copy", () => {
    expect(selectedText(["hello world"], sel([0, 0], [0, 5]))).toBe("hello");
  });

  test("cross-line copy joins top-to-bottom with \\n", () => {
    expect(selectedText(["hello", "world", "again"], sel([0, 2], [2, 3]))).toBe(
      "llo\nworld\naga",
    );
  });

  test("wide-char copy slices by cell column without splitting graphemes", () => {
    // 你好 world: 你好 = 4 cells, then " world".
    expect(selectedText(["你好 world"], sel([0, 2], [0, 11]))).toBe("好 world");
  });

  test("empty selection copies nothing", () => {
    expect(selectedText(["hello"], sel([0, 2], [0, 2]))).toBe("");
  });
});

describe("paste-marker clipping", () => {
  const markerLine = "hello [paste #1 +3 lines]";

  test("a full-line selection clips at the marker's left boundary", () => {
    const s = sel([0, 0], [0, visibleWidth(markerLine)]);
    expect(highlightRanges([markerLine], s)).toEqual([
      { line: 0, start: 0, end: 6 },
    ]);
    expect(selectedText([markerLine], s)).toBe("hello ");
  });

  test("a selection fully inside a marker produces nothing", () => {
    const s = sel([0, 7], [0, 15]);
    expect(highlightRanges([markerLine], s)).toEqual([]);
    expect(selectedText([markerLine], s)).toBe("");
  });

  test("a selection starting inside a marker clips to the marker's right edge", () => {
    const line = "[paste #1 5 chars] world";
    const s = sel([0, 5], [0, visibleWidth(line)]);
    expect(selectedText([line], s)).toBe(" world");
  });

  test("a selection spanning across a marker keeps only the left part", () => {
    const line = "a [paste #1 5 chars] b";
    const s = sel([0, 0], [0, visibleWidth(line)]);
    expect(selectedText([line], s)).toBe("a ");
  });

  test("multi-line copy clips markers on every line", () => {
    const lines = ["keep [paste #1 5 chars]", "plain"];
    const s = sel([0, 0], [1, visibleWidth("plain")]);
    expect(selectedText(lines, s)).toBe("keep \nplain");
  });

  test("a line that is entirely a marker contributes nothing to the copy", () => {
    const lines = ["hello", "[paste #1 5 chars]", "world"];
    const s = sel([0, 0], [2, 5]);
    expect(selectedText(lines, s)).toBe("hello\nworld");
  });
});

describe("wordSelection", () => {
  test("resolves a word with findWordBackward/Forward (editor semantics)", () => {
    const plain = ["hello world"];
    expect(wordSelection(plain, 0, 2)).toEqual(
      sel([0, 0], [0, 5]),
    );
    expect(wordSelection(plain, 0, 8)).toEqual(
      sel([0, 6], [0, 11]),
    );
  });

  test("preserves ASCII punctuation boundaries (foo-bar → foo)", () => {
    expect(wordSelection(["foo-bar"], 0, 1)).toEqual(sel([0, 0], [0, 3]));
  });

  test("a word next to a marker never selects the marker", () => {
    const line = "a [paste #1 5 chars] b";
    // Click on the space after "a" (col 1): the raw word jump spans the marker,
    // but clipping keeps only "a ".
    expect(wordSelection([line], 0, 1)).toEqual(sel([0, 0], [0, 2]));
  });

  test("a click inside a marker selects nothing", () => {
    const line = "a [paste #1 5 chars] b";
    const w = wordSelection([line], 0, 10);
    expect(w.anchor.col).toBe(w.focus.col);
  });
});

describe("lineSelection", () => {
  test("covers the whole visual line (0 → visibleWidth)", () => {
    expect(lineSelection(["hello"], 0)).toEqual(sel([0, 0], [0, 5]));
    expect(lineSelection(["你好a"], 0)).toEqual(sel([0, 0], [0, 5]));
  });
});

describe("decorateEditorSelection", () => {
  test("wraps the selected range in inverse video and keeps the borders", () => {
    const rendered = renderedBand(["hello"], 6);
    const out = decorateEditorSelection(rendered, sel([0, 1], [0, 4]));
    expect(out[0]).toBe("──────");
    expect(out[2]).toBe("──────");
    expect(out[1]).toContain("\x1b[7mell\x1b[27m");
    // Re-padded to the original content width, ANSI stripped = "hello ".
    expect(stripTerminalSequences(out[1])).toBe("hello ");
    expect(visibleWidth(out[1])).toBe(6);
  });

  test("decorates only the selected lines across a multi-line band", () => {
    const rendered = renderedBand(["hello", "world"], 6);
    const out = decorateEditorSelection(rendered, sel([0, 0], [1, 2]));
    expect(out[1]).toContain("\x1b[7m");
    expect(out[2]).toContain("\x1b[7m");
    expect(stripTerminalSequences(out[1])).toBe("hello ");
    expect(stripTerminalSequences(out[2])).toBe("world ");
  });

  test("returns the rendered lines unchanged when there is no selection", () => {
    const rendered = renderedBand(["hello"], 6);
    expect(decorateEditorSelection(rendered, sel([0, 2], [0, 2]))).toBe(rendered);
  });
});

describe("EditorSelectionState", () => {
  test("holds a selection and delegates to the pure functions", () => {
    const state = new EditorSelectionState();
    expect(state.hasSelection()).toBe(false);
    state.setSelection({ line: 0, col: 2 }, { line: 0, col: 5 });
    expect(state.hasSelection()).toBe(true);
    expect(state.getAnchor()).toEqual({ line: 0, col: 2 });
    expect(state.selectedText(["hello"])).toBe("llo");
    expect(state.highlightRanges(["hello"])).toEqual([
      { line: 0, start: 2, end: 5 },
    ]);
  });

  test("an empty (anchor === focus) selection is not a selection", () => {
    const state = new EditorSelectionState();
    state.setSelection({ line: 0, col: 2 }, { line: 0, col: 2 });
    expect(state.hasSelection()).toBe(false);
  });

  test("clear drops the selection", () => {
    const state = new EditorSelectionState();
    state.setSelection({ line: 0, col: 0 }, { line: 0, col: 5 });
    state.clear();
    expect(state.hasSelection()).toBe(false);
    expect(state.get()).toBe(null);
    expect(state.decorate(["──", "hello", "──"])).toEqual(["──", "hello", "──"]);
  });
});
