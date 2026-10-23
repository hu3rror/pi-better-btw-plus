import { describe, expect, test } from "bun:test";
import {
  makeOverlay as sharedMakeOverlay,
  OVERLAY_TEST_WIDTH,
} from "./helpers/make-overlay.ts";

// Clipboard write-side mock must load before side-chat-overlay.ts.
await import("./helpers/clipboard-mock.ts");
const { copiedTexts, setCopyImplementation, resetCopyImplementation } =
  await import("./helpers/clipboard-mock.ts");
const { SideChatOverlay } = await import("../srcs/side-chat-overlay.ts");

type Overlay = InstanceType<typeof SideChatOverlay>;
const makeOverlay = (messages?: any[], overrides: Record<string, unknown> = {}) =>
  sharedMakeOverlay(SideChatOverlay, messages, overrides);

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** 1-based screen cell of the editor content band's first cell (line 0, col 0). */
function editorOrigin(overlay: Overlay): { row: number; col: number } {
  const g = (overlay as any).geometry as {
    editorTopRow: number;
    contentCol: number;
  };
  // Content band line 0 is one row below the editor's top border; SGR is
  // 1-based so both row and col get +1 over the 0-based geometry fields.
  return { row: g.editorTopRow + 2, col: g.contentCol + 1 };
}

function seedEditor(overlay: Overlay, text: string): void {
  overlay.handleInput(text);
  overlay.render(OVERLAY_TEST_WIDTH);
}

function dragEditor(overlay: Overlay, fromCol: number, toCol: number): void {
  const { row, col } = editorOrigin(overlay);
  overlay.handleMouseEvent({
    button: 0,
    col: col + fromCol,
    row,
    isRelease: false,
  });
  overlay.handleMouseEvent({
    button: 32,
    col: col + toCol,
    row,
    isRelease: false,
  });
  overlay.handleMouseEvent({
    button: 0,
    col: col + toCol,
    row,
    isRelease: true,
  });
}

function doubleClickEditor(overlay: Overlay, col: number, line = 0): void {
  const { row, col: originCol } = editorOrigin(overlay);
  const r = row + line;
  for (let i = 0; i < 2; i++) {
    overlay.handleMouseEvent({
      button: 0,
      col: originCol + col,
      row: r,
      isRelease: false,
    });
    overlay.handleMouseEvent({
      button: 0,
      col: originCol + col,
      row: r,
      isRelease: true,
    });
  }
}

function tripleClickEditor(overlay: Overlay, col: number, line = 0): void {
  const { row, col: originCol } = editorOrigin(overlay);
  const r = row + line;
  for (let i = 0; i < 3; i++) {
    overlay.handleMouseEvent({
      button: 0,
      col: originCol + col,
      row: r,
      isRelease: false,
    });
    overlay.handleMouseEvent({
      button: 0,
      col: originCol + col,
      row: r,
      isRelease: true,
    });
  }
}

async function openAutocomplete(overlay: Overlay): Promise<void> {
  const editor = (overlay as any).editor as {
    setAutocompleteProvider(provider: unknown): void;
    isShowingAutocomplete(): boolean;
  };
  editor.setAutocompleteProvider({
    getSuggestions: async () => ({
      items: [{ value: "@user", label: "@user" }],
      prefix: "@",
    }),
    applyCompletion: (
      lines: string[],
      cursorLine: number,
      cursorCol: number,
    ) => ({ lines, cursorLine, cursorCol }),
  });
  overlay.handleInput(" ");
  overlay.handleInput("@");
  await new Promise((resolve) => setTimeout(resolve, 40));
  if (!editor.isShowingAutocomplete()) {
    throw new Error("autocomplete popup did not open");
  }
}

function hasEditorSelection(overlay: Overlay): boolean {
  return (overlay as any).editorSelection.hasSelection() as boolean;
}

describe("editor-selection overlay wiring (spec #24 T3)", () => {
  test("editor left-drag selects text and Ctrl+C copies it, consuming the selection", async () => {
    const overlay = makeOverlay();
    seedEditor(overlay, "draft text");
    dragEditor(overlay, 0, 5);
    expect(hasEditorSelection(overlay)).toBe(true);

    overlay.handleInput("\x03");
    await tick();
    expect(copiedTexts()).toEqual(["draft"]);
    expect(hasEditorSelection(overlay)).toBe(false);
  });

  test("a drag renders the inverse-video highlight in the editor band", () => {
    const overlay = makeOverlay();
    seedEditor(overlay, "draft text");
    dragEditor(overlay, 0, 5);

    const frame = overlay.render(OVERLAY_TEST_WIDTH).join("\n");
    expect(frame).toContain("\x1b[7mdraft\x1b[27m");
  });

  test("Ctrl+Shift+C also copies the editor selection", async () => {
    const overlay = makeOverlay();
    seedEditor(overlay, "draft text");
    dragEditor(overlay, 0, 5);

    overlay.handleInput("\x1b[99;6u");
    await tick();
    expect(copiedTexts()).toEqual(["draft"]);
    expect(hasEditorSelection(overlay)).toBe(false);
  });

  test("a failed editor copy keeps the selection for retry", async () => {
    const overlay = makeOverlay();
    seedEditor(overlay, "draft text");
    dragEditor(overlay, 0, 5);

    setCopyImplementation(async () => {
      throw new Error("stdout closed");
    });
    overlay.handleInput("\x03");
    await tick();
    resetCopyImplementation();

    expect(copiedTexts()).toEqual([]);
    expect(hasEditorSelection(overlay)).toBe(true);
  });

  test("chat selection takes priority over editor selection on Ctrl+C", async () => {
    const overlay = makeOverlay();
    seedEditor(overlay, "draft text");
    dragEditor(overlay, 0, 5);
    expect(hasEditorSelection(overlay)).toBe(true);

    (overlay as any).messages.setSelection({ line: 0, col: 7 }, { line: 0, col: 12 });

    overlay.handleInput("\x03");
    await tick();
    expect(copiedTexts()).toEqual(["hello"]);
    expect((overlay as any).messages.hasSelection()).toBe(false);
    expect(hasEditorSelection(overlay)).toBe(true);
  });

  test("typing clears the editor selection", () => {
    const overlay = makeOverlay();
    seedEditor(overlay, "draft text");
    dragEditor(overlay, 0, 5);
    expect(hasEditorSelection(overlay)).toBe(true);

    overlay.handleInput("x");
    expect(hasEditorSelection(overlay)).toBe(false);
  });

  test("cursor movement clears the editor selection", () => {
    const overlay = makeOverlay();
    seedEditor(overlay, "draft text");
    dragEditor(overlay, 0, 5);
    expect(hasEditorSelection(overlay)).toBe(true);

    overlay.handleInput("\x1b[C");
    expect(hasEditorSelection(overlay)).toBe(false);
  });

  test("a plain click on the editor clears the editor selection", () => {
    const overlay = makeOverlay();
    seedEditor(overlay, "draft text");
    dragEditor(overlay, 0, 5);
    expect(hasEditorSelection(overlay)).toBe(true);

    const { row, col } = editorOrigin(overlay);
    overlay.handleMouseEvent({ button: 0, col: col + 5, row, isRelease: false });
    overlay.handleMouseEvent({ button: 0, col: col + 5, row, isRelease: true });
    expect(hasEditorSelection(overlay)).toBe(false);
  });

  test("starting a drag on the editor clears the chat selection", () => {
    const overlay = makeOverlay();
    seedEditor(overlay, "draft text");
    overlay.handleMouseEvent({ button: 0, col: 19, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 32, col: 24, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 0, col: 24, row: 5, isRelease: true });
    expect((overlay as any).messages.hasSelection()).toBe(true);

    dragEditor(overlay, 0, 5);
    expect((overlay as any).messages.hasSelection()).toBe(false);
    expect(hasEditorSelection(overlay)).toBe(true);
  });

  test("starting a drag on the chat clears the editor selection", () => {
    const overlay = makeOverlay();
    seedEditor(overlay, "draft text");
    dragEditor(overlay, 0, 5);
    expect(hasEditorSelection(overlay)).toBe(true);

    overlay.handleMouseEvent({ button: 0, col: 19, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 32, col: 24, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 0, col: 24, row: 5, isRelease: true });
    expect(hasEditorSelection(overlay)).toBe(false);
    expect((overlay as any).messages.hasSelection()).toBe(true);
  });

  test("features.editorSelection=false disables editor left-drag", () => {
    const overlay = makeOverlay(undefined, {
      features: {
        rightClickCopyPaste: true,
        modelSwitch: true,
        retry: true,
        editorSelection: false,
      },
    });
    seedEditor(overlay, "draft text");
    dragEditor(overlay, 0, 5);
    expect(hasEditorSelection(overlay)).toBe(false);
  });

  test("cancelMouseDrag clears the editor selection", () => {
    const overlay = makeOverlay();
    seedEditor(overlay, "draft text");
    dragEditor(overlay, 0, 5);
    expect(hasEditorSelection(overlay)).toBe(true);

    (overlay as any).cancelMouseDrag();
    expect(hasEditorSelection(overlay)).toBe(false);
  });

  test("opening the model picker clears the editor selection", () => {
    const overlay = makeOverlay(undefined, { scopedModels: [] });
    seedEditor(overlay, "draft text");
    dragEditor(overlay, 0, 5);
    expect(hasEditorSelection(overlay)).toBe(true);

    (overlay as any).openModelPicker();
    expect(hasEditorSelection(overlay)).toBe(false);
  });

  test("dispose clears the editor selection", () => {
    const overlay = makeOverlay();
    seedEditor(overlay, "draft text");
    dragEditor(overlay, 0, 5);
    expect(hasEditorSelection(overlay)).toBe(true);

    (overlay as any).dispose();
    expect(hasEditorSelection(overlay)).toBe(false);
  });
});

describe("editor double/triple-click + autocomplete gating (spec #24 T4, issue #28)", () => {
  test("double-click selects the word under the click and renders the highlight", () => {
    const overlay = makeOverlay();
    seedEditor(overlay, "draft text");
    doubleClickEditor(overlay, 2);
    expect(hasEditorSelection(overlay)).toBe(true);

    const frame = overlay.render(OVERLAY_TEST_WIDTH).join("\n");
    expect(frame).toContain("\x1b[7mdraft\x1b[27m");
    expect(frame).not.toContain("\x1b[7mdraft text\x1b[27m");
  });

  test("double-click on the second word selects only that word", () => {
    const overlay = makeOverlay();
    seedEditor(overlay, "draft text");
    doubleClickEditor(overlay, 8);
    expect(hasEditorSelection(overlay)).toBe(true);

    const frame = overlay.render(OVERLAY_TEST_WIDTH).join("\n");
    expect(frame).toContain("\x1b[7mtext\x1b[27m");
    expect(frame).not.toContain("\x1b[7mdraft\x1b[27m");
  });

  test("triple-click selects the whole visual line and renders the highlight", () => {
    const overlay = makeOverlay();
    seedEditor(overlay, "draft text");
    tripleClickEditor(overlay, 2);
    expect(hasEditorSelection(overlay)).toBe(true);

    const frame = overlay.render(OVERLAY_TEST_WIDTH).join("\n");
    expect(frame).toContain("\x1b[7mdraft text\x1b[27m");
  });

  test("triple-click selects the clicked visual line only (multi-line draft)", () => {
    const overlay = makeOverlay();
    seedEditor(overlay, "first line");
    overlay.handleInput("\n");
    overlay.handleInput("second line");
    overlay.render(OVERLAY_TEST_WIDTH);

    tripleClickEditor(overlay, 3, 1);
    expect(hasEditorSelection(overlay)).toBe(true);

    const frame = overlay.render(OVERLAY_TEST_WIDTH).join("\n");
    expect(frame).toContain("\x1b[7msecond line\x1b[27m");
    expect(frame).not.toContain("\x1b[7mfirst line\x1b[27m");
  });

  test("Ctrl+C after a double-click copies the word and consumes the selection", async () => {
    const overlay = makeOverlay();
    seedEditor(overlay, "draft text");
    doubleClickEditor(overlay, 2);
    expect(hasEditorSelection(overlay)).toBe(true);

    overlay.handleInput("\x03");
    await tick();
    expect(copiedTexts()).toEqual(["draft"]);
    expect(hasEditorSelection(overlay)).toBe(false);
  });

  test("Ctrl+C after a triple-click copies the line and consumes the selection", async () => {
    const overlay = makeOverlay();
    seedEditor(overlay, "draft text");
    tripleClickEditor(overlay, 2);
    expect(hasEditorSelection(overlay)).toBe(true);

    overlay.handleInput("\x03");
    await tick();
    expect(copiedTexts()).toEqual(["draft text"]);
    expect(hasEditorSelection(overlay)).toBe(false);
  });

  test("autocomplete popup open: editor drag / double-click / triple-click produce no selection", async () => {
    const overlay = makeOverlay();
    seedEditor(overlay, "draft text");
    await openAutocomplete(overlay);
    overlay.render(OVERLAY_TEST_WIDTH);

    dragEditor(overlay, 0, 5);
    expect(hasEditorSelection(overlay)).toBe(false);

    doubleClickEditor(overlay, 2);
    expect(hasEditorSelection(overlay)).toBe(false);

    tripleClickEditor(overlay, 2);
    expect(hasEditorSelection(overlay)).toBe(false);

    expect((overlay as any).messages.hasSelection()).toBe(false);
  });
});
