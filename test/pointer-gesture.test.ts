/**
 * Unit tests for the pointer gesture state machine (spec #12/#13, #24/#26):
 * feed SGR event sequences through a `PointerGesture` with a fake `PointerHit`
 * and assert the produced `GestureAction[]` sequences. The module has no TUI
 * dependency, so no terminal mock is needed — the fake hit queries model the
 * chat/editor geometry and the two selection stores (chat + editor surfaces).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  PointerGesture,
  type GestureAction,
  type PointerHit,
} from "../srcs/pointer-gesture.ts";
import type { CellPos } from "../srcs/side-chat-messages.ts";
import type { EditorPos } from "../srcs/editor-selection.ts";
import type { SgrMouseEvent } from "../srcs/side-chat-mouse.ts";

// Fake geometry (0-based screen rows): chat area rows 3..11, editor band 13..15.
const CHAT_TOP = 3;
const CHAT_HEIGHT = 9;
const CHAT_WIDTH = 100;
const EDITOR_TOP = 13;
const EDITOR_HEIGHT = 3;
const EDITOR_WIDTH = 100;

/** Mirrors the overlay's hit queries over the fake layout (both surfaces). */
class FakeHit implements PointerHit {
  selection: { anchor: CellPos; focus: CellPos } | null = null;
  editorSelection: { anchor: EditorPos; focus: EditorPos } | null = null;

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

  editorAt(row: number, col: number): EditorPos | null {
    if (row < EDITOR_TOP || row >= EDITOR_TOP + EDITOR_HEIGHT) return null;
    if (col < 0 || col >= EDITOR_WIDTH) return null;
    return { line: row - EDITOR_TOP, col };
  }

  clampToEditor(row: number, col: number): EditorPos {
    const line = Math.max(0, Math.min(row - EDITOR_TOP, EDITOR_HEIGHT - 1));
    const c = Math.max(0, Math.min(col, EDITOR_WIDTH - 1));
    return { line, col: c };
  }

  hasSelection(): boolean {
    if (!this.selection) return false;
    const { anchor, focus } = this.selection;
    return anchor.line !== focus.line || anchor.col !== focus.col;
  }

  getSelectionAnchor(): CellPos | null {
    return this.selection?.anchor ?? null;
  }

  hasEditorSelection(): boolean {
    if (!this.editorSelection) return false;
    const { anchor, focus } = this.editorSelection;
    return anchor.line !== focus.line || anchor.col !== focus.col;
  }

  getEditorSelectionAnchor(): EditorPos | null {
    return this.editorSelection?.anchor ?? null;
  }
}

/** Mirrors the overlay's applyGestureAction for the select/selectLine stores. */
function apply(fake: FakeHit, actions: GestureAction[]): void {
  for (const action of actions) {
    if (action.kind === "select") {
      if (action.surface === "chat") {
        fake.selection = { anchor: action.anchor, focus: action.focus };
      } else {
        fake.editorSelection = { anchor: action.anchor, focus: action.focus };
      }
    } else if (action.kind === "selectLine") {
      const width = action.surface === "chat" ? CHAT_WIDTH : EDITOR_WIDTH;
      const selection = {
        anchor: { line: action.line, col: 0 },
        focus: { line: action.line, col: width },
      };
      if (action.surface === "chat") fake.selection = selection;
      else fake.editorSelection = selection;
    }
    // selectWord: word bounds are resolved by the overlay (T4), not the
    // module; the fake records no store state for it — tests assert the action.
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

// 1-based screen row 15 / col 20 → 0-based (14, 19) → editor line 1, col 19.
const EDITOR_ROW = 15;
const EDITOR_COL = 20;
const EDITOR_CELL = { line: 1, col: 19 } as const;

describe("pointer-gesture.ts", () => {
  let clock = 0;

  beforeEach(() => {
    clock = 0;
  });

  const makeGesture = (
    overrides: {
      rightClickEnabled?: boolean;
      editorSelectionEnabled?: boolean;
      wheelScrollLines?: number;
    } = {},
  ) => {
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

  // --- chat surface (spec #12/#13, regression) ---

  test("left press seeds an empty selection with paint", () => {
    const { gesture, fake } = makeGesture();
    const [actions] = feed(gesture, fake, press(CHAT_COL, CHAT_ROW));
    expect(actions).toEqual([
      {
        kind: "select",
        surface: "chat",
        anchor: CHAT_CELL,
        focus: CHAT_CELL,
        paint: true,
      },
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
      {
        kind: "select",
        surface: "chat",
        anchor: CHAT_CELL,
        focus: { line: 1, col: 23 },
        paint: true,
      },
    ]);
    expect(second).toEqual([
      {
        kind: "select",
        surface: "chat",
        anchor: CHAT_CELL,
        focus: { line: 1, col: 24 },
        paint: false,
      },
    ]);
    expect(third).toEqual([
      {
        kind: "select",
        surface: "chat",
        anchor: CHAT_CELL,
        focus: { line: 1, col: 25 },
        paint: true,
      },
    ]);
  });

  test("release finalizes the selection with paint:true", () => {
    const { gesture, fake } = makeGesture();
    feed(gesture, fake, press(CHAT_COL, CHAT_ROW), drag(CHAT_COL + 5, CHAT_ROW));
    const [actions] = feed(gesture, fake, release(CHAT_COL + 5, CHAT_ROW));
    expect(actions).toEqual([
      {
        kind: "select",
        surface: "chat",
        anchor: CHAT_CELL,
        focus: { line: 1, col: 23 },
        paint: true,
      },
    ]);
    expect(gesture.isDragging()).toBe(false);
  });

  test("release reads the anchor back from the store (window-shifted anchor)", () => {
    const { gesture, fake } = makeGesture();
    feed(gesture, fake, press(CHAT_COL, CHAT_ROW));
    // A status append shifted the window: the store's anchor moved with it.
    fake.selection!.anchor = { line: 2, col: 18 };
    const [actions] = feed(gesture, fake, drag(CHAT_COL + 5, CHAT_ROW));
    expect(actions[0]).toMatchObject({
      kind: "select",
      surface: "chat",
      anchor: { line: 2, col: 18 },
    });
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
    expect(secondPressActions[0]).toMatchObject({
      kind: "select",
      surface: "chat",
      paint: true,
    });
    expect(releaseActions).toEqual([{ kind: "selectLine", surface: "chat", line: 1 }]);
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
    expect(releaseActions).toEqual([{ kind: "selectLine", surface: "chat", line: 1 }]);
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
        surface: "chat",
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
    expect(releaseActions).toEqual([{ kind: "copy", surface: "chat" }]);
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
    // A fresh press afterwards works normally: the stale release must not
    // have swallowed the gesture stream.
    const [rePress] = feed(gesture, fake, press(CHAT_COL, CHAT_ROW));
    expect(rePress).toEqual([
      {
        kind: "select",
        surface: "chat",
        anchor: CHAT_CELL,
        focus: CHAT_CELL,
        paint: true,
      },
    ]);
    expect(gesture.isDragging()).toBe(true);
  });

  // --- editor surface (spec #24/#26) ---

  test("editor left press seeds an empty editor selection (surface editor)", () => {
    const { gesture, fake } = makeGesture();
    const [actions] = feed(gesture, fake, press(EDITOR_COL, EDITOR_ROW));
    expect(actions).toEqual([
      {
        kind: "select",
        surface: "editor",
        anchor: EDITOR_CELL,
        focus: EDITOR_CELL,
        paint: true,
      },
    ]);
    expect(gesture.isDragging()).toBe(true);
  });

  test("editor drag clamps into the editor content band", () => {
    const { gesture, fake } = makeGesture();
    feed(gesture, fake, press(EDITOR_COL, EDITOR_ROW));
    clock = 40;
    const [actions] = feed(gesture, fake, drag(EDITOR_COL + 5, 40)); // 0-based col 24, row 39 (off-band)
    expect(actions).toEqual([
      {
        kind: "select",
        surface: "editor",
        anchor: EDITOR_CELL,
        focus: { line: EDITOR_HEIGHT - 1, col: 24 },
        paint: true,
      },
    ]);
  });

  test("editor double-click selects the word under the click (surface editor)", () => {
    const { gesture, fake } = makeGesture();
    feed(gesture, fake, press(EDITOR_COL, EDITOR_ROW), release(EDITOR_COL, EDITOR_ROW));
    clock = 10;
    const [secondPress] = feed(gesture, fake, press(EDITOR_COL - 1, EDITOR_ROW));
    const [releaseActions] = feed(gesture, fake, release(EDITOR_COL - 1, EDITOR_ROW));
    expect(secondPress[0]).toMatchObject({ kind: "select", surface: "editor", paint: true });
    expect(releaseActions).toEqual([
      { kind: "selectWord", surface: "editor", line: 1, col: 18 },
    ]);
  });

  test("editor triple-click selects the whole visual line (surface editor)", () => {
    const { gesture, fake } = makeGesture();
    feed(gesture, fake, press(EDITOR_COL, EDITOR_ROW), release(EDITOR_COL, EDITOR_ROW));
    clock = 10;
    feed(gesture, fake, press(EDITOR_COL, EDITOR_ROW), release(EDITOR_COL, EDITOR_ROW));
    clock = 20;
    feed(gesture, fake, press(EDITOR_COL, EDITOR_ROW));
    const [releaseActions] = feed(gesture, fake, release(EDITOR_COL, EDITOR_ROW));
    expect(releaseActions).toEqual([{ kind: "selectLine", surface: "editor", line: 1 }]);
  });

  test("chat triple-click still selects the rendered line (surface chat, unchanged)", () => {
    const { gesture, fake } = makeGesture();
    feed(gesture, fake, press(CHAT_COL, CHAT_ROW), release(CHAT_COL, CHAT_ROW));
    clock = 10;
    feed(gesture, fake, press(CHAT_COL, CHAT_ROW), release(CHAT_COL, CHAT_ROW));
    clock = 20;
    feed(gesture, fake, press(CHAT_COL, CHAT_ROW));
    const [releaseActions] = feed(gesture, fake, release(CHAT_COL, CHAT_ROW));
    expect(releaseActions).toEqual([{ kind: "selectLine", surface: "chat", line: 1 }]);
  });

  test("a press outside the click window resets the editor click count", () => {
    const { gesture, fake } = makeGesture();
    feed(gesture, fake, press(EDITOR_COL, EDITOR_ROW), release(EDITOR_COL, EDITOR_ROW));
    clock = 501;
    feed(gesture, fake, press(EDITOR_COL, EDITOR_ROW));
    const [releaseActions] = feed(gesture, fake, release(EDITOR_COL, EDITOR_ROW));
    expect(releaseActions).toEqual([]);
  });

  test("a press far from the last press resets the editor click count", () => {
    const { gesture, fake } = makeGesture();
    feed(gesture, fake, press(EDITOR_COL, EDITOR_ROW), release(EDITOR_COL, EDITOR_ROW));
    clock = 10;
    feed(gesture, fake, press(EDITOR_COL + 10, EDITOR_ROW)); // 10 cells away
    const [releaseActions] = feed(gesture, fake, release(EDITOR_COL + 10, EDITOR_ROW));
    expect(releaseActions).toEqual([]);
  });

  test("a drag release resets the editor click count for the next press", () => {
    const { gesture, fake } = makeGesture();
    feed(
      gesture,
      fake,
      press(EDITOR_COL, EDITOR_ROW),
      drag(EDITOR_COL + 5, EDITOR_ROW + 1), // cross-line drag
      release(EDITOR_COL + 5, EDITOR_ROW + 1),
    );
    clock = 10;
    feed(gesture, fake, press(EDITOR_COL, EDITOR_ROW));
    const [releaseActions] = feed(gesture, fake, release(EDITOR_COL, EDITOR_ROW));
    expect(releaseActions).toEqual([]);
  });

  test("a surface change resets the click count (chat click then editor click)", () => {
    const { gesture, fake } = makeGesture();
    feed(gesture, fake, press(CHAT_COL, CHAT_ROW), release(CHAT_COL, CHAT_ROW));
    clock = 10;
    feed(gesture, fake, press(EDITOR_COL, EDITOR_ROW));
    const [releaseActions] = feed(gesture, fake, release(EDITOR_COL, EDITOR_ROW));
    expect(releaseActions).toEqual([]);
  });

  test("right press+release over the editor pastes even with an editor selection", () => {
    const { gesture, fake } = makeGesture();
    fake.editorSelection = {
      anchor: { line: 0, col: 0 },
      focus: { line: 0, col: 5 },
    };
    const editorRow = EDITOR_TOP + 2;
    const [, releaseActions] = feed(
      gesture,
      fake,
      rightPress(20, editorRow),
      rightRelease(20, editorRow),
    );
    expect(releaseActions).toEqual([{ kind: "paste" }]);
  });

  test("editorSelectionEnabled=false disables editor left-drag but keeps right-click paste", () => {
    const { gesture, fake } = makeGesture({ editorSelectionEnabled: false });
    const [pressActions] = feed(gesture, fake, press(EDITOR_COL, EDITOR_ROW));
    expect(pressActions).toEqual([]);
    expect(gesture.isDragging()).toBe(false);
    const editorRow = EDITOR_TOP + 2;
    const [, releaseActions] = feed(
      gesture,
      fake,
      rightPress(20, editorRow),
      rightRelease(20, editorRow),
    );
    expect(releaseActions).toEqual([{ kind: "paste" }]);
  });
});
