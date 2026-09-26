import {
  type AgentMessage,
  type AgentTool,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
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
import { Type } from "typebox";
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
  ForkTurnRunner,
  type ForkTurnRunnerOptions,
  type TurnPhase,
} from "./fork-turn.ts";
import {
  readClipboardTextFromSystem,
  type ClipboardReadOutcome,
} from "./clipboard-read.ts";
import { exportChatHistoryToFile } from "./side-chat-export.ts";
import { type SgrMouseEvent } from "./side-chat-mouse.ts";
import {
  contentBandPlainLines,
  EditorSelectionState,
  lineSelection,
  wordSelection,
  type EditorPos,
} from "./editor-selection.ts";
import {
  PointerGesture,
  type GestureAction,
} from "./pointer-gesture.ts";
import { substituteTemplate, type PromptPack } from "./prompt-pack.ts";
import { injectProviderRetry } from "./provider-retry.ts";
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
import {
  KEYBINDINGS,
  bindingText,
  matchesAnyKey,
  matchesKeybinding,
  type Keybinding,
} from "./shortcuts.ts";
import { wrapToolsWithOverlapDetection } from "./tool-wrapper.ts";
import type { SideChatFeatures } from "./config.ts";
import type { RetryPolicy } from "./retry.ts";
import { StatusChannel, type SteadySourceOptions } from "./status-channel.ts";
import {
  FRAME_SIDE_PADDING,
  computeChatGeometry,
  computeOverlayViewport,
  computeSideChatHeight,
  type ChatGeometry,
} from "./overlay-layout.ts";
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
  /** `settings.retry` budget/backoff read from pi's settings files (D8). The
   * optional `provider` block is consumed here by the stream assembly
   * (provider-layer retry, spec #20); the turn loop only sees the budget. */
  retryPolicy: RetryPolicy;
  /** Per-feature kill switches resolved from the layered config (D11). */
  features: SideChatFeatures;
  /**
   * Test seam (default: one-line passthrough constructing the real
   * ForkTurnRunner). The overlay assembles the runner's deps (agent options,
   * features-ANDed retry policy, prompt pack, live lane closures, phase
   * sink) and delegates the whole turn loop to it — the runner owns the
   * agent, retry backoff and lane enforcement, and reports TurnPhase events
   * the overlay renders.
   */
  runnerFactory?: (options: ForkTurnRunnerOptions) => ForkTurnRunner;
  onOverlapWarning: (path: string) => Promise<boolean>;
  onBackground: () => void;
  onClose: (
    action: "close" | "refork" | "clear",
    messages: AgentMessage[],
  ) => void;
  /** Alt+E export written to $CWD/.agents/eval/ — called with the written path. */
  onExport: (path: string) => void;
}

/** Feedback shown after a copy, cleared shortly after. */
const COPIED_STATUS_PREFIX = "✓ Copied ";
const COPIED_STATUS_CLEAR_MS = 1200;
/** Degradation hint when every clipboard read channel fails (C1 unavailable). */
const PASTE_FAILED_STATUS = "Clipboard read failed";
/** Hint when the clipboard is readable but holds no text. */
const PASTE_EMPTY_STATUS = "Clipboard is empty";
const PASTE_STATUS_CLEAR_MS = 1200;
/** Ctrl+X hint when the side chat has produced no assistant reply yet. */
const NO_ASSISTANT_MESSAGE_STATUS = "No assistant message to copy yet";
/** Alt+Shift+C hint when the input editor is empty (issue #23). */
const INPUT_EMPTY_STATUS = "Input is empty";

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
  private runner: ForkTurnRunner;
  private messages: SideChatMessages;
  private editor: Editor;
  private streamingContent = "";
  /** Tool status line arbitration (spec issue #19): all `[Tool]: …` writers. */
  private status: StatusChannel;
  private toolMode: "full" | "read-only" = "read-only";
  private _focused = true;
  private disposed = false;
  private forkLeafId: string | null;
  private peekMainTool: AgentTool;
  private lastRenderHeight = 0;
  /** Geometry of the last render (screen coords), used for mouse hit-testing. */
  private geometry: ChatGeometry | null = null;
  /** Pointer gesture state machine (spec #13): press/drag/double-click/right-click classification. */
  private gesture: PointerGesture;
  /** Visual-space selection over the input editor (spec #24, T3). */
  private editorSelection = new EditorSelectionState();
  /** Plain (ANSI-stripped) lines of the last editor render's content band. */
  private editorPlainLines: string[] = [];
  /** Leading messages injected from the main lane at fork time (context cite). */
  private forkedMessageCount: number;
  /** Tool names allowed in the read-only lane (builtins + allowlist + peek_main). */
  private readOnlyToolNames = new Set<string>();
  /** Open Ctrl+L model picker modal, or null when closed (modal replaces the chat area). */
  private modelPicker: SelectList | null = null;
  /** Choices backing the open picker (index-aligned with its SelectItems). */
  private modelPickerChoices: ModelChoice[] = [];
  /** Keymap screen modal open flag (issue #35): Ctrl+O opens, Esc closes. */
  private keymapOpen = false;

  /** Chat area height (message lines): delegates to the shared layout module. */
  private computeChatHeight(): number {
    return computeSideChatHeight(this.options.tui.terminal.rows);
  }

  /**
   * Screen region occupied by the overlay (0-based rows), used to route mouse
   * wheel events to the chat. Returns null when the overlay is gone. The
   * maxHeight/percent/clamp math lives in the shared layout module.
   */
  getViewport(): { topRow: number; height: number } | null {
    if (this.disposed) return null;
    return computeOverlayViewport(
      this.options.tui.terminal.rows,
      this.lastRenderHeight,
    );
  }

  /** Scroll the message area (positive = toward older content). Mouse wheel handler. */
  scrollByLines(lines: number): boolean {
    const changed = this.messages.scrollBy(lines);
    if (changed) this.options.tui.requestRender();
    return changed;
  }

  /** True while a left-button drag is captured (events stay consumed even off-overlay). */
  isMouseDragging(): boolean {
    return this.gesture.isDragging();
  }

  /**
   * Abort an in-flight drag without waiting for the release (used when the
   * overlay is hidden mid-drag and mouse reporting is turned off).
   */
  cancelMouseDrag(): void {
    this.gesture.cancel();
    this.messages.clearSelection();
    this.editorSelection.clear();
  }

  /**
   * Handle an SGR mouse event located over the overlay. Screen coordinates
   * are 1-based (as reported by the terminal); the gesture module converts
   * them and produces actions, which {@link applyGestureAction} translates
   * onto the message store and render loop.
   */
  handleMouseEvent(event: SgrMouseEvent): void {
    // Modal model picker: pointer events are ignored until it closes. The
    // gate stays at the overlay layer — the gesture module knows nothing
    // about the modal (spec #13, D6).
    if (this.modelPicker) return;
    for (const action of this.gesture.onEvent(event)) {
      this.applyGestureAction(action);
    }
  }

  /**
   * Translate a gesture action onto the message store + render loop (spec
   * #13, D6). select always updates the selection; only paint:true actions
   * request a re-render (the 32ms drag throttle lives in the module).
   */
  private applyGestureAction(action: GestureAction): void {
    switch (action.kind) {
      case "select":
        // Cross-surface exclusion (spec #24): starting a selection on one
        // surface clears the other, so only one highlight is ever on screen.
        if (action.surface === "editor") {
          this.setEditorSelection(action.anchor, action.focus);
        } else {
          this.setChatSelection(action.anchor, action.focus);
        }
        if (action.paint) this.options.tui.requestRender();
        break;
      case "selectLine":
        if (action.surface === "editor") {
          // Column bounds come from the editor's own content band; the module
          // only knows the rendered line (spec #24/#26).
          const sel = lineSelection(this.editorPlainLines, action.line);
          this.setEditorSelection(sel.anchor, sel.focus);
        } else {
          // Column bounds come from the overlay's own geometry; the module
          // only knows the rendered line.
          this.setChatSelection(
            { line: action.line, col: 0 },
            { line: action.line, col: this.geometry?.innerWidth ?? 0 },
          );
        }
        this.options.tui.requestRender();
        break;
      case "selectWord":
        // Editor double-click: word bounds resolved by the overlay from the
        // editor's own content band (findWordBackward/Forward semantics).
        const word = wordSelection(this.editorPlainLines, action.line, action.col);
        this.setEditorSelection(word.anchor, word.focus);
        this.options.tui.requestRender();
        break;
      case "scroll":
        this.scrollByLines(action.lines);
        break;
      case "copy":
        void this.copySelectionToClipboard();
        break;
      case "paste":
        void this.pasteFromClipboard();
        break;
    }
  }

  /** Set the chat selection, clearing the editor selection (cross-surface). */
  private setChatSelection(anchor: CellPos, focus: CellPos): void {
    this.messages.setSelection(anchor, focus);
    this.editorSelection.clear();
  }

  /** Set the editor selection, clearing the chat selection (cross-surface). */
  private setEditorSelection(anchor: EditorPos, focus: EditorPos): void {
    this.editorSelection.setSelection(anchor, focus);
    this.messages.clearSelection();
  }

  /**
   * Copy the current mouse selection to the clipboard (native → wl-copy /
   * xclip → OSC 52 cascade via {@link copyToClipboard}, matching the main
   * app's tree selector) and show a transient status. Copying is hotkey-only:
   * `Ctrl+C` / `Ctrl+Shift+C` with an active mouse selection. A successful
   * copy consumes the selection (spec #22: Ctrl+C then returns to clearing
   * the input); a failed copy keeps it so the user can retry. Returns false
   * when there is nothing to copy.
   */
  async copySelectionToClipboard(): Promise<boolean> {
    const text = this.messages.getSelectedText();
    if (!text) return false;
    const ok = await this.copyTextWithFeedback(text);
    if (ok) {
      this.messages.clearSelection();
      this.options.tui.requestRender();
    }
    return ok;
  }

  /**
   * Copy the current editor selection (spec #24, hotkey-only): selected text
   * from the editor content band, consumed on success so Ctrl+C then falls
   * back to the clear-input lane; a failed (or empty) copy keeps it for retry.
   */
  async copyEditorSelectionToClipboard(): Promise<boolean> {
    if (!this.editorSelection.hasSelection()) return false;
    const text = this.editorSelection.selectedText(this.editorPlainLines);
    if (!text) return false;
    const ok = await this.copyTextWithFeedback(text);
    if (ok) {
      this.editorSelection.clear();
      this.options.tui.requestRender();
    }
    return ok;
  }

  /**
   * Copy text to the system clipboard and surface the outcome: a success
   * flash on the status line (labelled by `hint`) or an error line on
   * failure. The shared skeleton behind selection copy (Ctrl+C / right-click)
   * and last-message copy (Ctrl+X).
   */
  private async copyTextWithFeedback(text: string, hint?: string): Promise<boolean> {
    try {
      await copyToClipboard(text);
    } catch (error) {
      this.messages.setErrorContent(
        `Copy failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.options.tui.requestRender();
      return false;
    }
    const label = hint
      ? `${hint} · ${Array.from(text).length} chars`
      : `${Array.from(text).length} chars`;
    this.status.flash(`${COPIED_STATUS_PREFIX}${label}`, COPIED_STATUS_CLEAR_MS);
    return true;
  }

  /**
   * Ctrl+X (app.message.copy parity): copy the last assistant message the
   * side chat produced itself — never the forked main-lane context. No-op
   * with a hint when the side chat has produced no reply yet.
   */
  async copyLastAssistantMessage(): Promise<void> {
    const text = this.runner.getLastAssistantText();
    if (!text) {
      this.status.flash(NO_ASSISTANT_MESSAGE_STATUS, COPIED_STATUS_CLEAR_MS);
      return;
    }
    await this.copyTextWithFeedback(text, "last message");
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
      this.status.flash(status, PASTE_STATUS_CLEAR_MS);
      return;
    }
    // Bracketed paste is the only paste entry the Editor exposes (handlePaste
    // is private); the same sequences a native terminal paste produces.
    this.editorSelection.clear();
    this.editor.handleInput(`\x1b[200~${outcome.text}\x1b[201~`);
    this.options.tui.requestRender();
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

  /**
   * Map 0-based screen coords to an editor visual cell, or null off the
   * editor content band (the `Editor.render()` lines between the top and
   * bottom borders). The top border row is `editorTopRow`, so content-band
   * line 0 is the next screen row down.
   */
  private screenToEditor(row: number, col: number): EditorPos | null {
    const g = this.geometry;
    if (!g) return null;
    const line = row - (g.editorTopRow + 1);
    const c = col - g.contentCol;
    if (line < 0 || line >= g.editorHeight - 2 || c < 0 || c >= g.innerWidth)
      return null;
    return { line, col: c };
  }

  /** Like {@link screenToEditor} but clamps into the editor content band (drag overshoot). */
  private clampScreenToEditor(row: number, col: number): EditorPos {
    const g = this.geometry;
    if (!g) return { line: 0, col: 0 };
    const maxLine = Math.max(0, g.editorHeight - 3);
    const line = Math.max(0, Math.min(row - (g.editorTopRow + 1), maxLine));
    const c = Math.max(0, Math.min(col - g.contentCol, Math.max(0, g.innerWidth - 1)));
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

    this.messages = new SideChatMessages(theme, 20);
    // The whole forked batch (main-session context or reopened history) is
    // injected at open time: render it as one collapsed cite line, not as
    // full history. New messages appended after the fork render normally.
    // The framing block message is marked and skipped by the render path.
    this.messages.setInjectedMessageCount(forkedMessages.length);

    // Tool status line arbitration (spec issue #19): every writer of the
    // `[Tool]: …` line goes through this channel — steady sources replace
    // each other, transient toasts flash over them and fall back on expiry.
    this.status = new StatusChannel({
      render: (text) => {
        this.messages.setToolStatus(text);
        this.options.tui.requestRender();
      },
    });
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

    // Pointer gesture state machine (spec #13): the module classifies raw
    // SGR events into actions; the overlay translates them onto the message
    // store and render loop (applyGestureAction). The hit queries bridge the
    // module's 0-based screen coordinates to the overlay's geometry. The
    // Ctrl+L modal gate stays in handleMouseEvent — the module knows nothing
    // about the modal.
    this.gesture = new PointerGesture({
      hit: {
        chatAt: (row, col) => this.screenToChat(row, col),
        clampToChat: (row, col) => this.clampScreenToChat(row, col),
        overEditor: (row, _col) => this.isOverEditor(row),
        // Editor surface (spec #24/#26): real hit-testing / selection store.
        // While the autocomplete popup is open the editor-drag branch is
        // disabled (row-index drift — ADR 0006), so editorAt reports null and
        // left presses fall through to a no-op.
        editorAt: (row, col) =>
          this.editor.isShowingAutocomplete()
            ? null
            : this.screenToEditor(row, col),
        clampToEditor: (row, col) => this.clampScreenToEditor(row, col),
        hasEditorSelection: () => this.editorSelection.hasSelection(),
        getEditorSelectionAnchor: () => this.editorSelection.getAnchor(),
        hasSelection: () => this.messages.hasSelection(),
        getSelectionAnchor: () => this.messages.getSelectionAnchor(),
      },
      // D11: the feature switch gates right-click copy/paste at the module.
      rightClickEnabled: this.options.features.rightClickCopyPaste,
      // Editor-selection gate (spec #24): off → left-drag never classifies
      // onto the editor surface; right-click paste is unaffected.
      editorSelectionEnabled: this.options.features.editorSelection,
    });

    // The runner (fork-turn.ts, issue #9) owns the fork agent and the whole
    // turn loop — retry backoff, lane enforcement, Esc cancellation — and
    // reports TurnPhase events the overlay renders. The overlay only
    // assembles the deps: agent options (initial state: fork surgery +
    // framing block + read-only tool list, streamFn = the model registry's
    // streamSimple — auth resolves inside the runtime at request time
    // (apiKey/OAuth/baseUrl, pi 0.87.1 parity; no hand-wired getApiKey) —
    // wrapped with pi's provider-layer retry settings — spec #20 D5: NOT
    // gated by features.retry / retry.enabled, mirroring the main session),
    // features-ANDed retry policy (D11), the prompt pack, the live lane
    // closures, and the phase sink.
    // `runnerFactory` is a test-only seam (default: one-line passthrough).
    const runnerOptions: ForkTurnRunnerOptions = {
      agentOptions: {
        streamFn: injectProviderRetry(
          modelRegistry.streamSimple.bind(modelRegistry),
          options.retryPolicy.provider,
        ),
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
      },
      // D11: the extension feature switch ANDs with pi's own
      // `settings.retry.enabled` — either one off means a single attempt
      // with zero backoff (runWithRetry's enabled=false path).
      retryPolicy: {
        ...options.retryPolicy,
        enabled: options.features.retry && options.retryPolicy.enabled,
      },
      promptPack,
      // Live closures: Alt+T toggles toolMode (the runner re-reads it per
      // event); the read-only tool set is fixed at open time.
      isReadOnlyLane: () => this.toolMode === "read-only",
      isReadOnlyTool: (name) => this.readOnlyToolNames.has(name),
      onPhase: (phase) => this.handlePhase(phase),
    };
    this.runner =
      (options.runnerFactory ?? ((opts) => new ForkTurnRunner(opts)))(
        runnerOptions,
      );
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

  /** Spinner steady source for the status channel (80ms tick, frame cycle). */
  private spinnerSource(): SteadySourceOptions {
    return {
      tickMs: 80,
      text: (frame) => `${SPINNER[frame % SPINNER.length]} Working...`,
    };
  }

  /**
   * Re-substitute the framing block with the fork's CURRENT model (Ctrl+L may
   * have switched `agent.state.model`, D5). The framing text is built once at
   * open time with the main session's model; the message lives in the
   * transcript (marked, never rendered as a bubble), so refreshing its content
   * keeps the LLM's self-reported model honest without touching the request
   * structure.
   */
  private refreshFramingModel(): void {
    const modelId = this.runner.agent.state.model?.id;
    if (!modelId) return;
    for (const message of this.runner.agent.state.messages) {
      if (isFramingMessage(message) && typeof message.content === "string") {
        message.content = substituteTemplate(this.options.promptPack.framing, {
          cwd: this.options.forkContext.cwd,
          model: modelId,
        });
        return;
      }
    }
  }
  private handleSubmit(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || this.runner.isRunning || this.disposed) return;

    // Keep the framing block's `Model:` line in sync with the fork's current
    // model (Ctrl+L, D5): the text is substituted once at open time with the
    // main session's model, so without this refresh the agent self-reports the
    // old model after a switch (bug #3).
    this.refreshFramingModel();

    this.editor.setText("");
    this.editorSelection.clear();
    this.streamingContent = "";
    // A new user message resumes bottom-following even if the view was frozen.
    this.messages.resumeFollowing();
    this.messages.setStreamingContent("");
    this.messages.setErrorContent("");
    this.status.setSteady("spinner", this.spinnerSource());
    // The whole turn loop (attempts, retry backoff, lane enforcement, Esc
    // cancellation) lives in the runner (fork-turn.ts, issue #9); the overlay
    // renders its TurnPhase events. A thrown attempt (real abort) propagates
    // out of run() — surface it as the final error line; the runner already
    // emitted the final transcript + turn-end phases before rejecting.
    void this.runner.run(trimmed).catch((error: unknown) => {
      this.streamingContent = "";
      if (!this.disposed) {
        this.messages.setErrorContent(
          error instanceof Error ? error.message : "Unknown error",
        );
        this.options.tui.requestRender();
      }
    });
  }

  /**
   * TurnPhase dispatch (issue #9): the runner owns the turn loop and reports
   * semantic phases; the overlay maps them onto the existing render surface —
   * spinner, retry countdown ticker, status line and message batches — the
   * same way the pre-runner agent events did.
   */
  private handlePhase(phase: TurnPhase): void {
    if (this.disposed) return;
    switch (phase.kind) {
      case "stream":
        // A text delta: an attempt is producing output. Let the status line
        // rest (clear the steady source) so the streamed text is unobstructed;
        // clearSteady keeps an in-flight flash (e.g. copy feedback).
        this.status.clearSteady();
        this.streamingContent += phase.delta;
        this.messages.setStreamingContent(this.streamingContent);
        break;
      case "messages":
        // Transcript snapshot (message_end or the final flush): render the
        // batch and drop the streaming line.
        this.messages.setMessages(phase.messages);
        this.messages.setStreamingContent("");
        this.streamingContent = "";
        break;
      case "tool":
        // Tool-call bookends: steady "Running X" while the tool runs, the
        // spinner while the model thinks between calls (setSteady replaces).
        if (phase.state === "start") {
          this.status.setSteady("tool", {
            text: () => `Running ${phase.name}...`,
          });
        } else {
          this.status.setSteady("spinner", this.spinnerSource());
        }
        break;
      case "retry-wait":
        // Backoff wait: the countdown ticker replaces the spinner; when the
        // wait elapses (expiresMs), the channel hands back to the spinner —
        // the old manual "stop countdown → start spinner" choreography is
        // gone. The countdown derives from the tick frame (frame × 250ms).
        // A failed attempt may have streamed partial text without a message_end
        // (transport-level failures cut the stream): drop it here, before the
        // next attempt starts, so the retry never renders stale content
        // stitched onto fresh output (mirrors the attempt-boundary cleanup
        // the pre-runner wiring did).
        this.streamingContent = "";
        this.messages.setStreamingContent("");
        this.status.setSteady("retry", {
          tickMs: 250,
          text: (frame) => {
            const remaining = Math.max(0, phase.delayMs - frame * 250);
            const seconds = Math.ceil(remaining / 1000);
            return `Retrying (${phase.attempt}/${phase.maxAttempts}) in ${seconds}s… (Esc to cancel)`;
          },
          expiresMs: phase.delayMs,
          onExpired: () =>
            this.status.setSteady("spinner", this.spinnerSource()),
        });
        break;
      case "lane":
        // Out-of-lane detection (runner-owned): the blocked status replaces
        // the steady source; the escalated violation pre-renders the abort text.
        this.status.setSteady("lane", {
          text: () =>
            phase.escalated
              ? `${LANE_BLOCKED_STATUS} — escalating`
              : LANE_BLOCKED_STATUS,
        });
        if (phase.escalated) {
          this.messages.setErrorContent(PRE_ABORT_TEXT);
        }
        break;
      case "turn-end":
        // The turn settled (success, budget exhaustion or Esc-cancel): the
        // status channel resets everything. The final transcript already
        // rendered via the preceding messages phase.
        this.status.reset();
        break;
    }
    this.options.tui.requestRender();
  }

  render(width: number): string[] {
    if (width < 4) {
      return [" ".repeat(Math.max(0, width))];
    }

    const { theme, tracker } = this.options;
    const innerWidth = width - FRAME_SIDE_PADDING * 2;
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
    const model = this.runner.agent.state.model;
    const modelStatus = model
      ? model.reasoning
        ? this.runner.agent.state.thinkingLevel === "off"
          ? `[Model: ${model.id} • thinking off]`
          : `[Model: ${model.id} • ${this.runner.agent.state.thinkingLevel}]`
        : `[Model: ${model.id}]`
      : "[Model: ?]";
    const status =
      theme.fg("dim", `[Main: ${mainLabel}] `) +
      theme.fg("dim", modelStatus + " ") +
      theme.fg(modeColor, `[${modeLabel}]`) +
      scrollMark;
    const stream = this.runner.isRunning ? theme.fg("warning", " ●") : "";
    const left = theme.fg("accent", title) + stream;

    const escLabel = this.runner.isRunning ? "stop" : "close";
    // Fixed two-row key-hint bar: the rows never collapse onto one line on
    // wide terminals, so the layout (and the message-area height) is stable
    // everywhere. Rows longer than the frame are truncated with "…" by
    // renderSideChatFrame; one message row is traded for the second hint row.
    // Modals swap both the message area and the hint rows, keeping the count
    // at two so the frame geometry never changes (mouse hit-testing).
    const hintLines = this.keymapOpen
      ? buildSideChatKeymapHints(theme)
      : this.modelPicker
        ? buildSideChatModelPickerHints(theme)
        : buildSideChatHintLines({ escLabel, theme });
    const maxLines = Math.max(
      3,
      this.computeChatHeight() - (hintLines.length - 1),
    );
    this.messages.setMaxVisibleLines(maxLines);
    const msgLines = this.keymapOpen
      ? this.renderKeymapScreen(innerWidth, maxLines)
      : this.modelPicker
        ? this.renderModelPicker(innerWidth, maxLines)
        : this.messages.render(innerWidth);
    for (let i = msgLines.length; i < maxLines; i++) msgLines.push("");

    const editorLines = this.editor.render(innerWidth);
    // Editor selection (spec #24): hit-testing / copy resolve against the
    // content band (top/bottom borders dropped, ANSI stripped), and the
    // highlight is injected by post-processing the rendered lines. The plain
    // lines are cached here so mouse actions between renders see the same
    // band the frame was drawn from.
    this.editorPlainLines = contentBandPlainLines(editorLines);
    const decoratedEditorLines = this.editorSelection.decorate(editorLines);
    const lines = renderSideChatFrame({
      width,
      theme,
      borderColor,
      headerLeft: left,
      headerRight: status,
      msgLines,
      editorLines: decoratedEditorLines,
      hints: hintLines,
    });
    this.lastRenderHeight = lines.length;
    this.geometry = computeChatGeometry(
      this.options.tui.terminal.columns,
      this.options.tui.terminal.rows,
      msgLines.length,
      decoratedEditorLines.length,
    );
    return lines;
  }

  handleInput(data: string): void {
    // Backgrounding (Alt+W) while the picker is open cancels the modal first.
    if (matchesAnyKey(data, KEYBINDINGS.background.keys)) {
      this.closeModelPicker();
      this.closeKeymapScreen();
      this.options.onBackground();
      return;
    }
    // Ctrl+O opens the keymap screen from every state — including on top of
    // the picker — so the check runs before the picker gate below.
    if (matchesAnyKey(data, KEYBINDINGS.keymapScreen.keys)) {
      this.openKeymapScreen();
      return;
    }
    // Open keymap screen: route everything to the screen (Esc closes; the
    // picker underneath stays set, so Esc returns to it) until it closes.
    // The gate sits BEFORE the picker gate so keymap-over-picker works.
    if (this.keymapOpen) {
      if (matchesKey(data, Key.escape)) this.closeKeymapScreen();
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
      if (this.runner.isRunning) {
        // Esc during the retry backoff cancels the wait (D9) so the last
        // error surfaces immediately; during an active stream it aborts the
        // run as before. runner.cancel() aborts both; abort() on a waiting
        // (non-running) agent is a no-op.
        this.runner.cancel();
      } else {
        this.dispose();
      }
      return;
    }
    if (matchesAnyKey(data, KEYBINDINGS.refork.keys)) {
      this.dispose("refork");
      return;
    }
    if (matchesAnyKey(data, KEYBINDINGS.clear.keys)) {
      this.dispose("clear");
      return;
    }
    if (matchesAnyKey(data, KEYBINDINGS.export.keys)) {
      this.exportChatHistory();
      return;
    }
    if (matchesAnyKey(data, KEYBINDINGS.modelPicker.keys)) {
      this.openModelPicker();
      return;
    }
    if (matchesKeybinding(data, KEYBINDINGS.copyInput)) {
      // Copy the whole input editor text (issue #23): expanded paste
      // markers — exactly what a submit would send. Read-only, unlike
      // Ctrl+C's clear lane it never touches the draft; an empty input
      // flashes a hint instead of copying. `matchesKeybinding` also accepts
      // the raw legacy ESC+C form that terminals without the kitty protocol
      // (Windows Terminal < 1.25) deliver for Alt+Shift+C.
      const text = this.editor.getExpandedText();
      if (!text) {
        this.status.flash(INPUT_EMPTY_STATUS, COPIED_STATUS_CLEAR_MS);
        return;
      }
      void this.copyTextWithFeedback(text, "input");
      return;
    }
    if (matchesAnyKey(data, KEYBINDINGS.copySelection.keys)) {
      // Hotkey copy (spec #24): three-tier routing — chat selection first,
      // then editor selection, then the legacy clear-input lane. Copying the
      // editor selection consumes it so Ctrl+C then returns to clearing the
      // input; a failed copy keeps it for retry. Bare Ctrl+C with no
      // selection clears the input box (pi `app.clear` parity, spec #22);
      // Ctrl+Shift+C falls through — pi binds no such key, so it stays a
      // forced copy (terminal habit).
      if (this.messages.hasSelection()) {
        void this.copySelectionToClipboard();
        return;
      }
      if (this.editorSelection.hasSelection()) {
        void this.copyEditorSelectionToClipboard();
        return;
      }
      if (matchesKey(data, KEYBINDINGS.copySelection.keys[0])) {
        this.editorSelection.clear();
        this.editor.setText("");
        this.options.tui.requestRender();
        return;
      }
    }
    if (matchesAnyKey(data, KEYBINDINGS.copyLastMessage.keys)) {
      // app.message.copy parity: copy the last assistant message — no
      // selection needed (mirrors the main session's Ctrl+X default).
      void this.copyLastAssistantMessage();
      return;
    }
    if (matchesAnyKey(data, KEYBINDINGS.paste.keys)) {
      // app.clipboard.pasteImage parity: paste clipboard text into the editor
      // (Ctrl+V; Alt+V is the Windows/WSL binding).
      void this.pasteFromClipboard();
      return;
    }
    if (matchesAnyKey(data, KEYBINDINGS.toggleMode.keys)) {
      this.toolMode = this.toolMode === "full" ? "read-only" : "full";
      // Read-only lane keeps the strip philosophy; edit mode stays untouched
      // (enforcement out of scope until the crash bug is understood, #4).
      const { forkContext, tracker, onOverlapWarning } = this.options;
      this.runner.agent.state.tools =
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
    // Any non-drag editor input (typing, cursor movement) clears the editor
    // selection — transient by design (spec #24). The clear happens before
    // the editor consumes the input so the next render never shows a stale
    // highlight next to the moved cursor.
    this.editorSelection.clear();
    this.editor.handleInput(data);
    this.options.tui.requestRender();
  }

  /**
   * Ctrl+L: open the fork model picker as a modal inside the overlay (D7).
   * The list shows scoped + authenticated models, falling back to the
   * available catalogue (D6). Rejected while streaming: swapping the model
   * mid-turn would corrupt the in-flight request.
   */
  private openModelPicker(): void {
    if (this.modelPicker) return;
    // Feature switch (D11): Ctrl+L is inert when model switching is off.
    if (!this.options.features.modelSwitch) return;
    // Editor selection is transient: opening the picker clears it and aborts
    // any in-flight editor drag, so the modal's mouse surface starts clean
    // (spec #24).
    this.gesture.cancel();
    this.editorSelection.clear();
    if (this.runner.isRunning) {
      this.status.setSteady("feedback", {
        text: () => "Model switch unavailable while streaming",
      });
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
      this.status.setSteady("feedback", { text: () => "No authenticated models available" });
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
      (c) => modelKey(c.model) === modelKey(this.runner.agent.state.model),
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
    const desired = choice.thinkingLevel ?? this.runner.agent.state.thinkingLevel;
    this.runner.agent.state.model = model;
    this.runner.agent.state.thinkingLevel = clampThinkingLevelForModel(
      model,
      desired,
    );
    this.status.setSteady("feedback", {
      text: () =>
        `✓ Model: ${model.id}${
          model.reasoning
            ? ` · ${this.runner.agent.state.thinkingLevel}`
            : ""
        }`,
    });
    this.options.tui.requestRender();
  }

  private closeModelPicker(): void {
    this.modelPicker = null;
    this.modelPickerChoices = [];
    this.options.tui.requestRender();
  }

  /**
   * Ctrl+O: open the keymap screen as a modal inside the overlay (issue #35).
   * Read-only help — unlike the model picker it opens even while streaming.
   * A no-op while a modal is already open (Ctrl+O is consumed by the gate).
   */
  private openKeymapScreen(): void {
    if (this.keymapOpen) return;
    this.gesture.cancel();
    this.editorSelection.clear();
    this.keymapOpen = true;
    this.options.tui.requestRender();
  }

  private closeKeymapScreen(): void {
    if (!this.keymapOpen) return;
    this.keymapOpen = false;
    this.options.tui.requestRender();
  }

  /**
   * Render the open keymap screen inside the frame: the grouped full keymap,
   * padded/truncated to exactly `maxLines` so the frame geometry stays stable
   * (mouse hit-testing and the hint bar depend on it).
   */
  private renderKeymapScreen(width: number, maxLines: number): string[] {
    const lines = buildKeymapScreenLines({
      features: this.options.features,
      theme: this.options.theme,
    });
    while (lines.length < maxLines) lines.push("");
    return lines.slice(0, maxLines);
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
        messages: [...this.runner.agent.state.messages],
        streamingContent: this.streamingContent,
        cwd: this.options.forkContext.cwd,
        modelId: this.options.forkContext.model.id,
        toolMode: this.toolMode,
        forkedMessageCount: this.forkedMessageCount,
        streaming: this.runner.isRunning,
      });
      // Status line feedback inside the overlay + a toast in the main session.
      this.status.setSteady("export", {
        text: () => `✓ exported → ${path}`,
      });
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
    // A pending retry wait or in-flight stream must not outlive the overlay:
    // cancel() aborts the runner's backoff controller and the agent run; the
    // status channel resets the line and its timers (the runner's turn-end
    // phase would do it, but handlePhase is a no-op once disposed).
    this.status.reset();
    this.runner.cancel();
    this.editorSelection.clear();
    const messages = [...this.runner.agent.state.messages];
    this.options.onClose(action, messages);
  }

  invalidate() {
    this.messages.invalidate();
    this.editor.invalidate();
  }
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
  // Hint lines arrive already styled (keys dim, labels muted — pi keyHint
  // grammar) by the hint builders, so the frame wraps them without an extra
  // color pass.
  for (const line of opts.hints)
    lines.push(frameLine(theme, borderColor, line, innerWidth));
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

/**
 * One styled segment of a hint line: text + the theme color carrying it.
 * Keys render dim and labels muted (pi's own keyHint grammar), so the
 * overlay's hint rows read like the host UI's.
 */
type HintSegment = readonly [string, ThemeColor];

const HINT_SEP: HintSegment = [" · ", "muted"];

/** Join entries with the ` · ` separator into one styled hint line. */
function joinHintSegments(
  entries: ReadonlyArray<ReadonlyArray<HintSegment>>,
): HintSegment[] {
  const out: HintSegment[] = [];
  for (const [i, entry] of entries.entries()) {
    if (i > 0) out.push(HINT_SEP);
    out.push(...entry);
  }
  return out;
}

/** Styled key+label entry for a binding (compact first key / full all keys). */
function bindingSegments(kb: Keybinding, longForm: boolean): HintSegment[] {
  const { keyText, label } = bindingText(kb, longForm);
  return [[keyText, "dim"], [` ${label}`, "muted"]];
}

/** Styled literal entry: key dim + label muted, e.g. `Enter send`. */
function literalSegments(key: string, label: string): HintSegment[] {
  return [[key, "dim"], [` ${label}`, "muted"]];
}

/** Render one hint line from styled segments. */
function renderHintLine(
  theme: Theme,
  segments: ReadonlyArray<HintSegment>,
): string {
  return segments.map(([text, color]) => theme.fg(color, text)).join("");
}

/** One keymap screen section: accent title + ` · `-joined entries. */
function sectionLine(
  theme: Theme,
  title: string,
  entries: ReadonlyArray<ReadonlyArray<HintSegment>>,
): string {
  return renderHintLine(theme, [
    [title, "accent"],
    [" ", "muted"],
    ...joinHintSegments(entries),
  ]);
}

/**
 * Build the fixed two-row compact key-hint bar (issue #35). Row 1: the
 * essentials (send, close, mode toggle, paste, copy); row 2: background and
 * the keymap opener. Full-word modifiers (`Alt+T mode`, not `A+t`) mirror
 * pi's own keyHint grammar; the Esc label swaps stop/close with the run
 * state. Always two rows — the rows are truncated on narrow terminals
 * rather than collapsing to one line, keeping the message-area height
 * stable.
 */
export function buildSideChatHintLines(options: {
  escLabel: string;
  theme: Theme;
}): string[] {
  const { escLabel, theme } = options;
  const primary = renderHintLine(
    theme,
    joinHintSegments([
      literalSegments("Enter", "send"),
      literalSegments("Esc", escLabel),
      bindingSegments(KEYBINDINGS.toggleMode, false),
      bindingSegments(KEYBINDINGS.paste, false),
      bindingSegments(KEYBINDINGS.copySelection, false),
    ]),
  );
  const secondary = renderHintLine(
    theme,
    joinHintSegments([
      bindingSegments(KEYBINDINGS.background, false),
      bindingSegments(KEYBINDINGS.keymapScreen, false),
    ]),
  );
  return [primary, secondary];
}

/**
 * Hint bar while the Ctrl+L model picker modal is open: row 1 switches to
 * the picker keys, row 2 points at the keymap screen (still two rows, so the
 * message-area height stays stable).
 */
export function buildSideChatModelPickerHints(theme: Theme): string[] {
  return [
    renderHintLine(
      theme,
      joinHintSegments([
        literalSegments("↑/↓", "select"),
        literalSegments("Enter", "confirm"),
        literalSegments("Esc", "cancel"),
      ]),
    ),
    renderHintLine(theme, bindingSegments(KEYBINDINGS.keymapScreen, false)),
  ];
}

/**
 * Hint bar while the keymap screen is open: Esc closes the modal (row 2
 * stays blank — still two rows, so the frame geometry never changes).
 */
export function buildSideChatKeymapHints(theme: Theme): string[] {
  return [renderHintLine(theme, literalSegments("Esc", "close")), ""];
}

/**
 * The keymap screen's grouped full keymap (issue #35). Every action stays
 * documented here — the compact bar only advertises the essentials. Feature
 * switches (D11): a disabled behavior is not advertised.
 */
export function buildKeymapScreenLines(options: {
  features: SideChatFeatures;
  theme: Theme;
}): string[] {
  const { features, theme } = options;
  const entry = (kb: Keybinding): HintSegment[] => bindingSegments(kb, true);
  const mouseEntry = (text: string): HintSegment[] => [[text, "muted"]];
  const mouseEntries: HintSegment[][] = [
    mouseEntry("drag select"),
    mouseEntry("double/triple-click"),
    ...(features.rightClickCopyPaste
      ? [
          mouseEntry("right-click copy (chat)"),
          mouseEntry("right-click paste (editor)"),
        ]
      : []),
  ];
  return [
    renderHintLine(theme, [["Keymap", "accent"]]),
    sectionLine(theme, "Navigation:", [
      entry(KEYBINDINGS.background),
      literalSegments("Esc", "close"),
    ]),
    sectionLine(theme, "Conversation:", [
      literalSegments("Enter", "send"),
      entry(KEYBINDINGS.refork),
      entry(KEYBINDINGS.clear),
      entry(KEYBINDINGS.export),
    ]),
    sectionLine(theme, "Copy & Paste:", [
      entry(KEYBINDINGS.copySelection),
      entry(KEYBINDINGS.copyLastMessage),
      entry(KEYBINDINGS.copyInput),
      entry(KEYBINDINGS.paste),
    ]),
    sectionLine(theme, "Mode & Model:", [
      entry(KEYBINDINGS.toggleMode),
      ...(features.modelSwitch ? [entry(KEYBINDINGS.modelPicker)] : []),
    ]),
    sectionLine(theme, "Scrolling:", [
      literalSegments("PageUp/PageDown", "page"),
      literalSegments("Shift+↑/↓", "few lines"),
      literalSegments("Wheel", "scroll"),
    ]),
    sectionLine(theme, "Mouse:", mouseEntries),
  ];
}
