/**
 * Unit tests for the pointer gesture state machine (spec #12/#13, D1/D2/D4/D5):
 * feed SGR event sequences through a `PointerGesture` with a fake `PointerHit`
 * and assert the produced `GestureAction[]` sequences. The module has no TUI
 * dependency, so no terminal mock is needed — the fake hit queries model the
 * chat/editor geometry and the selection store.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  PointerGesture,
  type GestureAction,
  type PointerHit,
} from "../srcs/pointer-gesture.ts";
import type { CellPos } from "../srcs/side-chat-messages.ts";
import type { SgrMouseEvent } from "../srcs/side-chat-mouse.ts";

// Fake geometry (0-based screen rows): chat area rows 3..11, editor band 13..15.
const CHAT_TOP = 3;
const CHAT_HEIGHT = 9;
const CHAT_WIDTH = 100;
const EDITOR_TOP = 13;
const EDITOR_HEIGHT = 3;

/** Mirrors the overlay's screenToChat/clampScreenToChat over the fake layout. */
class FakeHit implements PointerHit {
  selection: { anchor: CellPos; focus: CellPos } | null = null;

  chatAt(row: number, col: number): CellPos | null {
    if (row < CHAT_TOP || row >= CHAT_TOP + CHAT_HEIGHT) return null;
    if (col < 0 || col >= CHAT_WIDTH) return null;
    return { line: row - CHAT_TOP, col };
  }

  clampToChat(row: number, col: number): CellPos {
    const line = Math.max(0, Math.min(row - CHAT_TOP, CHAT_HEIGHT - 1));
    const c = Math.max(0, Math.min(col, CHAT_WIDTH - 1));
    return { line, col: c };
  }

  overEditor(row: number, _col: number): boolean {
    return row >= EDITOR_TOP && row < EDITOR_TOP + EDITOR_HEIGHT;
  }

  hasSelection(): boolean {
    if (!this.selection) return false;
    const { anchor, focus } = this.selection;
    return anchor.line !== focus.line || anchor.col !== focus.col;
  }

  getSelectionAnchor(): CellPos | null {
    return this.selection?.anchor ?? null;
  }
}

/** Mirrors the overlay's applyGestureAction for the select/selectLine stores. */
function apply(fake: FakeHit, actions: GestureAction[]): void {
  for (const action of actions) {
    if (action.kind === "select") {
      fake.selection = { anchor: action.anchor, focus: action.focus };
    } else if (action.kind === "selectLine") {
      fake.selection = {
        anchor: { line: action.line, col: 0 },
        focus: { line: action.line, col: CHAT_WIDTH },
      };
    }
  }
}

/** Feed events and return the action list each produced (store kept in sync). */
function feed(
  g: PointerGesture,
  fake: FakeHit,
  ...events: SgrMouseEvent[]
): GestureAction[][] {
  return events.map((event) => {
    const actions = g.onEvent(event);
    apply(fake, actions);
    return actions;
  });
}

// SGR event builders (1-based coordinates, as reported by a real terminal).
const press = (col: number, row: number): SgrMouseEvent => ({
  button: 0,
  col,
  row,
  isRelease: false,
});
const drag = (col: number, row: number): SgrMouseEvent => ({
  button: 32,
  col,
  row,
  isRelease: false,
});
const release = (col: number, row: number): SgrMouseEvent => ({
  button: 0,
  col,
  row,
  isRelease: true,
});
const rightPress = (col: number, row: number): SgrMouseEvent => ({
  button: 2,
  col,
  row,
  isRelease: false,
});
const rightRelease = (col: number, row: number): SgrMouseEvent => ({
  button: 2,
  col,
  row,
  isRelease: true,
});
const wheelUp = (col: number, row: number): SgrMouseEvent => ({
  button: 64,
  col,
  row,
  isRelease: false,
});
const wheelDown = (col: number, row: number): SgrMouseEvent => ({
  button: 65,
  col,
  row,
  isRelease: false,
});

// 1-based screen row 5 / col 19 → 0-based (4, 18) → chat line 1, col 18.
const CHAT_ROW = 5;
const CHAT_COL = 19;
const CHAT_CELL = { line: 1, col: 18 } as const;

describe("pointer-gesture.ts", () => {
  let clock = 0;

  beforeEach(() => {
    clock = 0;
  });

  const makeGesture = (overrides: { rightClickEnabled?: boolean; wheelScrollLines?: number } = {}) => {
    const fake = new FakeHit();
    return {
      fake,
      gesture: new PointerGesture({
        hit: fake,
        now: () => clock,
        ...overrides,
      }),
    };
  };

  test("left press seeds an empty selection with paint", () => {
    const { gesture, fake } = makeGesture();
    const [actions] = feed(gesture, fake, press(CHAT_COL, CHAT_ROW));
    expect(actions).toEqual([
      { kind: "select", anchor: CHAT_CELL, focus: CHAT_CELL, paint: true },
    ]);
    expect(gesture.isDragging()).toBe(true);
  });

  test("drag updates the selection with a 32ms paint throttle", () => {
    const { gesture, fake } = makeGesture();
    feed(gesture, fake, press(CHAT_COL, CHAT_ROW));
    clock = 40;
    const [first] = feed(gesture, fake, drag(CHAT_COL + 5, CHAT_ROW));
    clock = 50; // 10ms after the last paint → throttled
    const [second] = feed(gesture, fake, drag(CHAT_COL + 6, CHAT_ROW));
    clock = 90; // 40ms after the last paint → paints again
    const [third] = feed(gesture, fake, drag(CHAT_COL + 7, CHAT_ROW));
    expect(first).toEqual([
      { kind: "select", anchor: CHAT_CELL, focus: { line: 1, col: 23 }, paint: true },
    ]);
    expect(second).toEqual([
      { kind: "select", anchor: CHAT_CELL, focus: { line: 1, col: 24 }, paint: false },
    ]);
    expect(third).toEqual([
      { kind: "select", anchor: CHAT_CELL, focus: { line: 1, col: 25 }, paint: true },
    ]);
  });

  test("release finalizes the selection with paint:true", () => {
    const { gesture, fake } = makeGesture();
    feed(gesture, fake, press(CHAT_COL, CHAT_ROW), drag(CHAT_COL + 5, CHAT_ROW));
    const [actions] = feed(gesture, fake, release(CHAT_COL + 5, CHAT_ROW));
    expect(actions).toEqual([
      { kind: "select", anchor: CHAT_CELL, focus: { line: 1, col: 23 }, paint: true },
    ]);
    expect(gesture.isDragging()).toBe(false);
  });

  test("release reads the anchor back from the store (window-shifted anchor)", () => {
    const { gesture, fake } = makeGesture();
    feed(gesture, fake, press(CHAT_COL, CHAT_ROW));
    // A status append shifted the window: the store's anchor moved with it.
    fake.selection!.anchor = { line: 2, col: 18 };
    const [actions] = feed(gesture, fake, drag(CHAT_COL + 5, CHAT_ROW));
    expect(actions[0]).toMatchObject({ kind: "select", anchor: { line: 2, col: 18 } });
  });

  test("two quick presses within 500ms select the whole line", () => {
    const { gesture, fake } = makeGesture();
    feed(gesture, fake, press(CHAT_COL, CHAT_ROW), release(CHAT_COL, CHAT_ROW));
    clock = 10;
    const [secondPressActions] = feed(gesture, fake, press(CHAT_COL - 1, CHAT_ROW));
    const [releaseActions] = feed(
      gesture,
      fake,
      release(CHAT_COL - 1, CHAT_ROW),
    );
    expect(secondPressActions[0]).toMatchObject({ kind: "select", paint: true });
    expect(releaseActions).toEqual([{ kind: "selectLine", line: 1 }]);
  });

  test("a second press outside the 500ms window is a plain press, not a double-click", () => {
    const { gesture, fake } = makeGesture();
    feed(gesture, fake, press(CHAT_COL, CHAT_ROW), release(CHAT_COL, CHAT_ROW));
    clock = 501;
    feed(gesture, fake, press(CHAT_COL, CHAT_ROW));
    const [releaseActions] = feed(gesture, fake, release(CHAT_COL, CHAT_ROW));
    expect(releaseActions).toEqual([]);
  });

  test("a drag release within the same-line tolerance is a click, so the next press double-clicks", () => {
    // Real terminals report motion even for 1-cell hand shake; a selection
    // that small must not mark the release as a drag (bug: line-select never
    // fired before the tolerance existed).
    const { gesture, fake } = makeGesture();
    feed(
      gesture,
      fake,
      press(CHAT_COL, CHAT_ROW),
      drag(CHAT_COL + 1, CHAT_ROW),
      release(CHAT_COL + 1, CHAT_ROW),
    );
    clock = 10;
    feed(gesture, fake, press(CHAT_COL, CHAT_ROW));
    const [releaseActions] = feed(gesture, fake, release(CHAT_COL, CHAT_ROW));
    expect(releaseActions).toEqual([{ kind: "selectLine", line: 1 }]);
  });

  test("a cross-line drag release stays a drag (tolerance is same-line only)", () => {
    const { gesture, fake } = makeGesture();
    feed(
      gesture,
      fake,
      press(CHAT_COL, CHAT_ROW),
      drag(CHAT_COL + 1, CHAT_ROW + 1),
      release(CHAT_COL + 1, CHAT_ROW + 1),
    );
    clock = 10;
    feed(gesture, fake, press(CHAT_COL, CHAT_ROW));
    const [releaseActions] = feed(gesture, fake, release(CHAT_COL, CHAT_ROW));
    // The release one line down was a real drag, so this quick press is a
    // plain press and the release must NOT select the whole line.
    expect(releaseActions).toEqual([]);
  });

  test("drag beyond the viewport clamps to the last line", () => {
    const { gesture, fake } = makeGesture();
    feed(gesture, fake, press(CHAT_COL, CHAT_ROW));
    clock = 40; // a real drag takes time; a same-ms motion is throttled
    const [actions] = feed(gesture, fake, drag(CHAT_COL, 40));
    expect(actions).toEqual([
      {
        kind: "select",
        anchor: CHAT_CELL,
        focus: { line: CHAT_HEIGHT - 1, col: 18 },
        paint: true,
      },
    ]);
  });
  test("a press on the header does not start a drag", () => {
    const { gesture, fake } = makeGesture();
    const [actions] = feed(gesture, fake, press(16, 2)); // 0-based row 1 (header)
    expect(actions).toEqual([]);
    expect(gesture.isDragging()).toBe(false);
  });

  test("right press+release over the chat with a selection copies", () => {
    const { gesture, fake } = makeGesture();
    fake.selection = { anchor: { line: 0, col: 0 }, focus: { line: 0, col: 5 } };
    const [pressActions] = feed(gesture, fake, rightPress(20, CHAT_ROW));
    const [releaseActions] = feed(gesture, fake, rightRelease(20, CHAT_ROW));
    expect(pressActions).toEqual([]);
    expect(releaseActions).toEqual([{ kind: "copy" }]);
  });

  test("right press+release over the editor pastes", () => {
    const { gesture, fake } = makeGesture();
    const editorRow = EDITOR_TOP + 2; // 0-based 14 → 1-based 15
    const [pressActions] = feed(gesture, fake, rightPress(20, editorRow));
    const [releaseActions] = feed(gesture, fake, rightRelease(20, editorRow));
    expect(pressActions).toEqual([]);
    expect(releaseActions).toEqual([{ kind: "paste" }]);
  });

  test("cross-area right-click release does nothing", () => {
    const { gesture, fake } = makeGesture();
    fake.selection = { anchor: { line: 0, col: 0 }, focus: { line: 0, col: 5 } };
    const editorRow = EDITOR_TOP + 2;
    // press in the chat, release over the editor → no copy
    const [a] = feed(gesture, fake, rightPress(20, CHAT_ROW), rightRelease(20, editorRow));
    expect(a).toEqual([]);
    // press over the editor, release in the chat → no paste
    const [b] = feed(gesture, fake, rightPress(20, editorRow), rightRelease(20, CHAT_ROW));
    expect(b).toEqual([]);
  });

  test("right-click without a selection has no action", () => {
    const { gesture, fake } = makeGesture();
    const [actions] = feed(
      gesture,
      fake,
      rightPress(20, CHAT_ROW),
      rightRelease(20, CHAT_ROW),
    );
    expect(actions).toEqual([]);
  });

  test("rightClickEnabled=false: right-click never produces actions (D11)", () => {
    const { gesture, fake } = makeGesture({ rightClickEnabled: false });
    fake.selection = { anchor: { line: 0, col: 0 }, focus: { line: 0, col: 5 } };
    const editorRow = EDITOR_TOP + 2;
    const [chat] = feed(gesture, fake, rightPress(20, CHAT_ROW), rightRelease(20, CHAT_ROW));
    const [editor] = feed(gesture, fake, rightPress(20, editorRow), rightRelease(20, editorRow));
    expect(chat).toEqual([]);
    expect(editor).toEqual([]);
  });

  test("a stray right release during a left drag does not disturb it", () => {
    const { gesture, fake } = makeGesture();
    feed(gesture, fake, press(CHAT_COL, CHAT_ROW), drag(CHAT_COL + 5, CHAT_ROW));
    expect(gesture.isDragging()).toBe(true);
    const [actions] = feed(gesture, fake, rightRelease(20, CHAT_ROW));
    expect(actions).toEqual([]);
    expect(gesture.isDragging()).toBe(true);
    const [releaseActions] = feed(gesture, fake, release(CHAT_COL + 5, CHAT_ROW));
    expect(releaseActions).toHaveLength(1);
    expect(releaseActions[0]).toMatchObject({ kind: "select", paint: true });
  });

  test("wheel scroll keeps working after a right-click", () => {
    const { gesture, fake } = makeGesture();
    feed(gesture, fake, rightPress(20, CHAT_ROW), rightRelease(20, CHAT_ROW));
    const [up] = feed(gesture, fake, wheelUp(20, CHAT_ROW));
    const [down] = feed(gesture, fake, wheelDown(20, CHAT_ROW));
    expect(up).toEqual([{ kind: "scroll", lines: 3 }]);
    expect(down).toEqual([{ kind: "scroll", lines: -3 }]);
  });

  test("wheelScrollLines option is honored", () => {
    const { gesture, fake } = makeGesture({ wheelScrollLines: 5 });
    const [actions] = feed(gesture, fake, wheelUp(20, CHAT_ROW));
    expect(actions).toEqual([{ kind: "scroll", lines: 5 }]);
  });

  test("cancel aborts an in-flight drag; a stale release does not swallow later events", () => {
    const { gesture, fake } = makeGesture();
    feed(gesture, fake, press(CHAT_COL, CHAT_ROW));
    expect(gesture.isDragging()).toBe(true);
    gesture.cancel();
    expect(gesture.isDragging()).toBe(false);
    const [actions] = feed(gesture, fake, release(CHAT_COL, CHAT_ROW));
    expect(actions).toEqual([]);
    expect(gesture.isDragging()).toBe(false);
  });
});
