import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import {
  buildSessionContext,
  convertToLlm,
  copyToClipboard,
  createCodingTools,
  createReadOnlyTools,
  getSelectListTheme,
  type ModelRegistry,
  type SessionEntry,
  type Theme,
  type ThemeColor,
  type ScopedModel,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  Editor,
  Key,
  matchesKey,
  SelectList,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type SelectItem,
  type TUI,
} from "@earendil-works/pi-tui";
import type { FileActivityTracker } from "./file-activity-tracker.ts";
import { forkSurgery } from "./fork-surgery.ts";
import {
  readClipboardTextFromSystem,
  type ClipboardReadOutcome,
} from "./clipboard-read.ts";
import { exportChatHistoryToFile } from "./side-chat-export.ts";
import {
  isLeftDrag,
  isLeftPress,
  isLeftRelease,
  isRightPress,
  isRightRelease,
  isWheelEvent,
  type SgrMouseEvent,
  wheelDirection,
} from "./side-chat-mouse.ts";
import { substituteTemplate, type PromptPack } from "./prompt-pack.ts";
import {
  isFramingMessage,
  markFramingMessage,
  SideChatMessages,
  type CellPos,
} from "./side-chat-messages.ts";
import {
  buildModelChoices,
  clampThinkingLevelForModel,
  modelKey,
  type ModelChoice,
} from "./model-switch.ts";
import { SIDE_CHAT_SHORTCUT } from "./shortcuts.ts";
import { wrapToolsWithOverlapDetection } from "./tool-wrapper.ts";
import type { SideChatFeatures } from "./config.ts";
import {
  classifyRetryable,
  runWithRetry,
  type RetryableFailure,
  type RetryableInput,
  type RetryAttemptInfo,
  type RetryPolicy,
} from "./retry.ts";
export interface ForkContext {
  messages: AgentMessage[];
  model: Model<any>;
  systemPrompt: string;
  thinkingLevel: ThinkingLevel;
  cwd: string;
  extensionTools: AgentTool[];
}

/** Minimal session view used by the side chat (getEntries + getLeafId). */
type SessionView = { getEntries(): SessionEntry[]; getLeafId(): string | null };

interface SideChatOverlayOptions {
  tui: TUI;
  theme: Theme;
  forkContext: ForkContext;
  tracker: FileActivityTracker;
  modelRegistry: ModelRegistry;
  /** Models scoped to this session (--models / enabledModels); empty when unscoped. */
  scopedModels: readonly ScopedModel[];
  sessionManager: SessionView;
  /** Prompt texts resolved from config.json `promptPack` (fresh per fork). */
  promptPack: PromptPack;
  /** Extension tools allowed in read-only mode (config.json, git-untracked). */
  readOnlyExtensionAllowlist: string[];
  /** `settings.retry` budget/backoff read from pi's settings files (D8). */
  retryPolicy: RetryPolicy;
  /** Per-feature kill switches resolved from the layered config (D11). */
  features: SideChatFeatures;
  onOverlapWarning: (path: string) => Promise<boolean>;
  onBackground: () => void;
  onClose: (
    action: "close" | "refork" | "clear",
    messages: AgentMessage[],
  ) => void;
  /** Alt+E export written to $CWD/.agents/eval/ — called with the written path. */
  onExport: (path: string) => void;
}

/** Overlay max-height used for the side chat (adapted for small terminals at render time). */
export const SIDE_CHAT_OVERLAY_MAX_HEIGHT = "88%";
export const SIDE_CHAT_OVERLAY_MARGIN_TOP = 1;
/** Overlay width (percent) and horizontal margins, matching index.ts overlayOptions. */
const SIDE_CHAT_OVERLAY_WIDTH = "85%";
const SIDE_CHAT_OVERLAY_MARGIN_LEFT = 2;
const SIDE_CHAT_OVERLAY_MARGIN_RIGHT = 2;
/** Two quick presses within this window (same line) count as a double-click → select line. */
const DOUBLE_CLICK_INTERVAL_MS = 500;

/**
 * True when a drag release ended within the double-click tolerance (same
 * line, within a couple of cells). Real terminals report motion even for
 * 1-cell hand shake during a double-click, so a selection this small is a
 * click, not a drag — it must not suppress the next press's double-click
 * classification. Only the same line counts: a real cross-line drag of a
 * couple of cells stays a drag, never a click.
 */
function selectionWithinClickTolerance(a: CellPos, b: CellPos): boolean {
  return a.line === b.line && Math.abs(a.col - b.col) <= 2;
}
/** Wheel scroll step in lines (matches the previous mouse handler). */
const WHEEL_SCROLL_LINES = 3;
/**
 * Drag-render coalescing: mouse motion events fire per cell moved, and every
 * render redraws the whole frame (main screen + overlay). Capping drag
 * renders to ~30fps keeps the highlight fluid without saturating the event
 * loop on long drags. The selection state still updates on every event;
 * only the paint is throttled, and the release always paints the final look.
 */
const DRAG_RENDER_INTERVAL_MS = 32;
/** Feedback shown after a copy, cleared shortly after. */
const COPIED_STATUS_PREFIX = "✓ Copied ";
const COPIED_STATUS_CLEAR_MS = 1200;
/** Degradation hint when every clipboard read channel fails (C1 unavailable). */
const PASTE_FAILED_STATUS = "Clipboard read failed";
/** Hint when the clipboard is readable but holds no text. */
const PASTE_EMPTY_STATUS = "Clipboard is empty";
const PASTE_STATUS_CLEAR_MS = 1200;

/** Screen geometry of the overlay widgets (0-based terminal coordinates). */
interface ChatGeometry {
  /** Screen row of the first message line. */
  msgTopRow: number;
  /** Screen column of the first message cell (inside the left border). */
  contentCol: number;
  /** Message area width in cells. */
  innerWidth: number;
  /** Number of visible message lines. */
  msgHeight: number;
  /** Screen row of the input editor widget's top border. */
  editorTopRow: number;
  /** Height of the input editor widget in rows (border + content + border). */
  editorHeight: number;
}

/**
 * Chat area height (message lines): 2.5x the original (~0.35 * rows - 10),
 * adapted to small terminals so the overlay never overflows the screen and
 * always leaves a few rows of the main editor visible.
 */
export function computeSideChatHeight(rows: number): number {
  const original = Math.max(3, Math.floor(rows * 0.35) - 10);
  const desired = Math.round(original * 2.5);
  // 7 fixed rows (borders, header, editor, hints) around the message area.
  const overlayCap = Math.max(9, Math.min(Math.floor(rows * 0.88), rows - 4));
  return Math.max(3, Math.min(desired, overlayCap - 7));
}

/**
 * Shared-prefix layout (#9, reverses decision #6): the main lane's system
 * prompt stays in the system slot (verbatim, token-identical request head),
 * and the fork snapshot is injected verbatim below it — main and btw share
 * the gateway's cached prefix. The btw identity/instruction texts live in
 * the prompt pack (framing block message + per-turn focus anchor).
 */

// --- Lane enforcement (prototype for #8, texts from the prompt pack #13) ---
// Trigger points only: transformContext (reminder injection) / beforeToolCall
// (block reason) / afterToolCall (failed-note). UI copy stays in code.

const LANE_BLOCKED_STATUS = "🚧 lane blocked";
const PRE_ABORT_TEXT = "Turn stopped after repeated out-of-lane attempts.";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class SideChatOverlay implements Component, Focusable {
  private agent: Agent;
  private messages: SideChatMessages;
  private editor: Editor;
  private isStreaming = false;
  private streamingContent = "";
  private toolMode: "full" | "read-only" = "read-only";
  private _focused = true;
  private disposed = false;
  private forkLeafId: string | null;
  private peekMainTool: AgentTool;
  private spinnerInterval: NodeJS.Timeout | null = null;
  private spinnerFrame = 0;
  private lastRenderHeight = 0;
  /** Geometry of the last render (screen coords), used for mouse hit-testing. */
  private geometry: ChatGeometry | null = null;
  /** Mouse drag state: set while a left-button selection drag is in progress. */
  private mouseDragging = false;
  /** Right-press landed in the chat area; the copy action fires on release there. */
  private rightPressInChat = false;
  /** Right-press landed in the input editor; the paste action fires on release there. */
  private rightPressInEditor = false;
  private mouseAnchor: CellPos = { line: 0, col: 0 };
  private lastPressTime = 0;
  private lastPressPos: CellPos | null = null;
  private pendingDoubleClick = false;
  /** The last release ended a drag; a quick follow-up click must not count as a double-click. */
  private lastReleaseWasDrag = false;
  /** Timestamp of the last render triggered by a drag motion event (coalescing). */
  private lastDragRenderAt = 0;
  /** Clears the current transient tool-status line (copy feedback / read-failed hint). */
  private transientClearTimer: NodeJS.Timeout | null = null;
  /** Leading messages injected from the main lane at fork time (context cite). */
  private forkedMessageCount: number;
  /** Tool names allowed in the read-only lane (builtins + allowlist + peek_main). */
  private readOnlyToolNames = new Set<string>();
  /** Out-of-lane attempts in the current turn (reset on each new user message). */
  private laneViolations = 0;
  /** Reminder queued for injection by transformContext before the next LLM call. */
  private pendingReminder: string | null = null;
  /** When true, the turn is aborted right after the escalated reminder is injected. */
  private abortAfterInject = false;
  /** Open Alt+M model picker modal, or null when closed (modal replaces the chat area). */
  private modelPicker: SelectList | null = null;
  /** Choices backing the open picker (index-aligned with its SelectItems). */
  private modelPickerChoices: ModelChoice[] = [];
  /**
   * Per-turn retry cancellation (D9): Esc aborts this controller so the
   * backoff wait stops and the last error surfaces as the final result. Null
   * while no turn is in flight.
   */
  private retryAbortController: AbortController | null = null;
  /** Countdown ticker for the retry status line (cleared when the wait ends). */
  private retryCountdown: NodeJS.Timeout | null = null;

  /**
   * Chat area height (message lines): 2.5x the original (~0.35 * rows - 10),
   * adapted to small terminals so the overlay never overflows the screen and
   * always leaves a few rows of the main editor visible.
   */
  private computeChatHeight(): number {
    return computeSideChatHeight(this.options.tui.terminal.rows);
  }

  /**
   * Screen region occupied by the overlay (0-based rows), used to route mouse
   * wheel events to the chat. Returns null when the overlay is gone.
   */
  getViewport(): { topRow: number; height: number } | null {
    if (this.disposed) return null;
    const rows = this.options.tui.terminal.rows;
    const maxHeight = Math.max(
      1,
      Math.min(
        parsePercent(SIDE_CHAT_OVERLAY_MAX_HEIGHT, rows),
        Math.max(1, rows - SIDE_CHAT_OVERLAY_MARGIN_TOP),
      ),
    );
    return {
      topRow: SIDE_CHAT_OVERLAY_MARGIN_TOP,
      height: Math.min(this.lastRenderHeight, maxHeight),
    };
  }

  /** Scroll the message area (positive = toward older content). Mouse wheel handler. */
  scrollByLines(lines: number): boolean {
    const changed = this.messages.scrollBy(lines);
    if (changed) this.options.tui.requestRender();
    return changed;
  }

  /** True while a left-button drag is captured (events stay consumed even off-overlay). */
  isMouseDragging(): boolean {
    return this.mouseDragging;
  }

  /**
   * Abort an in-flight drag without waiting for the release (used when the
   * overlay is hidden mid-drag and mouse reporting is turned off).
   */
  cancelMouseDrag(): void {
    this.mouseDragging = false;
    this.rightPressInChat = false;
    this.rightPressInEditor = false;
    this.pendingDoubleClick = false;
    this.messages.clearSelection();
  }

  /**
   * Handle an SGR mouse event located over the overlay. Screen coordinates
   * are 1-based (as reported by the terminal); the chat area is hit-tested
   * against the geometry of the last render.
   */
  handleMouseEvent(event: SgrMouseEvent): void {
    // Modal model picker: pointer events are ignored until it closes.
    if (this.modelPicker) return;
    if (isWheelEvent(event)) {
      this.scrollByLines(wheelDirection(event) * WHEEL_SCROLL_LINES);
      return;
    }
    if (isLeftPress(event)) {
      const pos = this.screenToChat(event.row - 1, event.col - 1);
      if (!pos) return;
      const now = Date.now();
      const doubleClick =
        this.lastPressPos !== null &&
        !this.lastReleaseWasDrag &&
        now - this.lastPressTime <= DOUBLE_CLICK_INTERVAL_MS &&
        Math.abs(pos.line - this.lastPressPos.line) <= 1 &&
        Math.abs(pos.col - this.lastPressPos.col) <= 2;
      this.mouseDragging = true;
      this.mouseAnchor = pos;
      this.lastPressPos = pos;
      this.lastPressTime = now;
      this.pendingDoubleClick = doubleClick;
      // Seed the selection with the anchor (empty range): the window-shift
      // translation in render() then keeps the anchor aligned with the same
      // content when status/stream lines are appended mid-drag.
      this.messages.setSelection(pos, pos);
      this.options.tui.requestRender();
      return;
    }
    if (isLeftDrag(event)) {
      if (!this.mouseDragging) return;
      const pos = this.clampScreenToChat(event.row - 1, event.col - 1);
      const anchor = this.messages.getSelectionAnchor() ?? this.mouseAnchor;
      this.messages.setSelection(anchor, pos);
      // Coalesce drag paints: the selection state is always current (the next
      // render picks it up), only the number of full-frame redraws is capped.
      const now = Date.now();
      if (now - this.lastDragRenderAt >= DRAG_RENDER_INTERVAL_MS) {
        this.lastDragRenderAt = now;
        this.options.tui.requestRender();
      }
      return;
    }
    if (isLeftRelease(event)) {
      if (!this.mouseDragging) return;
      this.mouseDragging = false;
      if (this.pendingDoubleClick) {
        // Double-click: select the whole rendered line (no auto-copy; the
        // hotkey copies it).
        this.pendingDoubleClick = false;
        this.lastReleaseWasDrag = false;
        const pos = this.clampScreenToChat(event.row - 1, event.col - 1);
        this.messages.setSelection(
          { line: pos.line, col: 0 },
          { line: pos.line, col: this.geometry?.innerWidth ?? 0 },
        );
        this.options.tui.requestRender();
        return;
      }
      this.pendingDoubleClick = false;
      const pos = this.clampScreenToChat(event.row - 1, event.col - 1);
      if (this.messages.hasSelection()) {
        // Drag-release: finalize the selection (the anchor may have been
        // window-shifted by appended status/stream lines mid-drag). The
        // selection stays highlighted so Ctrl+C copies it (hotkey-only copy).
        const anchor = this.messages.getSelectionAnchor() ?? this.mouseAnchor;
        this.messages.setSelection(anchor, pos);
        // A selection that ends within the double-click tolerance is a click
        // with hand shake, not a drag: real terminals report motion (button 32)
        // even for 1-cell moves, so without this the tiniest movement while
        // double-clicking marks the release as a drag and the second press is
        // never classified as a double-click (bug: line-select never fires).
        this.lastReleaseWasDrag = !selectionWithinClickTolerance(anchor, pos);
      } else {
        // Plain click without drag: no selection.
        this.messages.clearSelection();
        this.lastReleaseWasDrag = false;
      }
      this.options.tui.requestRender();
    }
    if (isRightPress(event)) {
      // Track where the right press landed; the actual action fires on
      // release, so a press-then-move-out-then-release does nothing. The
      // feature switch (D11) disables both right-click branches entirely —
      // an unrecorded press leaves the release branch a no-op.
      if (this.options.features.rightClickCopyPaste) {
        this.rightPressInChat =
          this.screenToChat(event.row - 1, event.col - 1) !== null;
        this.rightPressInEditor = this.isOverEditor(event.row - 1);
      }
      return;
    }
    if (isRightRelease(event)) {
      // Right-click (release-triggered), one shared hit branch per D2: a
      // press+release over the chat area with an active mouse selection
      // copies it; a press+release over the input editor pastes the system
      // clipboard. The release position decides — pressing in one area and
      // releasing in the other does nothing, and a release elsewhere
      // (header/border) is ignored.
      const pressInChat = this.rightPressInChat;
      const pressInEditor = this.rightPressInEditor;
      this.rightPressInChat = false;
      this.rightPressInEditor = false;
      if (pressInChat) {
        if (this.screenToChat(event.row - 1, event.col - 1) === null) return;
        if (!this.messages.hasSelection()) return;
        void this.copySelectionToClipboard();
        return;
      }
      if (pressInEditor) {
        if (!this.isOverEditor(event.row - 1)) return;
        void this.pasteFromClipboard();
        return;
      }
    }
  }

  /**
   * Copy the current mouse selection to the clipboard (native → wl-copy /
   * xclip → OSC 52 cascade via {@link copyToClipboard}, matching the main
   * app's tree selector) and show a transient status. Copying is hotkey-only:
   * `Ctrl+C` / `Ctrl+Shift+C` with an active mouse selection. The selection
   * stays highlighted so a second copy key press re-copies. Returns false when
   * there is nothing to copy.
   */
  async copySelectionToClipboard(): Promise<boolean> {
    const text = this.messages.getSelectedText();
    if (!text) return false;
    try {
      await copyToClipboard(text);
    } catch (error) {
      this.messages.setErrorContent(
        `Copy failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.options.tui.requestRender();
      return false;
    }
    const status = `${COPIED_STATUS_PREFIX}${Array.from(text).length} chars`;
    this.showTransientStatus(status, COPIED_STATUS_CLEAR_MS);
    return true;
  }

  /**
   * Right-click paste (issue #7, D4): read plain text from the system
   * clipboard via the injected platform-channel matrix (clipboard-read.ts,
   * D3 — never throws), then route the text through the Editor's built-in
   * paste entry (bracketed paste), so normalization (\r→\n, \t→4 spaces),
   * large-paste collapse to a `[paste #N …]` marker and the atomic undo
   * snapshot all come from the Editor itself — identical to a native
   * terminal paste. When the read fails or the clipboard holds no text the
   * editor is left untouched and a transient, reason-specific hint is shown.
   */
  private async pasteFromClipboard(): Promise<void> {
    let outcome: ClipboardReadOutcome;
    try {
      outcome = await readClipboardTextFromSystem();
    } catch {
      outcome = { ok: false, reason: "unavailable" };
    }
    if (!outcome.ok) {
      const status =
        outcome.reason === "empty" ? PASTE_EMPTY_STATUS : PASTE_FAILED_STATUS;
      this.showTransientStatus(status, PASTE_STATUS_CLEAR_MS);
      return;
    }
    // Bracketed paste is the only paste entry the Editor exposes (handlePaste
    // is private); the same sequences a native terminal paste produces.
    this.editor.handleInput(`\x1b[200~${outcome.text}\x1b[201~`);
    this.options.tui.requestRender();
  }

  /**
   * Show a tool-status line that clears itself after `clearMs`. Shared by
   * the copy feedback and the clipboard-read hints.
   */
  private showTransientStatus(status: string, clearMs: number): void {
    this.messages.setToolStatus(status);
    this.options.tui.requestRender();
    if (this.transientClearTimer) clearTimeout(this.transientClearTimer);
    this.transientClearTimer = setTimeout(() => {
      this.messages.clearToolStatusIf(status);
      this.options.tui.requestRender();
    }, clearMs);
  }

  /** True when a screen row falls inside the input editor widget band. */
  private isOverEditor(row: number): boolean {
    const g = this.geometry;
    if (!g) return false;
    return row >= g.editorTopRow && row < g.editorTopRow + g.editorHeight;
  }

  /** Map 1-based screen coords to a chat cell position, or null off the chat area. */
  private screenToChat(row: number, col: number): CellPos | null {
    const g = this.geometry;
    if (!g) return null;
    const line = row - g.msgTopRow;
    const c = col - g.contentCol;
    if (line < 0 || line >= g.msgHeight || c < 0 || c >= g.innerWidth)
      return null;
    return { line, col: c };
  }

  /** Like {@link screenToChat} but clamps into the chat area (drag overshoot). */
  private clampScreenToChat(row: number, col: number): CellPos {
    const g = this.geometry;
    if (!g) return { line: 0, col: 0 };
    const line = Math.max(0, Math.min(row - g.msgTopRow, g.msgHeight - 1));
    const c = Math.max(0, Math.min(col - g.contentCol, g.innerWidth - 1));
    return { line, col: c };
  }

  get focused() {
    return this._focused;
  }
  set focused(v: boolean) {
    this._focused = v;
    this.editor.focused = v;
  }

  constructor(private options: SideChatOverlayOptions) {
    const {
      tui,
      theme,
      forkContext,
      modelRegistry,
      sessionManager,
      promptPack,
    } = options;
    // Fork surgery (#12): make the trailing tool exchange gateway-legal on a
    // clone of the fork snapshot (synthesize missing results, drop orphans).
    const forkedMessages = forkSurgery(structuredClone(forkContext.messages));

    this.forkLeafId = sessionManager.getLeafId();
    this.forkedMessageCount = forkedMessages.length;
    this.peekMainTool = this.createPeekMainTool(sessionManager);
    // Strip philosophy (#7): read-only lane = builtins + allowlisted extension
    // tools + peek_main. Everything else is absent from the list → attempts
    // surface as "Tool X not found" errors (the detection signal).
    this.readOnlyToolNames = new Set(
      this.buildReadOnlyTools().map((t) => t.name),
    );

    // Framing block (#9): between the cite and the user's first btw message.
    // User-role fallback placement (#11) — the request path keeps only
    // user/assistant/toolResult roles (convertToLlm + openai-completions
    // buildRequest), so trailing-system placement is not reachable through
    // the standard pipeline (ADR-0001 prototype implementation note). The
    // message is marked so the render path never shows it as a chat bubble.
    const framingMessage = markFramingMessage({
      role: "user",
      content: substituteTemplate(promptPack.framing, {
        cwd: forkContext.cwd,
        model: forkContext.model.id,
      }),
      timestamp: Date.now(),
    });

    this.agent = new Agent({
      streamFn: streamSimple,
      initialState: {
        // Shared-prefix layout (#9): the MAIN persona stays in the system
        // slot so the request head matches the main lane token-for-token.
        systemPrompt: forkContext.systemPrompt,
        model: forkContext.model,
        thinkingLevel: forkContext.thinkingLevel,
        tools: this.buildReadOnlyTools(),
        messages: [...forkedMessages, framingMessage],
      },
      convertToLlm,
      getApiKey: async (provider) => {
        const key = await modelRegistry.getApiKeyForProvider(provider);
        if (!key) throw new Error("No API key available");
        return key;
      },
      // Transient tail injections (present in the LLM request only, never
      // stored in the transcript), texts from the prompt pack:
      // - focus anchor: every turn, both modes (recency position);
      // - lane preamble: read-only lane only (full mode stays untouched);
      // - pending lane reminder: after an out-of-lane attempt; escalated
      //   violations abort the turn right after the reminder is queued.
      transformContext: async (messages) => {
        const additions: AgentMessage[] = [
          {
            role: "user",
            content: promptPack.focusAnchor,
            timestamp: Date.now(),
          },
        ];
        if (this.toolMode === "read-only") {
          additions.push({
            role: "user",
            content: promptPack.laneReminders.preamble,
            timestamp: Date.now(),
          });
        }
        if (this.pendingReminder) {
          const reminder = this.pendingReminder;
          this.pendingReminder = null;
          if (this.abortAfterInject) {
            this.abortAfterInject = false;
            this.messages.setErrorContent(PRE_ABORT_TEXT);
            setTimeout(() => this.agent.abort(), 0);
          }
          additions.push({
            role: "user",
            content: reminder,
            timestamp: Date.now(),
          });
        }
        return [...messages, ...additions];
      },
      // Belt-and-braces: block any residual present-but-disallowed tool with
      // the base reminder as the reason (blocked calls never reach afterToolCall).
      beforeToolCall: async (ctx) => {
        if (this.toolMode !== "read-only") return undefined;
        if (this.readOnlyToolNames.has(ctx.toolCall.name)) return undefined;
        return {
          block: true,
          reason: substituteTemplate(promptPack.laneReminders.base, {
            tool: ctx.toolCall.name,
          }),
        };
      },
      // Layer 2: re-ground executed-but-failed read-only calls (never fires
      // for blocked/absent tools). Not a violation — no escalation count.
      afterToolCall: async (ctx) => {
        if (this.toolMode !== "read-only" || !ctx.isError) return undefined;
        const content = [...ctx.result.content];
        if (!content.some((c) => c.type === "text" && c.text.includes("🚧"))) {
          content.push({
            type: "text",
            text: promptPack.laneReminders.failedNote,
          });
        }
        return { content };
      },
    });

    this.agent.subscribe((e) => this.handleAgentEvent(e));
    this.messages = new SideChatMessages(theme, 20);
    // The whole forked batch (main-session context or reopened history) is
    // injected at open time: render it as one collapsed cite line, not as
    // full history. New messages appended after the fork render normally.
    // The framing block message is marked and skipped by the render path.
    this.messages.setInjectedMessageCount(forkedMessages.length);
    this.messages.setMessages(forkedMessages);
    this.editor = new Editor(
      tui,
      {
        borderColor: (t) => theme.fg("borderMuted", t),
        selectList: getSelectListTheme(),
      },
      { paddingX: 0 },
    );
    this.editor.onSubmit = (text) => this.handleSubmit(text);
  }

  private createPeekMainTool(sessionManager: SessionView): AgentTool {
    return {
      name: "peek_main",
      label: "peek_main",
      description:
        "View main agent's recent activity. Use when user asks about main's progress or status.",
      parameters: Type.Object({
        lines: Type.Optional(
          Type.Integer({
            description: "Max items (default: 20)",
            minimum: 1,
            maximum: 50,
          }),
        ),
        since_fork: Type.Optional(
          Type.Boolean({
            description: "Only show activity after side chat opened",
          }),
        ),
      }),
      execute: async (_id, params) => {
        const args = (params ?? {}) as { lines?: number; since_fork?: boolean };
        const entries = sessionManager.getEntries();
        const context = buildSessionContext(
          entries,
          sessionManager.getLeafId(),
        );
        let msgs = context.messages;

        if (args.since_fork && this.forkLeafId) {
          const forkCtx = buildSessionContext(entries, this.forkLeafId);
          msgs = msgs.slice(forkCtx.messages.length);
        }

        const recent = msgs.slice(-(args.lines ?? 20));
        if (!recent.length) {
          return {
            content: [
              {
                type: "text",
                text: args.since_fork
                  ? "No new activity since fork."
                  : "No recent activity.",
              },
            ],
            details: undefined,
          };
        }

        const formatted = recent
          .map((m) => this.formatMessage(m))
          .filter(Boolean)
          .join("\n\n");
        return {
          content: [
            {
              type: "text",
              text: `Main agent activity (${recent.length} items):\n\n${formatted}`,
            },
          ],
          details: undefined,
        };
      },
    };
  }

  /**
   * Read-only lane tool list (strip philosophy, #7): builtin read tools +
   * allowlisted extension tools (config.json `readOnlyExtensionAllowlist`,
   * git-untracked) + peek_main. Everything else is stripped from the list.
   */
  private buildReadOnlyTools(): AgentTool[] {
    const { forkContext } = this.options;
    const allowlisted = forkContext.extensionTools.filter((t) =>
      this.options.readOnlyExtensionAllowlist.includes(t.name),
    );
    return [
      ...createReadOnlyTools(forkContext.cwd),
      ...allowlisted,
      this.peekMainTool,
    ];
  }

  /**
   * 1st violation → base reminder; 2nd → escalated wording + turn abort.
   * Texts come from the prompt pack (#13); the reminder is injected by
   * transformContext before the next LLM call.
   */
  private registerLaneViolation(toolName: string) {
    this.laneViolations += 1;
    // Stop the spinner first: the lane-blocked status would otherwise be
    // overwritten by the 80ms spinner tick.
    this.stopSpinner();
    if (this.laneViolations === 1) {
      this.pendingReminder = substituteTemplate(
        this.options.promptPack.laneReminders.base,
        { tool: toolName },
      );
      this.messages.setToolStatus(LANE_BLOCKED_STATUS);
    } else {
      this.pendingReminder = substituteTemplate(
        this.options.promptPack.laneReminders.escalated,
        {
          tool: toolName,
          count: this.laneViolations,
        },
      );
      this.abortAfterInject = true;
      this.messages.setToolStatus(`${LANE_BLOCKED_STATUS} — escalating`);
    }
    this.options.tui.requestRender();
  }

  private formatMessage(msg: AgentMessage): string {
    if (msg.role === "user") {
      const c =
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .map((b) => (b.type === "text" ? b.text : "[image]"))
              .join("");
      return `[User]: ${c.slice(0, 300)}${c.length > 300 ? "..." : ""}`;
    }
    if (msg.role === "assistant") {
      const fullText = msg.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const text = fullText.slice(0, 500);
      const tools = msg.content
        .filter((b) => b.type === "toolCall")
        .map((t) => t.name);
      const parts = [
        text && text + (fullText.length > 500 ? "..." : ""),
        tools.length && `[Calling: ${tools.join(", ")}]`,
      ].filter(Boolean);
      return parts.length ? `[Assistant]: ${parts.join("\n")}` : "";
    }
    if (msg.role === "toolResult") {
      const fullText =
        msg.content[0]?.type === "text" ? msg.content[0].text : "";
      const preview = fullText.slice(0, 150);
      return `[${msg.toolName}]: ${preview}${fullText.length > 150 ? "..." : ""}`;
    }
    return "";
  }

  private startSpinner() {
    this.stopSpinner();
    this.spinnerFrame = 0;
    this.messages.setToolStatus(`${SPINNER[0]} Working...`);
    this.options.tui.requestRender();
    this.spinnerInterval = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER.length;
      this.messages.setToolStatus(`${SPINNER[this.spinnerFrame]} Working...`);
      this.options.tui.requestRender();
    }, 80);
  }

  private stopSpinner() {
    if (!this.spinnerInterval) return;
    clearInterval(this.spinnerInterval);
    this.spinnerInterval = null;
    this.messages.setToolStatus("");
  }

  /**
   * Last assistant message in the fork transcript (pi's _findLastAssistantMessage
   * semantics: includes aborted/error ones). The retry loop classifies this
   * result after each attempt.
   */
  private lastAssistantMessage(): RetryableFailure | undefined {
    const messages = this.agent.state.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant") return msg as RetryableFailure;
    }
    return undefined;
  }

  /**
   * pi's _prepareRetry cleanup, mirrored: before a retry the failed assistant
   * message is stripped from the transcript so the error never re-enters the
   * next request (and agent.continue() can run — it requires a trailing
   * user/toolResult message). Only an error-stop trailing message is removed;
   * a successful prior turn's assistant message is left untouched.
   */
  private removeTrailingAssistantError(): void {
    const messages = this.agent.state.messages;
    const last = messages[messages.length - 1];
    if (last?.role === "assistant" && last.stopReason === "error") {
      this.agent.state.messages = messages.slice(0, -1);
    }
  }

  private stopRetryCountdown(): void {
    if (this.retryCountdown) {
      clearInterval(this.retryCountdown);
      this.retryCountdown = null;
    }
  }

  /**
   * Retry status line with a live countdown (D10), mirroring pi's
   * RetryStatusIndicator wording: `Retrying (1/3) in 2s… (Esc to cancel)`.
   * The spinner is stopped first so its 80ms tick cannot overwrite the status.
   */
  private showRetryStatus(info: RetryAttemptInfo): void {
    this.stopSpinner();
    const startedAt = Date.now();
    const renderStatus = () => {
      const remaining = Math.max(0, info.delayMs - (Date.now() - startedAt));
      const seconds = Math.ceil(remaining / 1000);
      this.messages.setToolStatus(
        `Retrying (${info.attempt}/${info.maxAttempts}) in ${seconds}s… (Esc to cancel)`,
      );
      this.options.tui.requestRender();
    };
    renderStatus();
    this.retryCountdown = setInterval(renderStatus, 250);
  }

  /**
   * Re-substitute the framing block with the fork's CURRENT model (Alt+M may
   * have switched `agent.state.model`, D5). The framing text is built once at
   * open time with the main session's model; the message lives in the
   * transcript (marked, never rendered as a bubble), so refreshing its content
   * keeps the LLM's self-reported model honest without touching the request
   * structure.
   */
  private refreshFramingModel(): void {
    const modelId = this.agent.state.model?.id;
    if (!modelId) return;
    for (const message of this.agent.state.messages) {
      if (isFramingMessage(message) && typeof message.content === "string") {
        message.content = substituteTemplate(this.options.promptPack.framing, {
          cwd: this.options.forkContext.cwd,
          model: modelId,
        });
        return;
      }
    }
  }
  private async handleSubmit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || this.isStreaming || this.disposed) return;

    // New user message: reset the per-turn lane counter.
    this.laneViolations = 0;
    this.pendingReminder = null;
    this.abortAfterInject = false;

    // Keep the framing block's `Model:` line in sync with the fork's current
    // model (Alt+M, D5): the text is substituted once at open time with the
    // main session's model, so without this refresh the agent self-reports the
    // old model after a switch (bug #3).
    this.refreshFramingModel();

    this.editor.setText("");
    this.isStreaming = true;
    this.streamingContent = "";
    // A new user message resumes bottom-following even if the view was frozen.
    this.messages.resumeFollowing();
    this.messages.setStreamingContent("");
    this.messages.setErrorContent("");
    this.startSpinner();
    // Per-turn retry cancellation (D9): Esc aborts this controller so the
    // backoff wait stops and the last error surfaces as the final result.
    this.retryAbortController = new AbortController();
    const signal = this.retryAbortController.signal;

    try {
      // D9: wrap the turn in the injectable retry loop (issue #8). The first
      // attempt submits the user text; a retryable failure is then stripped
      // from the transcript (pi _prepareRetry semantics) and the agent
      // continues from the same context — never re-submitting the user
      // message and never feeding the failed message back into the request.
      let firstAttempt = true;
      const attempt = async (): Promise<RetryableFailure | undefined> => {
        this.stopRetryCountdown();
        if (!firstAttempt) {
          this.removeTrailingAssistantError();
          // A mid-stream failure may have streamed partial text: drop it so
          // the retry starts clean (the error message itself is re-shown by
          // the render path while we wait).
          this.streamingContent = "";
          this.messages.setStreamingContent("");
          this.startSpinner();
        }
        if (firstAttempt) {
          firstAttempt = false;
          await this.agent.prompt(trimmed);
        } else {
          await this.agent.continue();
        }
        return this.lastAssistantMessage();
      };
      await runWithRetry({
        attempt,
        signal,
        classify: (result) =>
          classifyRetryable(
            result as RetryableInput,
            this.agent.state.model?.contextWindow ?? 0,
          ),
        onAttempt: (info) => this.showRetryStatus(info),
        // D11: the extension feature switch ANDs with pi's own
        // `settings.retry.enabled` — either one off means a single attempt
        // with zero backoff (runWithRetry's enabled=false path).
        policy: {
          ...this.options.retryPolicy,
          enabled:
            this.options.features.retry && this.options.retryPolicy.enabled,
        },
      });
    } catch (e) {
      this.streamingContent = "";
      if (!this.disposed) {
        this.messages.setErrorContent(
          e instanceof Error ? e.message : "Unknown error",
        );
      }
    } finally {
      this.stopRetryCountdown();
      this.retryAbortController = null;
      this.isStreaming = false;
      this.streamingContent = "";
      this.stopSpinner();
      this.messages.setStreamingContent("");
      this.messages.setToolStatus("");
      this.messages.setMessages([...this.agent.state.messages]);
      if (!this.disposed) this.options.tui.requestRender();
    }
  }

  private handleAgentEvent(event: AgentEvent) {
    if (this.disposed) return;

    if (
      event.type === "message_update" &&
      event.assistantMessageEvent?.type === "text_delta"
    ) {
      this.stopSpinner();
      this.streamingContent += event.assistantMessageEvent.delta;
      this.messages.setStreamingContent(this.streamingContent);
    } else if (event.type === "message_end") {
      this.messages.setMessages([...this.agent.state.messages]);
      this.messages.setStreamingContent("");
      this.streamingContent = "";
    } else if (event.type === "tool_execution_start") {
      this.stopSpinner();
      this.messages.setToolStatus(`Running ${event.toolName}...`);
    } else if (event.type === "tool_execution_end") {
      this.startSpinner();
      // Detection signal: an error result for a tool that is not in the
      // read-only lane (absent tools produce "Tool X not found" errors).
      if (
        this.toolMode === "read-only" &&
        event.isError &&
        !this.readOnlyToolNames.has(event.toolName)
      ) {
        this.registerLaneViolation(event.toolName);
      }
    }

    this.options.tui.requestRender();
  }

  render(width: number): string[] {
    if (width < 4) {
      return [" ".repeat(Math.max(0, width))];
    }

    const { theme, tracker } = this.options;
    const innerWidth = width - 4;
    const borderColor: ThemeColor = "border";

    const title = "Side Chat";
    const mainLabel = tracker.writeCount
      ? `${tracker.writeCount} file${tracker.writeCount > 1 ? "s" : ""}`
      : "idle";
    const modeLabel = this.toolMode === "full" ? "Edit" : "Read-only";
    const modeColor: ThemeColor = this.toolMode === "full" ? "warning" : "dim";
    const scrollMark = this.messages.isAtBottom()
      ? ""
      : theme.fg("warning", ` [↑${this.messages.getScrollOffset()}]`);
    // Header status shows the fork's current model (D10), mirroring the main
    // footer format: thinking level shown only when the model supports it.
    const model = this.agent.state.model;
    const modelStatus = model
      ? model.reasoning
        ? this.agent.state.thinkingLevel === "off"
          ? `[Model: ${model.id} • thinking off]`
          : `[Model: ${model.id} • ${this.agent.state.thinkingLevel}]`
        : `[Model: ${model.id}]`
      : "[Model: ?]";
    const status =
      theme.fg("dim", `[Main: ${mainLabel}] `) +
      theme.fg("dim", modelStatus + " ") +
      theme.fg(modeColor, `[${modeLabel}]`) +
      scrollMark;
    const stream = this.isStreaming ? theme.fg("warning", " ●") : "";
    const left = theme.fg("accent", title) + stream;

    const escHint = this.isStreaming ? "Esc stop" : "Esc close";
    const modeHint =
      this.toolMode === "read-only" ? "C+t Edit" : "C+t Readonly";
    const scrolled = !this.messages.isAtBottom();
    const scrollHint = scrolled
      ? theme.fg(
          "warning",
          `↑${this.messages.getScrollOffset()} · PgDn/Wheel ↓`,
        )
      : "Pg/Scr ↑↓";
    // Fixed two-row key-hint bar: the rows never collapse onto one line on
    // wide terminals, so the layout (and the message-area height) is stable
    // everywhere. Rows longer than the frame are truncated with "…" by
    // renderSideChatFrame; one message row is traded for the second hint row.
    const hintLines = this.modelPicker
      ? buildSideChatModelPickerHints()
      : buildSideChatHintLines({ scrollHint, escHint, modeHint, features: this.options.features });
    const maxLines = Math.max(
      3,
      this.computeChatHeight() - (hintLines.length - 1),
    );
    this.messages.setMaxVisibleLines(maxLines);
    const msgLines = this.modelPicker
      ? this.renderModelPicker(innerWidth, maxLines)
      : this.messages.render(innerWidth);
    for (let i = msgLines.length; i < maxLines; i++) msgLines.push("");

    const editorLines = this.editor.render(innerWidth);
    const lines = renderSideChatFrame({
      width,
      theme,
      borderColor,
      headerLeft: left,
      headerRight: status,
      msgLines,
      editorLines,
      hints: hintLines,
    });
    this.lastRenderHeight = lines.length;
    this.geometry = computeChatGeometry(
      this.options.tui.terminal.columns,
      msgLines.length,
      editorLines.length,
    );
    return lines;
  }

  handleInput(data: string): void {
    // Backgrounding (Alt+W) while the picker is open cancels the modal first.
    if (matchesKey(data, SIDE_CHAT_SHORTCUT)) {
      this.closeModelPicker();
      this.options.onBackground();
      return;
    }
    // Open modal picker: route everything to the list (↑/↓ move, Enter
    // confirms, Esc/Ctrl+C cancels) until it closes.
    if (this.modelPicker) {
      this.modelPicker.handleInput(data);
      this.options.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      if (this.isStreaming) {
        // Esc during the retry backoff cancels the wait (D9) so the last
        // error surfaces immediately; during an active stream it aborts the
        // run as before. abort() on a waiting (non-running) agent is a no-op.
        this.retryAbortController?.abort();
        this.agent.abort();
      } else {
        this.dispose();
      }
      return;
    }
    if (matchesKey(data, Key.alt("r"))) {
      this.dispose("refork");
      return;
    }
    if (matchesKey(data, Key.alt("n"))) {
      this.dispose("clear");
      return;
    }
    if (matchesKey(data, Key.alt("e"))) {
      this.exportChatHistory();
      return;
    }
    if (matchesKey(data, Key.alt("m"))) {
      this.openModelPicker();
      return;
    }
    if (
      matchesKey(data, Key.ctrl("c")) ||
      matchesKey(data, Key.ctrlShift("c"))
    ) {
      // Hotkey copy: with an active mouse selection, Ctrl+C / Ctrl+Shift+C
      // copies it. Without one, fall through so Ctrl+C keeps the editor's
      // own semantics.
      if (this.messages.hasSelection()) {
        void this.copySelectionToClipboard();
        return;
      }
    }
    if (matchesKey(data, Key.ctrl("t"))) {
      this.toolMode = this.toolMode === "full" ? "read-only" : "full";
      // Read-only lane keeps the strip philosophy; edit mode stays untouched
      // (enforcement out of scope until the crash bug is understood, #4).
      const { forkContext, tracker, onOverlapWarning } = this.options;
      this.agent.state.tools =
        this.toolMode === "read-only"
          ? this.buildReadOnlyTools()
          : [
              ...wrapToolsWithOverlapDetection(
                createCodingTools(forkContext.cwd),
                tracker,
                forkContext.cwd,
                onOverlapWarning,
              ),
              ...forkContext.extensionTools,
              this.peekMainTool,
            ];
      this.options.tui.requestRender();
      return;
    }
    if (this.messages.handleInput(data)) {
      this.options.tui.requestRender();
      return;
    }
    this.editor.handleInput(data);
    this.options.tui.requestRender();
  }

  /**
   * Alt+M: open the fork model picker as a modal inside the overlay (D7).
   * The list shows scoped + authenticated models, falling back to the
   * available catalogue (D6). Rejected while streaming: swapping the model
   * mid-turn would corrupt the in-flight request.
   */
  private openModelPicker(): void {
    if (this.modelPicker) return;
    // Feature switch (D11): Alt+M is inert when model switching is off.
    if (!this.options.features.modelSwitch) return;
    if (this.isStreaming) {
      this.messages.setToolStatus("Model switch unavailable while streaming");
      this.options.tui.requestRender();
      return;
    }
    const { modelRegistry, scopedModels } = this.options;
    const choices = buildModelChoices(
      scopedModels,
      modelRegistry.getAvailable?.() ?? [],
      (model) => modelRegistry.hasConfiguredAuth?.(model) ?? false,
    );
    if (choices.length === 0) {
      this.messages.setToolStatus("No authenticated models available");
      this.options.tui.requestRender();
      return;
    }
    const items: SelectItem[] = choices.map((choice) => ({
      value: modelKey(choice.model),
      label: choice.model.id,
      description:
        modelRegistry.getProviderDisplayName?.(choice.model.provider) ??
        choice.model.provider,
    }));
    this.modelPickerChoices = choices;
    const list = new SelectList(
      items,
      Math.min(items.length, 12),
      getSelectListTheme(),
    );
    // Preselect the current fork model when it is on the list.
    const currentIndex = choices.findIndex(
      (c) => modelKey(c.model) === modelKey(this.agent.state.model),
    );
    if (currentIndex >= 0) list.setSelectedIndex(currentIndex);
    list.onSelect = (item) => this.applyModelChoice(item);
    list.onCancel = () => this.closeModelPicker();
    this.modelPicker = list;
    this.options.tui.requestRender();
  }

  /**
   * Confirm: swap the fork agent's runtime model (next turn uses it —
   * `agent.state.model` is re-read per turn, no rebuild needed, D5) and
   * re-clamp the thinking level for the new model's capabilities. Fork-local
   * only (ADR 0002): the main session's model is never touched.
   */
  private applyModelChoice(item: SelectItem): void {
    const choice = this.modelPickerChoices.find(
      (c) => modelKey(c.model) === item.value,
    );
    this.closeModelPicker();
    if (!choice) return;
    const model = choice.model;
    // Explicit scoped thinking level ("model:high") overrides; otherwise keep
    // the current level and clamp it — non-reasoning models clamp to "off"
    // (pi maps "off" to no reasoning request).
    const desired = choice.thinkingLevel ?? this.agent.state.thinkingLevel;
    this.agent.state.model = model;
    this.agent.state.thinkingLevel = clampThinkingLevelForModel(
      model,
      desired,
    );
    this.messages.setToolStatus(
      `✓ Model: ${model.id}${
        model.reasoning ? ` · ${this.agent.state.thinkingLevel}` : ""
      }`
    );
    this.options.tui.requestRender();
  }

  private closeModelPicker(): void {
    this.modelPicker = null;
    this.modelPickerChoices = [];
    this.options.tui.requestRender();
  }

  /**
   * Render the open picker inside the frame: a one-line title + the list
   * rows, padded/truncated to exactly `maxLines` so the frame geometry stays
   * stable (mouse hit-testing and the hint bar depend on it).
   */
  private renderModelPicker(width: number, maxLines: number): string[] {
    const list = this.modelPicker;
    if (!list) return [];
    const lines = [
      this.options.theme.fg("accent", "Select model (↑/↓ · Enter · Esc)"),
    ];
    lines.push(...list.render(width));
    while (lines.length < maxLines) lines.push("");
    return lines.slice(0, maxLines);
  }

  /**
   * Alt+E: export the btw transcript to `$CWD/.agents/eval/pi-better-btw-<ts>.md`
   * as a markdown diagnostic artifact (feature/debug work). The snapshot is
   * taken from the agent state at the moment of the keypress.
   */
  private exportChatHistory() {
    try {
      const path = exportChatHistoryToFile({
        messages: [...this.agent.state.messages],
        streamingContent: this.streamingContent,
        cwd: this.options.forkContext.cwd,
        modelId: this.options.forkContext.model.id,
        toolMode: this.toolMode,
        forkedMessageCount: this.forkedMessageCount,
        streaming: this.isStreaming,
      });
      // Status line feedback inside the overlay + a toast in the main session.
      this.stopSpinner();
      this.messages.setToolStatus(`✓ exported → ${path}`);
      this.options.onExport(path);
    } catch (error) {
      this.messages.setErrorContent(
        `Export failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.options.tui.requestRender();
  }

  dispose(action: "close" | "refork" | "clear" = "close") {
    if (this.disposed) return;
    this.disposed = true;
    this.stopSpinner();
    if (this.retryAbortController) {
      // A pending retry wait must not outlive the overlay: abort it so the
      // turn's handleSubmit settles and the countdown stops.
      this.retryAbortController.abort();
      this.stopRetryCountdown();
    }
    if (this.transientClearTimer) {
      clearTimeout(this.transientClearTimer);
      this.transientClearTimer = null;
    }
    const messages = [...this.agent.state.messages];
    this.agent.abort();
    this.options.onClose(action, messages);
  }

  invalidate() {
    this.messages.invalidate();
    this.editor.invalidate();
  }
}

function parsePercent(value: string, reference: number): number {
  const match = /^(\d+(?:\.\d+)?)%$/.exec(value);
  if (!match) return reference;
  return Math.floor((reference * parseFloat(match[1])) / 100);
}

/**
 * Screen geometry of the chat message area, mirroring the overlay layout
 * pi-tui computes from the side chat's overlayOptions (width 85%, anchor
 * top-center, margin { top: 1, left: 2, right: 2 }); see resolveOverlayLayout.
 * The overlay top row is pinned to marginTop, the message area starts after
 * the top border, header and separator (3 lines), and content cells begin
 * after the left border + padding (2 cells).
 */
function computeChatGeometry(
  termCols: number,
  msgHeight: number,
  editorHeight: number,
): ChatGeometry {
  const availWidth = Math.max(
    1,
    termCols - SIDE_CHAT_OVERLAY_MARGIN_LEFT - SIDE_CHAT_OVERLAY_MARGIN_RIGHT,
  );
  const width = Math.max(
    1,
    Math.min(parsePercent(SIDE_CHAT_OVERLAY_WIDTH, termCols), availWidth),
  );
  const leftCol =
    SIDE_CHAT_OVERLAY_MARGIN_LEFT + Math.floor((availWidth - width) / 2);
  const msgTopRow = SIDE_CHAT_OVERLAY_MARGIN_TOP + 3;
  return {
    msgTopRow,
    contentCol: leftCol + 2,
    innerWidth: width - 4,
    msgHeight,
    // Separator after the messages sits at msgTopRow + msgHeight; the
    // input editor widget band starts on the next row.
    editorTopRow: msgTopRow + msgHeight + 1,
    editorHeight,
  };
}

/**
 * Pure side chat frame renderer: borders, header, messages, editor, hints.
 * Kept separate so previews/tests can render the exact same frame without a TUI.
 */
export interface SideChatFrameOptions {
  width: number;
  theme: Theme;
  borderColor: ThemeColor;
  headerLeft: string;
  headerRight: string;
  msgLines: string[];
  editorLines: string[];
  hints: string[];
}

export function renderSideChatFrame(opts: SideChatFrameOptions): string[] {
  const { theme, width, borderColor } = opts;
  const innerWidth = width - 4;
  const lines: string[] = [];

  const headerLeftWidth = Math.max(
    1,
    innerWidth - visibleWidth(opts.headerRight) - 1,
  );
  const headerLeft = truncateToWidth(opts.headerLeft, headerLeftWidth);
  const headerGap = " ".repeat(
    Math.max(
      1,
      innerWidth - visibleWidth(headerLeft) - visibleWidth(opts.headerRight),
    ),
  );

  lines.push(theme.fg(borderColor, "┌" + "─".repeat(width - 2) + "┐"));
  lines.push(
    frameLine(
      theme,
      borderColor,
      `${headerLeft}${headerGap}${opts.headerRight}`,
      innerWidth,
    ),
  );
  lines.push(theme.fg(borderColor, "├" + "─".repeat(width - 2) + "┤"));
  for (const line of opts.msgLines)
    lines.push(frameLine(theme, borderColor, line, innerWidth));
  lines.push(theme.fg(borderColor, "├" + "─".repeat(width - 2) + "┤"));
  for (const line of opts.editorLines)
    lines.push(frameLine(theme, borderColor, line, innerWidth));
  lines.push(theme.fg(borderColor, "├" + "─".repeat(width - 2) + "┤"));
  for (const line of opts.hints)
    lines.push(
      frameLine(theme, borderColor, theme.fg("dim", line), innerWidth),
    );
  lines.push(theme.fg(borderColor, "└" + "─".repeat(width - 2) + "┘"));

  return lines.map((l) =>
    visibleWidth(l) > width ? truncateToWidth(l, width) : l,
  );
}

function frameLine(
  theme: Theme,
  borderColor: ThemeColor,
  line: string,
  width: number,
): string {
  return (
    theme.fg(borderColor, "│ ") +
    truncateToWidth(line, width, "...", true) +
    theme.fg(borderColor, " │")
  );
}

/** Alt-actions hint row base; the model entry is appended only when the switch is on. */
const ALT_ACTIONS_BASE = `A+w bg · A+r fork · A+n new · A+e export`;
const ALT_ACTION_HINTS = `${ALT_ACTIONS_BASE} · A+m model`;
/**
 * Build the fixed two-row key-hint bar. Row 1: scrolling, copy, mode toggle,
 * Esc and send; row 2: the Alt-actions (Alt abbreviated as A, A+w = Alt+W).
 * Always two rows — the rows are truncated on narrow terminals rather than
 * collapsing to one line, keeping the message-area height stable.
 */
export function buildSideChatHintLines(options: {
  scrollHint: string;
  escHint: string;
  modeHint: string;
  /** Feature switches (D11): a disabled behavior is not advertised in the hints. */
  features: SideChatFeatures;
}): string[] {
  const { scrollHint, escHint, modeHint, features } = options;
  // Right-click semantics live next to the copy hint: chat-area right-click
  // copies a retained selection, editor right-click pastes (D10).
  const rightClickHint = features.rightClickCopyPaste
    ? " · R-click copy/paste"
    : "";
  const primary = `${scrollHint} · C+c copy${rightClickHint} · ${modeHint} · ${escHint} · Enter send`;
  const secondary = `${ALT_ACTIONS_BASE}${features.modelSwitch ? " · A+m model" : ""}`;
  return [primary, secondary];
}

/**
 * Hint bar while the Alt+M model picker modal is open: row 1 switches to
 * the picker keys, row 2 keeps the Alt-actions (still two rows, so the
 * message-area height stays stable).
 */
export function buildSideChatModelPickerHints(): string[] {
  return [
    "↑/↓ select · Enter confirm · Esc cancel",
    ALT_ACTION_HINTS,
  ];
}
