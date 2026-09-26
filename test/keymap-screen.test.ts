/**
 * Keymap screen + compact hint bar (issue #35): the overlay's public
 * behavior — Ctrl+O opens the keymap screen modal (grouped, feature-gated),
 * Esc closes it, and the compact hint bar renders with the pi-aligned
 * full-word grammar. External-behavior only: drive `handleInput` with
 * terminal sequences and assert the rendered frame.
 */
import { describe, expect, mock, test } from "bun:test";
import {
  makeOverlay,
  OVERLAY_TEST_WIDTH,
} from "./helpers/make-overlay.ts";

// The overlay calls pi's getSelectListTheme when the model picker opens
// (lazy closure over the global theme singleton — throws without initTheme),
// so mock it with a plain theme before importing the overlay, like
// model-switch.test.ts does.
const realPi = await import("@earendil-works/pi-coding-agent");
const identity = (text: string) => text;
mock.module("@earendil-works/pi-coding-agent", () => ({
  ...realPi,
  getSelectListTheme: () => ({
    selectedPrefix: identity,
    selectedText: identity,
    description: identity,
    scrollInfo: identity,
    noMatch: identity,
  }),
}));
const { SideChatOverlay } = await import("../srcs/side-chat-overlay.ts");

/** Frame text of the overlay's current render (the mock theme emits no ANSI). */
function frameText(overlay: { render(width: number): string[] }): string {
  return overlay.render(OVERLAY_TEST_WIDTH).join("\n");
}

const CTRL_O = "\x0f"; // legacy Ctrl+O: SI (0x0F)
const CTRL_L = "\x0c"; // legacy Ctrl+L: form feed (0x0C)
const ESC = "\x1b";

/** Minimal real-shaped model fixture (same shape as model-switch.test.ts). */
function makeModel(id: string): any {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "test",
    baseUrl: "http://test.local",
    reasoning: true,
    thinkingLevelMap: {},
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };
}

/** Minimal ModelRegistry stub with an authenticated model for picker tests. */
function makeRegistry(models: any[]): any {
  return {
    getAvailable: () => models,
    hasConfiguredAuth: () => true,
    getProviderDisplayName: () => "Test Provider",
    streamSimple: async () => {},
  };
}

describe("compact hint bar (pi-aligned grammar)", () => {
  test("renders the two-row essentials with full-word modifiers", () => {
    const overlay = makeOverlay(SideChatOverlay);
    const frame = frameText(overlay);
    expect(frame).toContain("Enter send");
    expect(frame).toContain("Esc close");
    expect(frame).toContain("Alt+T mode");
    expect(frame).toContain("Ctrl+V paste");
    expect(frame).toContain("Ctrl+C copy");
    expect(frame).toContain("Alt+W bg");
    expect(frame).toContain("Ctrl+O help");
  });

  test("no longer advertises copy variants, scroll keys, or right-click prose", () => {
    const overlay = makeOverlay(SideChatOverlay);
    const frame = frameText(overlay);
    expect(frame).not.toContain("Ctrl+X");
    expect(frame).not.toContain("Alt+Shift+C");
    expect(frame).not.toContain("Pg/Scr");
    expect(frame).not.toContain("R-click");
    expect(frame).not.toContain("A+⇧C");
  });
});

describe("keymap screen (Ctrl+O modal)", () => {
  test("Ctrl+O opens the grouped keymap screen", () => {
    const overlay = makeOverlay(SideChatOverlay);
    overlay.handleInput(CTRL_O);
    const frame = frameText(overlay);
    expect(frame).toContain("Keymap");
    expect(frame).toContain("Navigation");
    expect(frame).toContain("Conversation");
    expect(frame).toContain("Copy & Paste");
    expect(frame).toContain("Mode & Model");
    expect(frame).toContain("Scrolling");
    expect(frame).toContain("Mouse");
    expect(frame).toContain("Alt+W background");
    expect(frame).toContain("Alt+R refork");
    expect(frame).toContain("Alt+N new");
    expect(frame).toContain("Alt+E export");
    expect(frame).toContain("Ctrl+C/Ctrl+Shift+C copy");
    expect(frame).toContain("Ctrl+X last");
    expect(frame).toContain("Alt+Shift+C draft");
    expect(frame).toContain("Ctrl+V/Alt+V paste");
    expect(frame).toContain("Ctrl+L model picker");
    expect(frame).toContain("Alt+T toggle edit/read-only");
    expect(frame).toContain("PageUp/PageDown");
    expect(frame).toContain("Shift+↑/↓");
    expect(frame).toContain("right-click copy (chat)");
    expect(frame).toContain("right-click paste (editor)");
  });

  test("Esc closes the keymap screen and restores the compact bar", () => {
    const overlay = makeOverlay(SideChatOverlay);
    overlay.handleInput(CTRL_O);
    expect(frameText(overlay)).toContain("Navigation");
    overlay.handleInput(ESC);
    const frame = frameText(overlay);
    expect(frame).not.toContain("Navigation");
    expect(frame).toContain("Enter send");
    expect(frame).toContain("Ctrl+O help");
  });

  test("keymap and picker modals keep the frame height stable", () => {
    const overlay = makeOverlay(SideChatOverlay, [], {
      modelRegistry: makeRegistry([makeModel("model-a")]),
    });
    const normal = overlay.render(OVERLAY_TEST_WIDTH).length;
    overlay.handleInput(CTRL_O);
    const keymap = overlay.render(OVERLAY_TEST_WIDTH).length;
    overlay.handleInput(ESC);
    overlay.handleInput(CTRL_L);
    const picker = overlay.render(OVERLAY_TEST_WIDTH).length;
    expect(keymap).toBe(normal);
    expect(picker).toBe(normal);
  });

  test("gating: modelSwitch=false hides the Ctrl+L row, other actions stay", () => {
    const overlay = makeOverlay(SideChatOverlay, [], {
      features: {
        rightClickCopyPaste: true,
        modelSwitch: false,
        retry: true,
        editorSelection: true,
      },
    });
    overlay.handleInput(CTRL_O);
    const frame = frameText(overlay);
    expect(frame).not.toContain("Ctrl+L");
    expect(frame).toContain("Alt+T toggle edit/read-only");
    expect(frame).toContain("Alt+R refork");
  });

  test("gating: rightClickCopyPaste=false hides the right-click row, hotkeys stay", () => {
    const overlay = makeOverlay(SideChatOverlay, [], {
      features: {
        rightClickCopyPaste: false,
        modelSwitch: true,
        retry: true,
        editorSelection: true,
      },
    });
    overlay.handleInput(CTRL_O);
    const frame = frameText(overlay);
    expect(frame).not.toContain("right-click");
    expect(frame).toContain("Ctrl+X last");
  });

  test("Ctrl+O opens the keymap over the picker; Esc returns to the picker", () => {
    const overlay = makeOverlay(SideChatOverlay, [], {
      modelRegistry: makeRegistry([makeModel("model-a")]),
    });
    overlay.handleInput(CTRL_L);
    expect(frameText(overlay)).toContain("Select model");
    // The picker's own hint row advertises Ctrl+O help, so it must work here.
    overlay.handleInput(CTRL_O);
    const keymap = frameText(overlay);
    expect(keymap).toContain("Navigation");
    expect(keymap).not.toContain("Select model");
    overlay.handleInput(ESC);
    const back = frameText(overlay);
    expect(back).toContain("Select model");
    expect(back).not.toContain("Navigation");
  });

  test("mutual exclusion: Ctrl+L is a no-op while the keymap screen is open", () => {
    const overlay = makeOverlay(SideChatOverlay);
    overlay.handleInput(CTRL_O);
    overlay.handleInput(CTRL_L);
    const frame = frameText(overlay);
    expect(frame).toContain("Navigation");
    expect(frame).not.toContain("Select model");
  });

  test("model picker modal advertises its own hint row plus Ctrl+O help", () => {
    const overlay = makeOverlay(SideChatOverlay, [], {
      modelRegistry: makeRegistry([makeModel("model-a")]),
    });
    overlay.handleInput(CTRL_L);
    const frame = frameText(overlay);
    expect(frame).toContain("↑/↓ select · Enter confirm · Esc cancel");
    expect(frame).toContain("Ctrl+O help");
  });
});
