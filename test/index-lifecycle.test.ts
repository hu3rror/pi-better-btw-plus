/**
 * Extension entry lifecycle (index.ts): /btw opens the fork overlay, Alt+W
 * backgrounds it, and /btw again restores the hidden overlay — same as Alt+W
 * restore. Drives the REAL index.ts closures (toggleSideChat /
 * backgroundSideChat / openSideChat) against a mocked pi boundary
 * (ExtensionAPI, ctx.ui.custom, TUI overlay handle).
 *
 * Regression for: the hidden overlay could not be re-shown via /btw (only
 * Alt+W worked) — this pins the extension-side restore path so a future break
 * in the toggle logic is caught here, independent of the pi runtime.
 */
import { describe, expect, test } from "bun:test";
import { getExtensionDir } from "../srcs/prompt-pack.ts";
import { SIDE_CHAT_SHORTCUT } from "../srcs/shortcuts.ts";

const { default: sideChatExtension } = await import("../srcs/index.ts");

const theme: any = { fg: (_n: string, t: string) => t };

function makeTui() {
  return {
    terminal: { columns: 120, rows: 40, write: () => {} },
    requestRender: () => {},
    addInputListener: () => () => {},
    hasOverlay: () => false,
  };
}

function makeHandle() {
  let hidden = false;
  let focused = false;
  return {
    isHidden: () => hidden,
    setHidden: (h: boolean) => {
      hidden = h;
    },
    focus: () => {
      focused = true;
    },
    unfocus: () => {
      focused = false;
    },
    isFocused: () => focused,
    hide: () => {
      hidden = true;
    },
    state: () => ({ hidden, focused }),
  };
}

describe("DEBUG bug1: /btw restore after Alt+W hide", () => {
  test("btw → Alt+W hide → btw restores (same as Alt+W restore)", async () => {
    const handlers: Record<string, (args: string, ctx: any) => Promise<unknown>> = {};
    let handle: ReturnType<typeof makeHandle> | null = null;
    let done: ((r: unknown) => void) | null = null;
    let notifyCount = 0;

    const pi: any = {
      registerShortcut: (name: string, opts: any) => {
        handlers[`shortcut:${name}`] = opts.handler;
      },
      registerCommand: (name: string, opts: any) => {
        handlers[`cmd:${name}`] = opts.handler;
      },
      on: () => {},
      getThinkingLevel: () => "medium",
    };

    const ui: any = {
      custom: (factory: any, options: any) => {
        const tui = makeTui();
        let component: any;
        try {
          component = factory(tui, theme, {}, (r: unknown) => done?.(r));
        } catch (err) {
          return Promise.reject(err);
        }
        if (options?.onHandle) {
          handle = makeHandle();
          options.onHandle(handle);
        }
        return new Promise((resolve) => {
          done = resolve;
        });
      },
      notify: () => {
        notifyCount++;
      },
      confirm: async () => true,
    };

    const ctx: any = {
      model: { id: "test-model" },
      cwd: process.cwd(),
      getSystemPrompt: () => "",
      sessionManager: { getEntries: () => [], getLeafId: () => null },
      modelRegistry: { getApiKeyForProvider: async () => "key" },
      scopedModels: [],
      ui,
    };

    sideChatExtension(pi);
    const btw = handlers["cmd:btw"]!;
    const altW = handlers[`shortcut:${SIDE_CHAT_SHORTCUT}`]!;
    expect(btw).toBeDefined();
    expect(altW).toBeDefined();

    // 1. open
    // 1. open — custom() hangs until done() (real pi behavior), so drive it
    // fire-and-forget; the mock custom() runs factory/onHandle synchronously.
    const openP = btw("", ctx);
    await new Promise((r) => setTimeout(r, 10));
    expect(handle).not.toBeNull();
    expect(handle!.state().hidden).toBe(false);
    expect(notifyCount).toBe(0);
    void openP;
    // 2. Alt+W hide
    await altW("", ctx);
    expect(handle!.state().hidden).toBe(true);

    // 3. /btw again — MUST restore, exactly like Alt+W would
    await btw("", ctx);
    expect(handle!.state().hidden).toBe(false);
    expect(notifyCount).toBe(0); // must not hit the "Close or background" warn
  });
});
