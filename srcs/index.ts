import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, Terminal, TUI } from "@earendil-works/pi-tui";
import {
  buildSessionContext,
  ExtensionRunner,
  wrapRegisteredTools,
} from "@earendil-works/pi-coding-agent";
import { FileActivityTracker } from "./file-activity-tracker.ts";
import { loadConfig, loadRetryPolicy } from "./config.ts";
import { getExtensionDir, loadPromptPack } from "./prompt-pack.ts";
import {
  SideChatOverlay,
  type ForkContext,
} from "./side-chat-overlay.ts";
import { LAYOUT } from "./overlay-layout.ts";
import { SIDE_CHAT_SHORTCUT } from "./shortcuts.ts";
import {
  disableMouseReporting,
  enableMouseReporting,
  isLeftPress,
  parseSgrMouseEvent,
} from "./side-chat-mouse.ts";
import { extractWritePaths } from "./write-paths.ts";
let capturedRunner: ExtensionRunner | null = null;
// Patch once (module reloads re-execute this file; re-patching would nest the
// wrapper one level per /reload and eventually blow the stack). The marker
// lives in the Symbol.for registry (global across module reloads and other
// extensions) so re-entry is a no-op without a string-keyed prototype prop
// another extension could collide with.
//
// Internal-surface dependency (ADR 0009): the patch intercepts a prototype
// method, verified against pi-coding-agent 1.4.0
// (dist/core/extensions/runner.d.ts L134). SWAP POINT: a public runner /
// instance accessor removes the patch. Caveat: if the method ever becomes a
// class field (arrow-function property), this patch stops intercepting
// silently — extension tools vanish from the fork without an error — so
// re-verify on every pi version bump.
const RUNNER_CAPTURED = Symbol.for("__btwRunnerCaptured");
if (!(ExtensionRunner.prototype as unknown as Record<symbol, unknown>)[RUNNER_CAPTURED]) {
  const origGetAllRegisteredTools =
    ExtensionRunner.prototype.getAllRegisteredTools;
  (ExtensionRunner.prototype as unknown as Record<symbol, unknown>)[RUNNER_CAPTURED] = true;
  ExtensionRunner.prototype.getAllRegisteredTools = function () {
    capturedRunner = this;
    return origGetAllRegisteredTools.call(this);
  };
}

function getExtensionAgentTools(): AgentTool[] {
  if (!capturedRunner) return [];
  return wrapRegisteredTools(capturedRunner.getAllRegisteredTools(), capturedRunner);
}

const OVERLAY_BLOCKED_ERROR = "PI_SIDE_CHAT_OVERLAY_BLOCKED";

/**
 * Log an open failure that escapes openSideChat's own state cleanup
 * (fire-and-forget /btw & Alt+W paths). Error-only channel: never called on
 * the happy path, so it can't pollute the TUI's normal rendering.
 */
function logOpenFailure(error: unknown): void {
  console.error("[btw] failed to open side chat:", error);
}

const extensionDir = getExtensionDir();

export default function sideChatExtension(pi: ExtensionAPI) {
  const tracker = new FileActivityTracker();
  let activeOverlay: SideChatOverlay | null = null;
  let overlayHandle: OverlayHandle | null = null;
  let lastMessages: AgentMessage[] | null = null;
  let mouseTerminal: Terminal | null = null;
  let removeMouseListener: (() => void) | null = null;
  /** Fullscreen (ADR 0012): pi owns the xterm reporting stream, so the
   * extension must never write enable/disable sequences — its disable on
   * hide/close would kill pi's own fullscreen mouse input until the alt
   * screen re-enters (pi re-enables only at entry). Regular mode: the
   * extension owns the stream, unchanged. */
  let mouseReportingOwnedByPi = false;

  const writeMouseReporting = (on: boolean) => {
    if (!mouseTerminal) return;
    if (mouseReportingOwnedByPi) return;
    if (on) enableMouseReporting(mouseTerminal);
    else disableMouseReporting(mouseTerminal);
  };

  const installMouseHandler = (tui: TUI) => {
    if (removeMouseListener) return;
    mouseReportingOwnedByPi = tui.mode === "fullscreen";
    mouseTerminal = tui.terminal;
    writeMouseReporting(true);
    removeMouseListener = tui.addInputListener((data) => {
      const event = parseSgrMouseEvent(data);
      if (!event) return undefined;
      const overlay = activeOverlay;
      if (overlay && !overlayHandle?.isHidden()) {
        // An in-flight drag keeps consuming events even when the pointer
        // leaves the overlay, so the selection clamps to the edges.
        if (overlay.isMouseDragging()) {
          overlay.handleMouseEvent(event);
          return { consume: true };
        }
        const viewport = overlay.getViewport();
        const overOverlay =
          viewport !== null &&
          event.row >= viewport.topRow &&
          event.row < viewport.topRow + viewport.height;
        if (overOverlay) {
          // A press on the chat focuses the overlay, so the subsequent
          // Ctrl+C / Ctrl+Shift+C lands in the overlay (not the main editor)
          // and re-copies the selection.
          if (isLeftPress(event)) {
            overlayHandle?.focus();
          }
          overlay.handleMouseEvent(event);
        }
      }
      // Always consume: mouse sequences must never leak into the editor as
      // garbage input. (In fullscreen mode the alt-screen handler already
      // consumed every SGR sequence before us, so this branch only fires in
      // regular mode.)
      return { consume: true };
    });
  };

  const uninstallMouseHandler = () => {
    if (!removeMouseListener) return;
    removeMouseListener();
    removeMouseListener = null;
    if (mouseTerminal) {
      writeMouseReporting(false);
      mouseTerminal = null;
    }
  };

  /**
   * Keep terminal mouse reporting bound to overlay *visibility* (issue #17
   * Q8): backgrounding the chat (hide) must release the terminal's native
   * selection, restoring it on show. Focus is irrelevant — wheel scroll
   * keeps working while visible-but-unfocused.
   */
  const syncMouseReporting = () => {
    if (!removeMouseListener || !mouseTerminal) return;
    if (overlayHandle?.isHidden()) {
      writeMouseReporting(false);
      // Reporting is off, so no release will arrive: abort any in-flight
      // drag so a stale capture cannot swallow later events.
      activeOverlay?.cancelMouseDrag();
    } else {
      writeMouseReporting(true);
    }
  };

  const restoreOverlay = (handle: OverlayHandle) => {
    handle.setHidden(false);
    handle.focus();
    syncMouseReporting();
  };

  const hideOverlay = (handle: OverlayHandle) => {
    handle.unfocus();
    handle.setHidden(true);
    syncMouseReporting();
  };

  const backgroundSideChat = async (ctx: ExtensionContext) => {
    if (!activeOverlay) {
      void openSideChat(ctx).catch(logOpenFailure);
      return;
    }
    const handle = overlayHandle;
    if (!handle) return;
    if (handle.isHidden()) {
      restoreOverlay(handle);
    } else {
      hideOverlay(handle);
    }
  };

  pi.on("tool_execution_start", (event, ctx) => {
    if (["write", "edit", "bash"].includes(event.toolName)) {
      const paths = extractWritePaths(event.toolName, event.args);
      paths.forEach((p) => tracker.trackWrite(p, ctx.cwd));
    }
  });

  const toggleSideChat = async (ctx: ExtensionContext) => {
    if (activeOverlay) {
      const handle = overlayHandle;
      if (!handle) return;
      if (handle.isHidden()) {
        restoreOverlay(handle);
        return;
      }
      if (!handle.isFocused()) {
        handle.focus();
      }
      return;
    }
    // Fire-and-forget: the custom overlay lifecycle outlives this command
    // handler. Awaiting it blocks the main agent's input loop (the prompt()
    // call chain suspends on ctx.ui.custom until the overlay closes), so every
    // later slash command — including a second /btw meant to re-open the
    // hidden overlay — queues in pendingUserInputs and never runs. The
    // overlay's own close/refork/clear handling happens inside openSideChat.
    void openSideChat(ctx).catch(logOpenFailure);
  };

  const openSideChat = async (ctx: ExtensionContext, clear = false) => {
    // Terminal-only feature (custom overlay + mouse routing): RPC/JSON/print
    // modes have no TUI, where ctx.ui.custom is a silent no-op (extensions.md:
    // "Guard terminal-only behavior with ctx.mode === 'tui'"). Notify instead
    // so /btw outside TUI mode never looks like it ran without doing anything.
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Cannot open side chat: interactive TUI mode required", "warning");
      return;
    }
    if (!ctx.model) {
      ctx.ui.notify("Cannot open side chat: no model configured", "error");
      return;
    }

    const sessionContext = buildSessionContext(
      ctx.sessionManager.getEntries(),
      ctx.sessionManager.getLeafId(),
    );
    const config = loadConfig({
      extensionDir,
      cwd: ctx.cwd,
      onWarning: (message) => ctx.ui.notify(message, "warning"),
    });
    const retryPolicy = loadRetryPolicy({
      cwd: ctx.cwd,
      onWarning: (message) => ctx.ui.notify(message, "warning"),
    });
    const promptPack = loadPromptPack(config.promptPack, {
      extensionDir,
      notify: (message) => ctx.ui.notify(message, "warning"),
    });
    const forkContext: ForkContext = {
      messages: clear ? [] : (lastMessages ?? sessionContext.messages),
      model: ctx.model,
      systemPrompt: ctx.getSystemPrompt(),
      thinkingLevel: pi.getThinkingLevel(),
      cwd: ctx.cwd,
      extensionTools: getExtensionAgentTools(),
    };

    try {
      const action = await ctx.ui.custom<"close" | "refork" | "clear">(
        (tui, theme, _keybindings, done) => {
          if (tui.hasOverlay()) {
            setTimeout(() => {
              ctx.ui.notify(
                "Close or background the current overlay first",
                "warning",
              );
            }, 0);
            throw new Error(OVERLAY_BLOCKED_ERROR);
          }

          activeOverlay = new SideChatOverlay({
            tui,
            theme,
            forkContext,
            tracker,
            modelRegistry: ctx.modelRegistry,
            scopedModels: ctx.scopedModels,
            sessionManager: ctx.sessionManager,
            promptPack,
            readOnlyExtensionAllowlist: config.readOnlyExtensionAllowlist,
            features: config.features,
            retryPolicy,
            onOverlapWarning: (path) => showOverlapWarning(ctx.ui, path),
            onBackground: () => {
              // Defer past the current input dispatch: hiding synchronously
              // while the overlay is inside handleInput races the TUI's focus
              // bookkeeping (the overlay stays focused-but-hidden, and the
              // next keystroke gets eaten by the focus-redirect path — the
              // reported "/btw won't re-open after Alt+W" bug). The Alt+W
              // shortcut handler runs asynchronously from the editor and is
              // unaffected; this mirrors it.
              const scheduledHandle = overlayHandle;
              setTimeout(() => {
                // Identity check: if the overlay closed and a new one opened
                // within the 0ms window, only act on the handle we scheduled
                // for — never toggle a brand-new overlay.
                if (!scheduledHandle || overlayHandle !== scheduledHandle) return;
                if (scheduledHandle.isHidden()) {
                  restoreOverlay(scheduledHandle);
                } else {
                  hideOverlay(scheduledHandle);
                }
              }, 0);
            },
            onExport: (path) =>
              ctx.ui.notify(`btw chat exported → ${path}`, "info"),
            onClose: (action, messages) => {
              lastMessages = action === "close" ? messages : null;
              activeOverlay = null;
              overlayHandle = null;
              uninstallMouseHandler();
              done(action);
            },
          });
          installMouseHandler(tui);
          return activeOverlay;
        },
        {
          overlay: true,
          overlayOptions: { ...LAYOUT },
          onHandle: (handle) => {
            overlayHandle = handle;
            handle.focus();
          },
        },
      );
      if (action === "refork") return openSideChat(ctx);
      if (action === "clear") return openSideChat(ctx, true);
    } catch (error) {
      if (error instanceof Error && error.message === OVERLAY_BLOCKED_ERROR) {
        return;
      }
      activeOverlay = null;
      overlayHandle = null;
      uninstallMouseHandler();
      throw error;
    }
  };

  pi.registerShortcut(SIDE_CHAT_SHORTCUT, {
    description: "Open / background / restore the side chat (keeps it running)",
    handler: backgroundSideChat,
  });

  pi.registerCommand("side", {
    description: "Open side chat (fork conversation)",
    handler: (_, ctx) => toggleSideChat(ctx),
  });

  pi.registerCommand("btw", {
    description: "Open side chat (fork conversation) — alias for /side",
    handler: (_, ctx) => toggleSideChat(ctx),
  });
}

function showOverlapWarning(
  ui: ExtensionUIContext,
  path: string,
): Promise<boolean> {
  return ui.confirm(
    "File Overlap",
    `Main agent has modified:\n  ${path}\n\nEditing may cause conflicts. Proceed?`,
  );
}
