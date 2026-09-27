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

/** Minimal pi mock: routes registrations into `handlers` (commands/shortcuts). */
function makePi(handlers: Record<string, (...args: any[]) => Promise<unknown>>): any {
  return {
    registerShortcut: (name: string, opts: any) => {
      handlers[`shortcut:${name}`] = opts.handler;
    },
    registerCommand: (name: string, opts: any) => {
      handlers[`cmd:${name}`] = opts.handler;
    },
    on: () => {},
    getThinkingLevel: () => "medium",
  };
}

/** Base command context (mode/ui overridable per test). */
function makeCtx(overrides: Record<string, any> = {}) {
  return {
    model: { id: "test-model" },
    mode: "tui",
    cwd: process.cwd(),
    getSystemPrompt: () => "",
    sessionManager: { getEntries: () => [], getLeafId: () => null },
    modelRegistry: { streamSimple: async () => {} },
    scopedModels: [],
    ...overrides,
  };
}

describe("DEBUG bug1: /btw restore after Alt+W hide", () => {
  test("btw → Alt+W hide → btw restores (same as Alt+W restore)", async () => {
    const handlers: Record<string, (...args: any[]) => Promise<unknown>> = {};
    let handle: ReturnType<typeof makeHandle> | null = null;
    let done: ((r: unknown) => void) | null = null;
    let notifyCount = 0;

    const pi = makePi(handlers);

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

    const ctx: any = makeCtx({ ui });

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
    // 2. Alt+W hide — shortcut handlers take a single (ctx) argument.
    await altW(ctx);
    expect(handle!.state().hidden).toBe(true);

    // 3. /btw again — MUST restore, exactly like Alt+W would
    await btw("", ctx);
    expect(handle!.state().hidden).toBe(false);
    expect(notifyCount).toBe(0); // must not hit the "Close or background" warn
  });
});

describe("non-TUI mode guard (openSideChat)", () => {
  test("/btw outside TUI mode notifies and never opens the overlay", async () => {
    const handlers: Record<string, (...args: any[]) => Promise<unknown>> = {};
    let customCalls = 0;
    const notify: string[] = [];

    const pi = makePi(handlers);

    const ui: any = {
      // The overlay factory must never run outside TUI mode — a silent no-op
      // there is exactly what the guard exists to prevent.
      custom: () => {
        customCalls++;
        throw new Error("ctx.ui.custom must not run outside TUI mode");
      },
      notify: (message: string, type: string) => notify.push(`${type}:${message}`),
      confirm: async () => true,
    };

    const ctx: any = makeCtx({ mode: "print", ui });

    sideChatExtension(pi);
    const btw = handlers["cmd:btw"]!;
    const side = handlers["cmd:side"]!;
    const altW = handlers[`shortcut:${SIDE_CHAT_SHORTCUT}`]!;

    await btw("", ctx);
    await side("", ctx);
    await altW(ctx); // shortcut handlers take a single (ctx) argument

    expect(customCalls).toBe(0);
    expect(notify).toEqual([
      "warning:Cannot open side chat: interactive TUI mode required",
      "warning:Cannot open side chat: interactive TUI mode required",
      "warning:Cannot open side chat: interactive TUI mode required",
    ]);
  });
});
