/**
 * Fullscreen mouse entry integration tests (ADR 0012, spec #37): in fullscreen
 * mode pi's component dispatch routes every fork-surface mouse event to
 * `SideChatOverlay.handleMouse`; this suite drives that entry with pi-style
 * `TuiMouseEvent`s (0-based absolute coords) and asserts — through the same
 * make-overlay seam as select/editor-selection suites — that the fork surface
 * behaves identically to the regular-mode SGR path: drag / double / triple /
 * right-click / wheel semantics, the region-consumption invariant (every
 * event handled, so pi's own Pi-transcript selection never starts in-region),
 * focus/capture only on left press, and — the regression this adapts for — a
 * gesture never copies anything on its own (no Pi-transcript leak; copy stays
 * hotkey/right-click only).
 */
import { describe, expect, test } from "bun:test";
import type { TuiMouseButton, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { makeOverlay as sharedMakeOverlay, OVERLAY_TEST_WIDTH } from "./helpers/make-overlay.ts";

// Both clipboard mocks must load before side-chat-overlay.ts (see
// select.test.ts / paste.test.ts ordering).
await import("./helpers/clipboard-mock.ts");
const { copiedTexts } = await import("./helpers/clipboard-mock.ts");
await import("./helpers/clipboard-read-mock.ts");
const { setClipboardReadResult } = await import("./helpers/clipboard-read-mock.ts");
const { SideChatOverlay } = await import("../srcs/side-chat-overlay.ts");

type Overlay = InstanceType<typeof SideChatOverlay>;
/** Overlay harness with a fullscreen-mode mock TUI (reporting owned by pi). */
const makeOverlay = (messages?: any[], overrides: Record<string, unknown> = {}) =>
  sharedMakeOverlay(SideChatOverlay, messages, {
    tui: {
      terminal: { columns: 120, rows: 40, write: () => {} },
      requestRender: () => {},
      mode: "fullscreen",
    },
    ...overrides,
  });

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Build a pi mouse event. Tests pass SGR-style 1-based rows/cols (the
 * regular-mode suites' convention); TuiMouseEvent coordinates are 0-based
 * absolute, so they convert here (the adapter adds +1 back on the way in).
 */
function ev(
  type: TuiMouseEvent["type"],
  button: TuiMouseButton,
  row: number,
  col: number,
  extra: Partial<TuiMouseEvent> = {},
): TuiMouseEvent {
  return {
    x: 0,
    y: 0,
    screenX: col - 1,
    screenY: row - 1,
    width: 120,
    height: 40,
    shift: false,
    alt: false,
    ctrl: false,
    ...extra,
    type,
    button,
  };
}

/** Sequence pi dispatches for one clean click: press, release, click. */
function click(overlay: Overlay, row: number, col: number, times = 1): void {
  for (let n = 0; n < times; n++) {
    overlay.handleMouse(ev("press", "left", row, col));
    overlay.handleMouse(ev("release", "left", row, col));
    overlay.handleMouse(ev("click", "left", row, col));
  }
}

/** Sequence for a left drag: press, drag, release (+ absorbed click). */
function drag(overlay: Overlay, row: number, fromCol: number, toCol: number): void {
  overlay.handleMouse(ev("press", "left", row, fromCol));
  overlay.handleMouse(ev("drag", "left", row, toCol));
  overlay.handleMouse(ev("release", "left", row, toCol));
  overlay.handleMouse(ev("click", "left", row, toCol));
}

/** 1-based screen cell of the editor content band's first cell (line 0, col 0). */
function editorOrigin(overlay: Overlay): { row: number; col: number } {
  const g = (overlay as any).geometry as { editorTopRow: number; contentCol: number };
  // Content band line 0 is one row below the editor's top border; SGR is
  // 1-based so both row and col get +1 over the 0-based geometry fields.
  return { row: g.editorTopRow + 2, col: g.contentCol + 1 };
}

function seedEditor(overlay: Overlay, text: string): void {
  overlay.handleInput(text);
  overlay.render(OVERLAY_TEST_WIDTH);
}

describe("fullscreen mouse entry (handleMouse)", () => {
  test("left press over the chat focuses + captures and seeds an inert selection", () => {
    const overlay = makeOverlay();
    const result = overlay.handleMouse(ev("press", "left", 5, 19));
    expect(result).toEqual({ handled: true, focus: true, capture: true, render: false });
    expect((overlay as any).messages.hasSelection()).toBe(false); // press alone: empty range
  });

  test("drag-select + hotkey copy matches regular mode; gestures never copy on their own", async () => {
    const overlay = makeOverlay();
    drag(overlay, 5, 19, 24);
    await tick();
    // The gesture selected but copied nothing by itself (the pre-fix bug was
    // auto-copying Pi-transcript content on selection — here: no copy at all).
    expect(copiedTexts().length).toBe(0);
    expect((overlay as any).messages.hasSelection()).toBe(true);
    overlay.handleInput("\x03");
    await tick();
    expect(copiedTexts()[0]).toBe("hello");
  });

  test("double-click over the chat selects a whole rendered line without copying", async () => {
    const overlay = makeOverlay();
    click(overlay, 5, 19, 2); // double-click (press/release/click × 2)
    await tick();
    expect((overlay as any).messages.hasSelection()).toBe(true);
    expect(copiedTexts().length).toBe(0); // regression: no copy-on-select
    overlay.handleInput("\x03");
    await tick();
    expect(copiedTexts()[0]).toContain("hello world this is a long message");
  });

  test("double-click resolves an editor word; triple-click resolves the visual line", async () => {
    const overlay = makeOverlay();
    seedEditor(overlay, "select me please");
    const { row, col } = editorOrigin(overlay);

    click(overlay, row, col + 13, 2); // double-click mid-word: "please"
    await tick();
    expect(copiedTexts().length).toBe(0); // still no auto-copy
    overlay.handleInput("\x03");
    await tick();
    expect(copiedTexts()[0]).toBe("please");

    click(overlay, row, col, 3); // triple-click
    await tick();
    overlay.handleInput("\x03");
    await tick();
    expect(copiedTexts()).toEqual(["select me please"]);
  });

  test("right-click over a chat selection copies it; right press never focuses", async () => {
    const overlay = makeOverlay();
    drag(overlay, 5, 19, 24);
    await tick();
    const pressResult = overlay.handleMouse(ev("press", "right", 5, 20));
    expect(pressResult).toEqual({ handled: true, render: false });
    expect(overlay.handleMouse(ev("release", "right", 5, 20))).toEqual({
      handled: true,
      render: false,
    });
    await tick();
    expect(copiedTexts()[0]).toBe("hello");
  });

  test("right-click over the editor pastes the system clipboard into the draft", async () => {
    const overlay = makeOverlay();
    seedEditor(overlay, "pre ");
    setClipboardReadResult("tail");
    const { row, col } = editorOrigin(overlay);
    overlay.handleMouse(ev("press", "right", row, col));
    overlay.handleMouse(ev("release", "right", row, col));
    await tick();
    expect((overlay as any).editor.getText()).toBe("pre tail");
  });

  test("wheel over the fork scrolls the fork's own transcript", () => {
    const overlay = makeOverlay([
      { role: "user", content: Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") },
    ]);
    const messages: any = (overlay as any).messages;
    expect(messages.getScrollOffset()).toBe(0);
    overlay.handleMouse(ev("wheel", "none", 5, 60, { wheelDelta: -3 })); // scroll up
    expect(messages.getScrollOffset()).toBeGreaterThan(0);
  });

  test("an in-flight drag past the fork edge keeps selecting (clamped)", async () => {
    const overlay = makeOverlay();
    // Release lands far outside the chat band; the drag clamps instead of dropping.
    drag(overlay, 5, 19, 24);
    overlay.handleMouse(ev("press", "left", 5, 19));
    overlay.handleMouse(ev("drag", "left", 5, 40));
    overlay.handleMouse(ev("release", "left", 90, 40));
    await tick();
    expect((overlay as any).messages.hasSelection()).toBe(true);
  });

  test("move and click events are absorbed: handled, no selection, no copy", async () => {
    const overlay = makeOverlay();
    expect(overlay.handleMouse(ev("move", "none", 5, 19))).toEqual({
      handled: true,
      render: false,
    });
    expect(overlay.handleMouse(ev("click", "left", 5, 19, { clickCount: 1 }))).toEqual({
      handled: true,
      render: false,
    });
    await tick();
    expect((overlay as any).messages.hasSelection()).toBe(false);
    expect(copiedTexts().length).toBe(0);
  });

  test("clicks on the header/border are consumed without starting anything", () => {
    const overlay = makeOverlay();
    const result = overlay.handleMouse(ev("press", "left", 2, 60)); // header row
    expect(result).toEqual({ handled: true, focus: true, capture: true, render: false });
    expect((overlay as any).messages.hasSelection()).toBe(false);
  });

  test("middle press and non-left drags are consumed no-ops", () => {
    const overlay = makeOverlay();
    expect(overlay.handleMouse(ev("press", "middle", 5, 19))).toEqual({
      handled: true,
      render: false,
    });
    overlay.handleMouse(ev("press", "left", 5, 19));
    overlay.handleMouse(ev("drag", "right", 5, 20));
    overlay.handleMouse(ev("release", "right", 5, 20));
    expect((overlay as any).messages.hasSelection()).toBe(false);
  });

  test("regular-mode TUI never dispatches component mouse events (defensive gate)", () => {
    const overlay = sharedMakeOverlay(SideChatOverlay); // mock tui has no mode
    const result: TuiMouseEventResult | undefined = overlay.handleMouse(ev("press", "left", 5, 19));
    expect(result).toBeUndefined();
  });
});

describe("features.fullscreenCopyOnSelect mirror (spec #37, story #18)", () => {
  const mirrorFeatures = {
    rightClickCopyPaste: true,
    modelSwitch: true,
    retry: true,
    editorSelection: true,
    fullscreenCopyOnSelect: true,
  };

  test("opt-in: a release that forms a selection copies it without consuming it", async () => {
    const overlay = makeOverlay(undefined, { features: mirrorFeatures });
    drag(overlay, 5, 19, 24);
    await tick();
    expect(copiedTexts()).toEqual(["hello"]); // copied on release…
    expect((overlay as any).messages.hasSelection()).toBe(true); // …highlight stays
  });

  test("opt-in: a plain click copies nothing", async () => {
    const overlay = makeOverlay(undefined, { features: mirrorFeatures });
    click(overlay, 5, 19);
    await tick();
    expect(copiedTexts().length).toBe(0);
    expect((overlay as any).messages.hasSelection()).toBe(false);
  });

  test("default (off): selection releases never touch the clipboard", async () => {
    const overlay = makeOverlay();
    drag(overlay, 5, 19, 24);
    await tick();
    expect(copiedTexts().length).toBe(0);
    expect((overlay as any).messages.hasSelection()).toBe(true);
  });
});