/**
 * Regression tests for the side chat mouse selection (issue #17, C scheme):
 * drag/double-click select with an inverse-video highlight; copying is
 * hotkey-only via Ctrl+C / Ctrl+Shift+C on the retained selection. Runs
 * against the real modules with a mocked TUI/theme. The clipboard write
 * side is mocked (see helpers/clipboard-mock.ts): instead of intercepting
 * `process.stdout.write` for the OSC 52 fallback — which Windows never
 * reaches because the native clipboard addon wins — tests assert that the
 * copied text flowed into the mocked `copyToClipboard`.
 */
import { describe, expect, test } from "bun:test";
import { SideChatMessages } from "../srcs/side-chat-messages.ts";
import {
  isLeftPress,
  isLeftDrag,
  isLeftRelease,
  isRightPress,
  isRightRelease,
  isWheelEvent,
  wheelDirection,
  parseSgrMouseEvent,
} from "../srcs/side-chat-mouse.ts";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
  DEFAULT_MESSAGES,
  OVERLAY_TEST_WIDTH,
  makeOverlay as sharedMakeOverlay,
  theme,
} from "./helpers/make-overlay.ts";

// Shared clipboard write-side mock (must load before side-chat-overlay.ts,
// which imports copyToClipboard from @earendil-works/pi-coding-agent).
await import("./helpers/clipboard-mock.ts");
const { copiedTexts, setCopyImplementation, resetCopyImplementation } =
  await import("./helpers/clipboard-mock.ts");
const { SideChatOverlay } = await import("../srcs/side-chat-overlay.ts");
// Overlay harness: the constructor is passed in so the helper stays free of
// a static overlay import (mock.module ordering is controlled here).
const makeOverlay = (messages?: any[], overrides: Record<string, unknown> = {}) =>
  sharedMakeOverlay(SideChatOverlay, messages, overrides);

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
describe("side-chat-mouse.ts", () => {
  test("classifies SGR events", () => {
    const wheelUp = parseSgrMouseEvent("\x1b[<64;10;5M")!;
    const wheelDown = parseSgrMouseEvent("\x1b[<65;10;5M")!;
    const wheelRelease = parseSgrMouseEvent("\x1b[<67;10;5m")!;
    const leftPress = parseSgrMouseEvent("\x1b[<0;10;5M")!;
    const leftDrag = parseSgrMouseEvent("\x1b[<32;10;5M")!;
    const leftRelease0 = parseSgrMouseEvent("\x1b[<0;10;5m")!;
    const leftRelease3 = parseSgrMouseEvent("\x1b[<3;10;5m")!;
    const rightPress = parseSgrMouseEvent("\x1b[<2;10;5M")!;
    expect(isWheelEvent(wheelUp) && wheelDirection(wheelUp) === 1).toBe(true);
    expect(isWheelEvent(wheelDown) && wheelDirection(wheelDown) === -1).toBe(
      true,
    );
    expect(isWheelEvent(wheelRelease)).toBe(false);
    expect(isLeftPress(leftPress)).toBe(true);
    expect(isLeftDrag(leftDrag)).toBe(true);
    expect(isLeftRelease(leftRelease0)).toBe(true);
    expect(isLeftRelease(leftRelease3)).toBe(true);
    expect(isLeftPress(rightPress) || isLeftDrag(rightPress)).toBe(false);
    expect(isLeftDrag(leftPress)).toBe(false);
    expect(isLeftPress(leftDrag)).toBe(false);
  });

  test("classifies right-button events (press vs release)", () => {
    const rightPress = parseSgrMouseEvent("\x1b[<2;10;5M")!;
    const rightRelease = parseSgrMouseEvent("\x1b[<2;10;5m")!;
    const shiftRightPress = parseSgrMouseEvent("\x1b[<6;10;5M")!;
    const wheelRelease = parseSgrMouseEvent("\x1b[<67;10;5m")!;
    expect(isRightPress(rightPress)).toBe(true);
    expect(isRightRelease(rightPress)).toBe(false);
    expect(isRightRelease(rightRelease)).toBe(true);
    expect(isRightPress(rightRelease)).toBe(false);
    // modifier bits (shift = 4) don't change the button identity
    expect(isRightPress(shiftRightPress)).toBe(true);
    expect(isRightRelease(wheelRelease)).toBe(false);
  });
});

describe("side-chat-messages.ts", () => {
  test("renders lines and strips ANSI", () => {
    const messages = new SideChatMessages(theme, 10);
    messages.setMessages(DEFAULT_MESSAGES);
    const rendered = messages.render(80);
    expect(
      stripTerminalSequences(rendered[0]).startsWith("[You]: hello world"),
    ).toBe(true);
  });

  test("highlights the selection in inverse video and extracts exact text", () => {
    const messages = new SideChatMessages(theme, 10);
    messages.setMessages(DEFAULT_MESSAGES);
    messages.render(80);
    messages.setSelection({ line: 0, col: 7 }, { line: 0, col: 12 });
    const renderedSel = messages.render(80);
    expect(renderedSel[0]).toContain("\x1b[7m");
    expect(renderedSel[0]).toContain("\x1b[27m");
    expect(messages.getSelectedText()).toBe("hello");
    expect(messages.hasSelection()).toBe(true);
    messages.clearSelection();
    expect(messages.hasSelection()).toBe(false);
    expect(messages.render(80)[0]).not.toContain("\x1b[7m");
  });

  test("cross-line selection joins rendered lines", () => {
    const messages = new SideChatMessages(theme, 10);
    messages.setMessages(DEFAULT_MESSAGES);
    messages.render(80);
    // rendered layout: user msg, blank separator, assistant msg, ...
    messages.setSelection({ line: 0, col: 5 }, { line: 2, col: 8 });
    expect(messages.getSelectedText()).toBe(
      ": hello world this is a long message\n\n[Assista",
    );
  });

  test("maps CJK wide characters cell→char consistently", () => {
    const messages = new SideChatMessages(theme, 10);
    messages.setMessages([
      { role: "user", content: "你好世界hello", timestamp: 1 },
    ]);
    messages.render(80);
    // "[You]: " prefix = 7 cells, 你好 starts at cell 7
    messages.setSelection({ line: 0, col: 7 }, { line: 0, col: 13 });
    expect(messages.getSelectedText()).toBe("你好世");
  });

  test("scroll clears the selection", () => {
    const messages = new SideChatMessages(theme, 10);
    messages.setMessages(DEFAULT_MESSAGES);
    messages.render(80);
    messages.setSelection({ line: 0, col: 0 }, { line: 0, col: 5 });
    messages.scrollBy(1);
    expect(messages.hasSelection()).toBe(false);
  });

  test("appended status lines keep the selection anchored (blocker regression)", async () => {
    const messages = new SideChatMessages(theme, 10);
    messages.setMessages(DEFAULT_MESSAGES);
    messages.render(80);
    // Select the whole assistant line (line 2), like a double-click would.
    messages.setSelection({ line: 2, col: 0 }, { line: 2, col: 80 });
    const before = messages.getSelectedText();
    expect(before.startsWith("[Assistant]: assistant reply")).toBe(true);
    // Copy feedback appends a status line + blank line, shifting the window.
    messages.setToolStatus("✓ Copied 10 chars");
    const rendered = messages.render(80);
    // Selection must still resolve to the same content after the shift.
    expect(messages.getSelectedText()).toBe(before);
    // And the highlight must be on the correct (shifted) line.
    const shifted = rendered.findIndex((l) => l.includes("\x1b[7m"));
    expect(shifted).toBeGreaterThanOrEqual(0);
    expect(
      stripTerminalSequences(rendered[shifted]).startsWith(
        "[Assistant]: assistant reply",
      ),
    ).toBe(true);
    // Once the status clears, the selection keeps resolving to the content.
    messages.clearToolStatusIf("✓ Copied 10 chars");
    messages.render(80);
    expect(messages.getSelectedText()).toBe(before);
  });
});

describe("side-chat-overlay.ts", () => {
  test("geometry matches pi-tui resolveOverlayLayout for the overlay options", () => {
    const overlay = makeOverlay();
    const g = (overlay as any).geometry as {
      msgTopRow: number;
      contentCol: number;
      innerWidth: number;
      msgHeight: number;
    };
    expect(g.msgTopRow).toBe(4); // marginTop 1 + border/header/separator 3
    expect(g.contentCol).toBe(11); // leftCol 9 + border + padding 2
    expect(g.innerWidth).toBe(98); // width 102 - 4
    expect(g.msgHeight).toBeGreaterThanOrEqual(7);
    expect(g.msgHeight).toBeLessThanOrEqual(10);
  });

  test("wheel over the chat scrolls", () => {
    const overlay = makeOverlay();
    const M: any = (overlay as any).messages;
    const before = M.getScrollOffset();
    overlay.handleMouseEvent({ button: 64, col: 20, row: 5, isRelease: false });
    expect(M.getScrollOffset()).toBeGreaterThanOrEqual(before);
  });

  test("drag-select keeps the selection on release; no auto-copy", async () => {
    const overlay = makeOverlay();
    overlay.handleMouseEvent({ button: 0, col: 19, row: 5, isRelease: false }); // press at chat col 7
    overlay.handleMouseEvent({ button: 32, col: 24, row: 5, isRelease: false }); // drag to chat col 12
    expect(overlay.isMouseDragging()).toBe(true);
    overlay.handleMouseEvent({ button: 0, col: 24, row: 5, isRelease: true }); // release
    await tick();
    // No copy on release: selection is retained for the hotkey instead.
    expect(copiedTexts().length).toBe(0);
    const M: any = (overlay as any).messages;
    expect(M.hasSelection()).toBe(true);
    expect(M.getSelectedText()).toBe("hello");
  });

  test("ctrl+c copies the retained selection; no selection falls through", async () => {
    const overlay = makeOverlay();
    overlay.handleMouseEvent({ button: 0, col: 19, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 32, col: 24, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 0, col: 24, row: 5, isRelease: true });
    await tick();
    expect(copiedTexts().length).toBe(0); // nothing copied at release
    overlay.handleInput("\x03"); // raw Ctrl+C terminal byte
    await tick();
    expect(copiedTexts()[0]).toBe("hello");
    // ctrl+shift+c via kitty CSI-u (mod = shift|ctrl + 1 = 6) re-copies
    overlay.handleInput("\x1b[99;6u");
    await tick();
    expect(copiedTexts().length).toBe(1);
    // without a selection, ctrl+c must not copy (falls through to the editor)
    (overlay as any).messages.clearSelection();
    overlay.handleInput("\x03");
    await tick();
    expect(copiedTexts().length).toBe(0);
  });

  test("copy feedback shows in the status line (hotkey copy)", async () => {
    const overlay = makeOverlay();
    overlay.handleMouseEvent({ button: 0, col: 19, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 32, col: 24, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 0, col: 24, row: 5, isRelease: true });
    overlay.handleInput("\x03");
    await tick();
    const M: any = (overlay as any).messages;
    expect(M.render(80).some((l: string) => l.includes("Copied"))).toBe(true);
    copiedTexts(); // consume the copy this test produced
  });

  test("plain click clears the selection and does not copy", () => {
    const overlay = makeOverlay();
    const M: any = (overlay as any).messages;
    M.setSelection({ line: 0, col: 0 }, { line: 0, col: 3 });
    overlay.handleMouseEvent({ button: 0, col: 13, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 0, col: 13, row: 5, isRelease: true });
    expect(copiedTexts().length).toBe(0);
    expect(overlay.isMouseDragging()).toBe(false);
  });

  test("a quick click after a drag is not mistaken for a double-click", async () => {
    const overlay = makeOverlay();
    const M: any = (overlay as any).messages;
    // drag once
    overlay.handleMouseEvent({ button: 0, col: 19, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 32, col: 24, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 0, col: 24, row: 5, isRelease: true });
    await tick();
    expect(M.hasSelection()).toBe(true);
    // quick plain click right after (would have been a double-click before):
    // it must clear the selection instead of line-selecting.
    overlay.handleMouseEvent({ button: 0, col: 18, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 0, col: 18, row: 5, isRelease: true });
    await tick();
    expect(M.hasSelection()).toBe(false);
    expect(copiedTexts().length).toBe(0);
  });

  test("double-click selects the whole line; copy is hotkey-only", async () => {
    const overlay = makeOverlay();
    const M: any = (overlay as any).messages;
    overlay.handleMouseEvent({ button: 0, col: 18, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 0, col: 18, row: 5, isRelease: true });
    overlay.handleMouseEvent({ button: 0, col: 18, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 0, col: 18, row: 5, isRelease: true });
    await tick();
    // Whole rendered line selected, nothing copied yet.
    expect(M.getSelectedText().startsWith("[You]: hello world")).toBe(true);
    expect(copiedTexts().length).toBe(0);
    // Hotkey copies the line selection.
    overlay.handleInput("\x03");
    await tick();
    const copied = copiedTexts();
    expect(copied.length).toBe(1);
    expect(copied[0].startsWith("[You]: hello world")).toBe(true);
  });

  test("double-click survives a tiny motion between clicks (real-terminal hand shake)", async () => {
    // Regression: real terminals report motion (button 32) even for a 1-cell
    // move while the button is held. The drag path used to grow a real
    // selection and the release kept `lastReleaseWasDrag = true`, so the
    // second press was never classified as a double-click and line selection
    // never fired. A release inside the double-click tolerance is a click.
    const overlay = makeOverlay();
    const M: any = (overlay as any).messages;
    overlay.handleMouseEvent({ button: 0, col: 18, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 32, col: 19, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 0, col: 19, row: 5, isRelease: true });
    overlay.handleMouseEvent({ button: 0, col: 18, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 0, col: 18, row: 5, isRelease: true });
    await tick();
    expect(M.getSelectedText().startsWith("[You]: hello world")).toBe(true);
  });

  test("drag beyond the viewport clamps to the last line", () => {
    const overlay = makeOverlay();
    overlay.handleMouseEvent({ button: 0, col: 14, row: 5, isRelease: false });
    overlay.handleMouseEvent({
      button: 32,
      col: 14,
      row: 40,
      isRelease: false,
    }); // way below
    const M: any = (overlay as any).messages;
    const clamped = M.getSelectedText();
    expect(clamped.length).toBeGreaterThan(0);
    expect(clamped).toContain("tool output");
    overlay.handleMouseEvent({ button: 0, col: 14, row: 40, isRelease: true });
    expect(M.hasSelection()).toBe(true);
    expect(copiedTexts().length).toBe(0); // no auto-copy on release
  });

  test("click on the header row is not captured as a drag", () => {
    const overlay = makeOverlay();
    overlay.handleMouseEvent({ button: 0, col: 16, row: 2, isRelease: false });
    expect(overlay.isMouseDragging()).toBe(false);
  });

  test("anchor survives a mid-drag status append (review nit)", async () => {
    // Enough content to overflow the viewport so the appended status line
    // actually shifts the window (delta > 0).
    const overlay = makeOverlay();
    const M: any = (overlay as any).messages;
    M.setMessages(
      Array.from({ length: 6 }, (_, i) => ({
        role: "user",
        content: `message number ${i}`,
      })),
    );
    overlay.render(OVERLAY_TEST_WIDTH);
    // Rendered: m0, blank, m1, blank, ... m5, blank (12 lines). Window shows
    // the last 9: content lines 3..11 → m1..m5. Press on window line 4 =
    // content line 7 = m3's line, chat col 7 = "m" of "message".
    overlay.handleMouseEvent({
      button: 0,
      col: 19,
      row: 4 + 4,
      isRelease: false,
    }); // chat col 7
    overlay.handleMouseEvent({
      button: 32,
      col: 24,
      row: 4 + 4,
      isRelease: false,
    }); // chat col 12
    M.setToolStatus("✓ Copied 5 chars"); // appends 2 lines → window shifts down
    overlay.render(OVERLAY_TEST_WIDTH);
    // Release at the same screen position. The anchor must have been
    // translated with the window, so the selection starts at the content
    // that was under the pointer at press time (m3), not the shifted m4.
    overlay.handleMouseEvent({
      button: 0,
      col: 24,
      row: 4 + 4,
      isRelease: true,
    });
    // The retained selection is copied by the hotkey, with the same anchor.
    expect(M.getSelectedText()).toContain("message number 3");
    overlay.handleInput("\x03");
    await tick();
    const copied = copiedTexts();
    expect(copied.length).toBe(1);
    expect(copied[0]).toContain("message number 3");
  });

  test("cancelMouseDrag aborts an in-flight drag", () => {
    const overlay = makeOverlay();
    overlay.handleMouseEvent({ button: 0, col: 19, row: 5, isRelease: false });
    expect(overlay.isMouseDragging()).toBe(true);
    overlay.cancelMouseDrag();
    expect(overlay.isMouseDragging()).toBe(false);
    // the stale press must not swallow a later unrelated event
    overlay.handleMouseEvent({ button: 0, col: 19, row: 5, isRelease: true });
    expect(overlay.isMouseDragging()).toBe(false);
  });

  test("copy failure surfaces an error status", async () => {
    const overlay = makeOverlay();
    const M: any = (overlay as any).messages;
    M.setSelection({ line: 0, col: 0 }, { line: 0, col: 3 });
    // Make the mocked clipboard fail so the whole copy path errors out.
    setCopyImplementation(async () => {
      throw new Error("stdout closed");
    });
    const failed = await (overlay as any).copySelectionToClipboard();
    resetCopyImplementation();
    expect(failed).toBe(false);
    expect(M.render(80).some((l: string) => l.includes("Copy failed"))).toBe(
      true,
    );
  });

  test("right-click on a retained selection copies it and shows Copied", async () => {
    const overlay = makeOverlay();
    // drag-select "hello" then right-click inside the chat area
    overlay.handleMouseEvent({ button: 0, col: 19, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 32, col: 24, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 0, col: 24, row: 5, isRelease: true });
    overlay.handleMouseEvent({ button: 2, col: 20, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 2, col: 20, row: 5, isRelease: true });
    await tick();
    expect(copiedTexts()).toEqual(["hello"]);
    const M: any = (overlay as any).messages;
    expect(M.render(80).some((l: string) => l.includes("Copied"))).toBe(true);
  });

  test("right-click copy keeps the selection; right-click / ctrl+c re-copy", async () => {
    const overlay = makeOverlay();
    const M: any = (overlay as any).messages;
    overlay.handleMouseEvent({ button: 0, col: 19, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 32, col: 24, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 0, col: 24, row: 5, isRelease: true });
    overlay.handleMouseEvent({ button: 2, col: 20, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 2, col: 20, row: 5, isRelease: true });
    await tick();
    expect(copiedTexts()).toEqual(["hello"]);
    expect(M.hasSelection()).toBe(true);
    expect(M.getSelectedText()).toBe("hello");
    // another right-click re-copies the same text
    overlay.handleMouseEvent({ button: 2, col: 21, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 2, col: 21, row: 5, isRelease: true });
    await tick();
    expect(copiedTexts()).toEqual(["hello"]);
    // and Ctrl+C still copies the retained selection
    overlay.handleInput("\x03");
    await tick();
    expect(copiedTexts()).toEqual(["hello"]);
  });

  test("right-click without a selection has no side effect", async () => {
    const overlay = makeOverlay();
    overlay.handleMouseEvent({ button: 2, col: 20, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 2, col: 20, row: 5, isRelease: true });
    await tick();
    expect(copiedTexts().length).toBe(0);
  });

  test("right-click outside the chat area has no side effect", async () => {
    const overlay = makeOverlay();
    const M: any = (overlay as any).messages;
    M.setSelection({ line: 0, col: 0 }, { line: 0, col: 3 });
    // press and release on the header row (1-based row 2, above msgTopRow 4)
    overlay.handleMouseEvent({ button: 2, col: 20, row: 2, isRelease: false });
    overlay.handleMouseEvent({ button: 2, col: 20, row: 2, isRelease: true });
    await tick();
    expect(copiedTexts().length).toBe(0);
  });

  test("right-click copy is release-triggered: release position decides", async () => {
    const overlay = makeOverlay();
    const M: any = (overlay as any).messages;
    M.setSelection({ line: 0, col: 0 }, { line: 0, col: 3 });
    // press in the chat, move out, release over the header → no copy
    overlay.handleMouseEvent({ button: 2, col: 20, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 2, col: 20, row: 2, isRelease: true });
    await tick();
    expect(copiedTexts().length).toBe(0);
    // mirror: press outside the chat, release inside → no copy either
    overlay.handleMouseEvent({ button: 2, col: 20, row: 2, isRelease: false });
    overlay.handleMouseEvent({ button: 2, col: 20, row: 5, isRelease: true });
    await tick();
    expect(copiedTexts().length).toBe(0);
    // a plain right-click inside the chat still copies
    overlay.handleMouseEvent({ button: 2, col: 20, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 2, col: 20, row: 5, isRelease: true });
    await tick();
    expect(copiedTexts()).toEqual(["[Yo"]);
  });

  test("right-click does not disturb an in-flight left drag", async () => {
    const overlay = makeOverlay();
    const M: any = (overlay as any).messages;
    overlay.handleMouseEvent({ button: 0, col: 19, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 32, col: 24, row: 5, isRelease: false });
    expect(overlay.isMouseDragging()).toBe(true);
    // a stray right release (no press) during the drag must not end it or copy
    overlay.handleMouseEvent({ button: 2, col: 20, row: 5, isRelease: true });
    expect(overlay.isMouseDragging()).toBe(true);
    overlay.handleMouseEvent({ button: 0, col: 24, row: 5, isRelease: true });
    await tick();
    expect(M.hasSelection()).toBe(true);
    expect(copiedTexts().length).toBe(0);
  });

  test("wheel scrolling keeps working after a right-click", async () => {
    const overlay = makeOverlay();
    const M: any = (overlay as any).messages;
    const before = M.getScrollOffset();
    // right-click over the chat (no selection → no copy)
    overlay.handleMouseEvent({ button: 2, col: 20, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 2, col: 20, row: 5, isRelease: true });
    overlay.handleMouseEvent({ button: 64, col: 20, row: 5, isRelease: false });
    expect(M.getScrollOffset()).toBeGreaterThanOrEqual(before);
    expect(copiedTexts().length).toBe(0);
  });
  test("rightClickCopyPaste=false: right-click never copies (D11)", async () => {
    const overlay = makeOverlay(undefined, {
      features: { rightClickCopyPaste: false, modelSwitch: true, retry: true },
    });
    const M: any = (overlay as any).messages;
    M.setSelection({ line: 0, col: 7 }, { line: 0, col: 12 });
    overlay.handleMouseEvent({ button: 2, col: 20, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 2, col: 20, row: 5, isRelease: true });
    await tick();
    expect(copiedTexts().length).toBe(0);
    // Ctrl+C hotkey copy is unaffected by the right-click switch.
    overlay.handleInput("\x03");
    await tick();
    expect(copiedTexts()).toEqual(["hello"]);
  });
});
