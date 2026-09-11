/**
 * Table-driven unit tests for the pure overlay-layout module (spec #16 / ticket
 * #17). The module is the single source of the overlay's layout knowledge; these
 * tables guard:
 *
 * 1. the mirror contract — resolveLayout reproduces pi-tui's private
 *    TuiBase.resolveOverlayLayout semantics. Verified against the actual
 *    sources: the method is byte-identical in pi-tui 0.84.2 (dist/tui.js
 *    L679-800, devDep) and 0.85.1 (dist/tui.js L781-902, runtime), including
 *    parseSizeValue (0.84.2 L24-35 / 0.85.1 L57-68). All expected values below
 *    are hand-derived from those sources.
 * 2. the frame-geometry invariants — msgTopRow = outer row + FRAME_HEADER_LINES,
 *    contentCol = outer col + FRAME_SIDE_PADDING, innerWidth = outer width − 4,
 *    editor band rows.
 * 3. the height heuristic (normal / small terminals).
 * 4. the viewport clamp (maxHeight + fixed top row).
 */
import { describe, expect, test } from "bun:test";
import type { OverlayOptions } from "@earendil-works/pi-tui";
import {
  FRAME_HEADER_LINES,
  FRAME_SIDE_PADDING,
  LAYOUT,
  computeChatGeometry,
  computeOverlayViewport,
  computeSideChatHeight,
  resolveLayout,
} from "../srcs/overlay-layout.ts";

describe("LAYOUT (single source for overlay options)", () => {
  test("pins the side chat's overlay options", () => {
    expect(LAYOUT).toEqual({
      width: "85%",
      maxHeight: "88%",
      anchor: "top-center",
      margin: { top: 1, left: 2, right: 2 },
      nonCapturing: true,
    });
  });
});

describe("resolveLayout mirror contract (pi-tui 0.84.2 ↔ 0.85.1)", () => {
  const cases: {
    name: string;
    termWidth: number;
    termHeight: number;
    frameHeight: number;
    options?: OverlayOptions;
    expected: { width: number; row: number; col: number; maxHeight: number | undefined };
  }[] = [
    {
      name: "LAYOUT at 120x40: percent width/maxHeight, top-center anchor, margins",
      termWidth: 120,
      termHeight: 40,
      frameHeight: 30,
      // width = floor(120*0.85)=102, maxHeight = floor(40*0.88)=35 (avail 39),
      // row = marginTop = 1, col = 2 + floor((116-102)/2) = 9
      expected: { width: 102, row: 1, col: 9, maxHeight: 35 },
    },
    {
      name: "LAYOUT at 80x24: smaller terminal",
      termWidth: 80,
      termHeight: 24,
      frameHeight: 20,
      // width = floor(80*0.85)=68, maxHeight = floor(24*0.88)=21 (avail 23),
      // col = 2 + floor((76-68)/2) = 6
      expected: { width: 68, row: 1, col: 6, maxHeight: 21 },
    },
    {
      name: "center anchor + decimal percent + number margin",
      termWidth: 80,
      termHeight: 24,
      frameHeight: 10,
      options: { width: "12.5%", maxHeight: "50%", anchor: "center", margin: 0 },
      // width = floor(80*0.125)=10, maxHeight = floor(24*0.5)=12,
      // row = floor((24-10)/2)=7, col = floor((80-10)/2)=35
      expected: { width: 10, row: 7, col: 35, maxHeight: 12 },
    },
    {
      name: "negative margins clamp to zero",
      termWidth: 100,
      termHeight: 30,
      frameHeight: 5,
      options: {
        width: "50%",
        maxHeight: "100%",
        anchor: "center",
        margin: { top: -5, left: -2, right: 4, bottom: 3 },
      },
      // margins -> {top:0, right:4, bottom:3, left:0}; avail 96x27;
      // width = 50, maxHeight = min(30, 27) = 27, row = floor((27-5)/2) = 11,
      // col = floor((96-50)/2) = 23
      expected: { width: 50, row: 11, col: 23, maxHeight: 27 },
    },
    {
      name: "width percent over 100% clamps to available space",
      termWidth: 40,
      termHeight: 20,
      frameHeight: 5,
      options: { width: "300%", maxHeight: "50%", anchor: "center" },
      // width = floor(40*3)=120 -> clamped to availWidth 40
      expected: { width: 40, row: 7, col: 0, maxHeight: 10 },
    },
    {
      name: "maxHeight percent over 100% clamps to available height",
      termWidth: 40,
      termHeight: 20,
      frameHeight: 5,
      options: { width: "50%", maxHeight: "500%" },
      // maxHeight = floor(20*5)=100 -> clamped to availHeight 20
      expected: { width: 20, row: 7, col: 10, maxHeight: 20 },
    },
    {
      name: "top-center anchor pins row to marginTop",
      termWidth: 100,
      termHeight: 30,
      frameHeight: 8,
      options: {
        width: "60%",
        maxHeight: "80%",
        anchor: "top-center",
        margin: { top: 2, left: 3, right: 3, bottom: 2 },
      },
      // avail 94x26; width=60, maxHeight=min(24,26)=24; row = 2,
      // col = 3 + floor((94-60)/2) = 20
      expected: { width: 60, row: 2, col: 20, maxHeight: 24 },
    },
    {
      name: "bottom-center anchor pushes row to the bottom",
      termWidth: 100,
      termHeight: 30,
      frameHeight: 8,
      options: {
        width: "60%",
        maxHeight: "80%",
        anchor: "bottom-center",
        margin: { top: 2, left: 3, right: 3, bottom: 2 },
      },
      // row = 2 + (26 - 8) = 20
      expected: { width: 60, row: 20, col: 20, maxHeight: 24 },
    },
    {
      name: "omitted anchor defaults to center",
      termWidth: 80,
      termHeight: 24,
      frameHeight: 10,
      options: { width: "50%", maxHeight: "50%" },
      // row = floor((24-10)/2) = 7, col = floor((80-40)/2) = 20
      expected: { width: 40, row: 7, col: 20, maxHeight: 12 },
    },
    {
      name: "row percent: 100% pins to the bottom edge of available space",
      termWidth: 80,
      termHeight: 24,
      frameHeight: 10,
      options: { width: "50%", maxHeight: "50%", row: "100%" },
      // maxRow = max(0, 24-10) = 14; row = 0 + floor(14*1.0) = 14
      expected: { width: 40, row: 14, col: 20, maxHeight: 12 },
    },
    {
      name: "col percent: 100% pins to the right edge",
      termWidth: 80,
      termHeight: 24,
      frameHeight: 10,
      options: { width: "50%", maxHeight: "50%", col: "100%" },
      // maxCol = max(0, 80-40) = 40; col = 0 + floor(40*1.0) = 40
      expected: { width: 40, row: 7, col: 40, maxHeight: 12 },
    },
    {
      name: "offsetX/offsetY shift after anchor resolution",
      termWidth: 80,
      termHeight: 24,
      frameHeight: 10,
      options: {
        width: "50%",
        maxHeight: "50%",
        anchor: "center",
        offsetX: 3,
        offsetY: -2,
      },
      // row = 7 - 2 = 5, col = 20 + 3 = 23
      expected: { width: 40, row: 5, col: 23, maxHeight: 12 },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(
        resolveLayout(c.termWidth, c.termHeight, c.frameHeight, c.options),
      ).toEqual(c.expected);
    });
  }

  test("3-arg form resolves the default LAYOUT (used by the geometry functions)", () => {
    expect(resolveLayout(120, 40, 30)).toEqual({
      width: 102,
      row: 1,
      col: 9,
      maxHeight: 35,
    });
  });
});

describe("computeChatGeometry invariants", () => {
  const cases: {
    termCols: number;
    termRows: number;
    msgHeight: number;
    editorHeight: number;
    exact: { msgTopRow: number; contentCol: number; innerWidth: number; editorTopRow: number };
  }[] = [
    {
      termCols: 120,
      termRows: 40,
      msgHeight: 6,
      editorHeight: 2,
      exact: { msgTopRow: 4, contentCol: 11, innerWidth: 98, editorTopRow: 11 },
    },
    {
      termCols: 120,
      termRows: 40,
      msgHeight: 10,
      editorHeight: 3,
      exact: { msgTopRow: 4, contentCol: 11, innerWidth: 98, editorTopRow: 15 },
    },
    {
      termCols: 80,
      termRows: 24,
      msgHeight: 4,
      editorHeight: 2,
      exact: { msgTopRow: 4, contentCol: 8, innerWidth: 64, editorTopRow: 9 },
    },
    {
      termCols: 60,
      termRows: 16,
      msgHeight: 3,
      editorHeight: 2,
      exact: { msgTopRow: 4, contentCol: 6, innerWidth: 47, editorTopRow: 8 },
    },
  ];

  for (const c of cases) {
    test(`${c.termCols}x${c.termRows} msg=${c.msgHeight} editor=${c.editorHeight}`, () => {
      const g = computeChatGeometry(c.termCols, c.termRows, c.msgHeight, c.editorHeight);
      // The outer box is resolveLayout's; the frame offsets are named constants
      // (same frame-height estimate the module uses internally — see the
      // implementation note on computeChatGeometry).
      const frameHeight = c.msgHeight + c.editorHeight + FRAME_HEADER_LINES * 2;
      const layout = resolveLayout(c.termCols, c.termRows, frameHeight);

      expect(g.msgTopRow).toBe(layout.row + FRAME_HEADER_LINES);
      expect(g.contentCol).toBe(layout.col + FRAME_SIDE_PADDING);
      expect(g.innerWidth).toBe(layout.width - 4);
      // Separator below the messages sits at msgTopRow + msgHeight; the input
      // editor widget band starts on the next row.
      expect(g.editorTopRow).toBe(g.msgTopRow + g.msgHeight + 1);
      expect(g.editorHeight).toBe(c.editorHeight);

      // Exact values (kept stable by the regression net select.test.ts too).
      expect(g.msgTopRow).toBe(c.exact.msgTopRow);
      expect(g.contentCol).toBe(c.exact.contentCol);
      expect(g.innerWidth).toBe(c.exact.innerWidth);
      expect(g.editorTopRow).toBe(c.exact.editorTopRow);
    });
  }
});

describe("computeSideChatHeight heuristic", () => {
  const cases: [number, number][] = [
    [5, 3], // tiny terminal: never below 3 message rows
    [10, 3],
    [12, 3], // small terminal: clamps so the overlay still fits
    [20, 8],
    [24, 8],
    [40, 10], // normal terminal (2.5x of ~0.35*rows - 10)
    [60, 28], // large terminal
  ];

  for (const [rows, expected] of cases) {
    test(`rows=${rows} → ${expected}`, () => {
      expect(computeSideChatHeight(rows)).toBe(expected);
    });
  }

  test("never below 3; capped by overlayCap − fixed rows where the cap can bind", () => {
    for (let rows = 3; rows <= 200; rows++) {
      const h = computeSideChatHeight(rows);
      expect(h).toBeGreaterThanOrEqual(3);
      // 7 fixed rows (borders, header, editor, hints) around the message area.
      const overlayCap = Math.max(9, Math.min(Math.floor(rows * 0.88), rows - 4));
      // The cap−7 bound only binds where it fits the 3-row floor; below ~14
      // rows the floor wins by design (the overlay keeps 3 message rows even
      // if it slightly overflows a very small terminal).
      if (overlayCap - 7 >= 3) expect(h).toBeLessThanOrEqual(overlayCap - 7);
    }
  });
});

describe("computeOverlayViewport clamp", () => {
  const cases: [number, number, { topRow: number; height: number }][] = [
    [40, 30, { topRow: 1, height: 30 }], // below maxHeight → lastRenderHeight
    [40, 50, { topRow: 1, height: 35 }], // clamped to maxHeight (88% of 40 = 35)
    [12, 9, { topRow: 1, height: 9 }],
    [12, 20, { topRow: 1, height: 10 }], // maxHeight = 88% of 12 = 10
    [4, 4, { topRow: 1, height: 3 }], // small terminal: maxHeight = rows - 1 = 3
    [4, 1, { topRow: 1, height: 1 }],
  ];

  for (const [termRows, lastRenderHeight, expected] of cases) {
    test(`rows=${termRows} rendered=${lastRenderHeight} → ${expected.height}`, () => {
      expect(computeOverlayViewport(termRows, lastRenderHeight)).toEqual(expected);
    });
  }

  test("topRow is always pinned to the layout margin top", () => {
    for (let rows = 2; rows <= 200; rows++) {
      expect(computeOverlayViewport(rows, 1).topRow).toBe(
        (LAYOUT.margin as { top?: number }).top ?? 0,
      );
    }
  });
});
