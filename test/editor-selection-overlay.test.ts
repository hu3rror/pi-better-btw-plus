/**
 * Editor-selection overlay wiring integration tests (spec #24 T3, issue #27):
 * the T1 pure module + T2 gesture surface are wired into the real overlay —
 * left-drag over the input editor produces an inverse-video highlight and
 * Ctrl+C / Ctrl+Shift+C copy the selected text with three-tier routing. These
 * cases drive the real overlay through `handleMouseEvent` / `handleInput` and
 * assert the editor-selection store, the copied text, and the cross-surface
 * lifecycle — the thin-glue behaviors the pure-module suites can't see.
 *
 * Same overlay seam and clipboard write-side mock as test/select.test.ts.
 */
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

/** Type text into the editor and re-render so the content band is current. */
function seedEditor(overlay: Overlay, text: string): void {
  overlay.handleInput(text);
  overlay.render(OVERLAY_TEST_WIDTH);
}

/**
 * Left-drag over the editor content band from `fromCol` to `toCol` (cell
 * columns, exclusive end) on line 0.
 */
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

function hasEditorSelection(overlay: Overlay): boolean {
  return (overlay as any).editorSelection.hasSelection() as boolean;
}

describe("editor-selection overlay wiring (spec #24 T3)", () => {
  test("editor left-drag selects text and Ctrl+C copies it, consuming the selection", async () => {
    const overlay = makeOverlay();
    seedEditor(overlay, "draft text");
    dragEditor(overlay, 0, 5); // "draft"
    expect(hasEditorSelection(overlay)).toBe(true);

    overlay.handleInput("\x03"); // Ctrl+C
    await tick();
    expect(copiedTexts()).toEqual(["draft"]);
    expect(hasEditorSelection(overlay)).toBe(false);
  });

  test("a drag renders the inverse-video highlight in the editor band", () => {
    const overlay = makeOverlay();
    seedEditor(overlay, "draft text");
    dragEditor(overlay, 0, 5); // "draft"

    const frame = overlay.render(OVERLAY_TEST_WIDTH).join("\n");
    // The editor's own cursor highlight never emits \x1b[27m; only the
    // selection decoration does, so this pins the actual highlight.
    expect(frame).toContain("\x1b[7mdraft\x1b[27m");
  });

  test("Ctrl+Shift+C also copies the editor selection", async () => {
    const overlay = makeOverlay();
    seedEditor(overlay, "draft text");
    dragEditor(overlay, 0, 5);

    overlay.handleInput("\x1b[99;6u"); // ctrl+shift+c (kitty CSI-u)
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

    // Add a chat selection directly (routing, not gesture, is under test).
    (overlay as any).messages.setSelection({ line: 0, col: 7 }, { line: 0, col: 12 });

    overlay.handleInput("\x03");
    await tick();
    expect(copiedTexts()).toEqual(["hello"]);
    // Chat selection consumed; the editor selection was never touched.
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

  test("a plain click on the editor clears the editor selection", () => {
    const overlay = makeOverlay();
    seedEditor(overlay, "draft text");
    dragEditor(overlay, 0, 5);
    expect(hasEditorSelection(overlay)).toBe(true);

    // Plain click = press + release at the same cell (no drag).
    const { row, col } = editorOrigin(overlay);
    overlay.handleMouseEvent({ button: 0, col: col + 5, row, isRelease: false });
    overlay.handleMouseEvent({ button: 0, col: col + 5, row, isRelease: true });
    expect(hasEditorSelection(overlay)).toBe(false);
  });

  test("starting a drag on the editor clears the chat selection", () => {
    const overlay = makeOverlay();
    seedEditor(overlay, "draft text");
    // Chat selection first (existing select.test.ts coordinates).
    overlay.handleMouseEvent({ button: 0, col: 19, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 32, col: 24, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 0, col: 24, row: 5, isRelease: true });
    expect((overlay as any).messages.hasSelection()).toBe(true);

    // Pressing in the editor clears the chat selection (cross-surface).
    dragEditor(overlay, 0, 5);
    expect((overlay as any).messages.hasSelection()).toBe(false);
    expect(hasEditorSelection(overlay)).toBe(true);
  });

  test("starting a drag on the chat clears the editor selection", () => {
    const overlay = makeOverlay();
    seedEditor(overlay, "draft text");
    dragEditor(overlay, 0, 5);
    expect(hasEditorSelection(overlay)).toBe(true);

    // Dragging in the chat clears the editor selection (cross-surface).
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
