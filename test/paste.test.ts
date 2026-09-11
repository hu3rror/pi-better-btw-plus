/**
 * Right-click paste in the input editor (issue #7, D4): the overlay reads the
 * system clipboard via the injected channel matrix and routes the text through
 * the Editor's built-in bracketed-paste entry, so normalization, large-paste
 * collapse to a `[paste #N …]` marker and the atomic undo snapshot all come
 * from the Editor itself. Runs against the real modules with a mocked
 * TUI/theme. The clipboard read side is mocked (helpers/clipboard-read-mock.ts,
 * mirror of the write-side facility from D13); the write side is mocked too so
 * the coexistence tests never touch the host clipboard.
 */
import { describe, expect, test } from "bun:test";
import type { SideChatOverlay as SideChatOverlayType } from "../srcs/side-chat-overlay.ts";
import { makeOverlay as sharedMakeOverlay } from "./helpers/make-overlay.ts";

// Both mocks must load before side-chat-overlay.ts (it statically imports
// copyToClipboard from @earendil-works/pi-coding-agent and
// readClipboardTextFromSystem from ./clipboard-read.ts).
await import("./helpers/clipboard-mock.ts");
const { copiedTexts } = await import("./helpers/clipboard-mock.ts");
await import("./helpers/clipboard-read-mock.ts");
const { setClipboardReadResult, setClipboardReadEmpty } = await import(
  "./helpers/clipboard-read-mock.ts",
);
const { SideChatOverlay } = await import("../srcs/side-chat-overlay.ts");
// Overlay harness: the constructor is passed in so the helper stays free of
// a static overlay import (mock.module ordering is controlled here).
const makeOverlay = (messages?: any[], overrides: Record<string, unknown> = {}) =>
  sharedMakeOverlay(SideChatOverlay, messages, overrides);

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** 1-based screen row of the editor's single content line. */
function editorRow(overlay: SideChatOverlayType): number {
  const g = (overlay as any).geometry as {
    editorTopRow: number;
    editorHeight: number;
  };
  return g.editorTopRow + 1 + 1; // editorTopRow is 0-based; +1 content, +1 to 1-based
}

function rightClick(overlay: SideChatOverlayType, row: number, col = 20): void {
  overlay.handleMouseEvent({ button: 2, col, row, isRelease: false });
  overlay.handleMouseEvent({ button: 2, col, row, isRelease: true });
}

describe("side-chat-overlay.ts right-click paste (#7)", () => {
  test("right-click over the editor pastes small text at the cursor", async () => {
    const overlay = makeOverlay();
    setClipboardReadResult("hello");
    rightClick(overlay, editorRow(overlay));
    await tick();
    expect((overlay as any).editor.getText()).toBe("hello");
  });

  test("right-click pastes at the cursor position, not only an empty editor", async () => {
    const overlay = makeOverlay();
    const ed: any = (overlay as any).editor;
    ed.handleInput("pre ");
    setClipboardReadResult("tail");
    rightClick(overlay, editorRow(overlay));
    await tick();
    expect(ed.getText()).toBe("pre tail");
  });

  test("large paste collapses to a [paste #N +X lines] marker", async () => {
    const overlay = makeOverlay();
    const big = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
    setClipboardReadResult(big);
    rightClick(overlay, editorRow(overlay));
    await tick();
    const ed: any = (overlay as any).editor;
    expect(ed.getText()).toMatch(/^\[paste #1 \+12 lines\]$/);
    // The full text is recoverable through the editor's expanded view.
    expect(ed.getExpandedText()).toBe(big);
  });

  test("chars-based marker for a >1000 char single-line paste", async () => {
    const overlay = makeOverlay();
    setClipboardReadResult("x".repeat(1001));
    rightClick(overlay, editorRow(overlay));
    await tick();
    expect((overlay as any).editor.getText()).toMatch(
      /^\[paste #1 1001 chars\]$/,
    );
  });

  test("submit sends the expanded text (not the marker) to the agent", async () => {
    const prompts: string[] = [];
    const overlay = makeOverlay(undefined, {
      // The turn loop lives in the runner: a harness runner records the
      // submitted text instead of hitting the network.
      runnerFactory: () =>
        ({
          agent: { state: { messages: [] } },
          isRunning: false,
          run: async (text: string) => {
            prompts.push(text);
          },
          cancel: () => {},
        }) as any,
    });
    const big = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
    setClipboardReadResult(big);
    rightClick(overlay, editorRow(overlay));
    await tick();
    overlay.handleInput("\r"); // Enter submits via the editor's submit path
    await tick();
    expect(prompts).toEqual([big]);
  });

  test("line endings and tabs are normalized by the editor's built-in logic", async () => {
    const overlay = makeOverlay();
    setClipboardReadResult("a\r\nb\tc");
    rightClick(overlay, editorRow(overlay));
    await tick();
    expect((overlay as any).editor.getText()).toBe("a\nb    c");
  });

  test("paste is atomic for undo", async () => {
    const overlay = makeOverlay();
    setClipboardReadResult("a\r\nb\tc");
    rightClick(overlay, editorRow(overlay));
    await tick();
    const ed: any = (overlay as any).editor;
    expect(ed.getText()).toBe("a\nb    c");
    overlay.handleInput("\x1b[45;5u"); // ctrl+- (CSI-u) undo
    expect(ed.getText()).toBe("");
  });

  test("clipboard read failure shows a hint and leaves the editor untouched", async () => {
    const overlay = makeOverlay();
    setClipboardReadResult(null);
    rightClick(overlay, editorRow(overlay));
    await tick();
    const M: any = (overlay as any).messages;
    expect(M.render(80).some((l: string) => l.includes("Clipboard read failed"))).toBe(
      true,
    );
    expect((overlay as any).editor.getText()).toBe("");
  });

  test("an empty clipboard shows a distinct hint and leaves the editor untouched", async () => {
    const overlay = makeOverlay();
    setClipboardReadEmpty();
    rightClick(overlay, editorRow(overlay));
    await tick();
    const M: any = (overlay as any).messages;
    expect(M.render(80).some((l: string) => l.includes("Clipboard is empty"))).toBe(
      true,
    );
    expect((overlay as any).editor.getText()).toBe("");
  });

  test("paste is release-triggered: release position decides", async () => {
    const overlay = makeOverlay();
    const g = (overlay as any).geometry as { msgTopRow: number; msgHeight: number };
    const chatRow = g.msgTopRow + 1; // 1-based first chat line
    setClipboardReadResult("hi");
    // press in the editor, release over the chat → no paste
    overlay.handleMouseEvent({
      button: 2,
      col: 20,
      row: editorRow(overlay),
      isRelease: false,
    });
    overlay.handleMouseEvent({ button: 2, col: 20, row: chatRow, isRelease: true });
    await tick();
    expect((overlay as any).editor.getText()).toBe("");
    // press over the chat, release in the editor → no paste either
    overlay.handleMouseEvent({ button: 2, col: 20, row: chatRow, isRelease: false });
    overlay.handleMouseEvent({
      button: 2,
      col: 20,
      row: editorRow(overlay),
      isRelease: true,
    });
    await tick();
    expect((overlay as any).editor.getText()).toBe("");
  });

  test("right-click over the header/border has no effect", async () => {
    const overlay = makeOverlay();
    setClipboardReadResult("hi");
    rightClick(overlay, 2); // header row (1-based)
    await tick();
    expect((overlay as any).editor.getText()).toBe("");
  });

  test("coexists with the copy branch: chat right-click copies, editor right-click pastes", async () => {
    const overlay = makeOverlay();
    const g = (overlay as any).geometry as { msgTopRow: number };
    const M: any = (overlay as any).messages;
    const chatRow = g.msgTopRow + 1; // 1-based first chat line
    // A retained selection + right-click over the chat copies (write side).
    M.setSelection({ line: 0, col: 7 }, { line: 0, col: 12 });
    overlay.handleMouseEvent({ button: 2, col: 20, row: chatRow, isRelease: false });
    overlay.handleMouseEvent({ button: 2, col: 20, row: chatRow, isRelease: true });
    await tick();
    expect(copiedTexts()).toEqual(["hello"]);
    // Right-click over the editor pastes, and never copies.
    setClipboardReadResult("pasted");
    rightClick(overlay, editorRow(overlay));
    await tick();
    expect((overlay as any).editor.getText()).toBe("pasted");
    expect(copiedTexts().length).toBe(0);
    // A second chat right-click copies again — the paste didn't disturb it.
    overlay.handleMouseEvent({ button: 2, col: 20, row: chatRow, isRelease: false });
    overlay.handleMouseEvent({ button: 2, col: 20, row: chatRow, isRelease: true });
    await tick();
    expect(copiedTexts()).toEqual(["hello"]);
  });

  test("right-click paste in the editor does not disturb an in-flight left drag", async () => {
    const overlay = makeOverlay();
    setClipboardReadResult("hi");
    overlay.handleMouseEvent({ button: 0, col: 19, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 32, col: 24, row: 5, isRelease: false });
    expect(overlay.isMouseDragging()).toBe(true);
    // stray right release (no press) during the drag must not paste
    overlay.handleMouseEvent({ button: 2, col: 20, row: editorRow(overlay), isRelease: true });
    await tick();
    expect((overlay as any).editor.getText()).toBe("");
    overlay.handleMouseEvent({ button: 0, col: 24, row: 5, isRelease: true });
    await tick();
    expect(copiedTexts().length).toBe(0);
  });
  test("rightClickCopyPaste=false: right-click over the editor never pastes (D11)", async () => {
    const overlay = makeOverlay(undefined, {
      features: { rightClickCopyPaste: false, modelSwitch: true, retry: true },
    });
    setClipboardReadResult("hello");
    rightClick(overlay, editorRow(overlay));
    await tick();
    expect((overlay as any).editor.getText()).toBe("");
  });
});
