/**
 * fork-turn (issue #10, T1): the side chat's turn lifecycle as a deep module.
 *
 * `ForkTurnRunner` owns one fork `Agent`: it constructs the agent itself (via
 * an injectable `agentFactory`), binds the lane-enforcement hooks
 * (`transformContext` / `beforeToolCall` / `afterToolCall`) internally, and
 * subscribes to agent events, translating them into semantic `TurnPhase`
 * events for the overlay to render. The module is free of TUI / pi-runtime
 * dependencies — it depends only on pi-agent-core types, the retry engine and
 * the prompt-pack types — so tests drive it directly with a fake agent and a
 * phase log.
 *
 * The turn semantics mirror the overlay's current wiring verbatim (ADR-0001):
 * prompt → strip-failed-assistant-message → continue through `runWithRetry`,
 * with `classifyRetryable` bound to the live model context window, per-turn
 * lane state reset at the top of `run()`, and `cancel()` aborting both the
 * backoff wait and the agent run. Budget exhaustion and Esc-cancel errors
 * surface via the final `messages` + `turn-end` phases; genuine thrown attempt
 * errors propagate out of `run()` for the caller to surface.
 */
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentOptions,
  type AfterToolCallContext,
  type AfterToolCallResult,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
import { substituteTemplate, type PromptPack } from "./prompt-pack.ts";
import {
  classifyRetryable,
  runWithRetry,
  type RetryableFailure,
  type RetryableInput,
  type RetryPolicy,
} from "./retry.ts";

/**
 * Semantic turn lifecycle events emitted by the runner (frozen contract,
 * issue #9). The overlay maps phases to rendering (spinner, countdown ticker,
 * status line, message batches); tests read the union like a log.
 */
export type TurnPhase =
  | { kind: "stream"; delta: string }
  | { kind: "messages"; messages: AgentMessage[] }
  | { kind: "tool"; name: string; state: "start" | "end" }
  | {
      kind: "retry-wait";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | { kind: "lane"; count: number; escalated: boolean; tool: string }
  | { kind: "turn-end" };

export interface ForkTurnRunnerOptions {
  /**
   * Agent construction config without the three lane hooks — the runner
   * overrides `transformContext` / `beforeToolCall` / `afterToolCall` with its
   * own implementations. `initialState` is assembled by the overlay (fork
   * surgery, framing message, peek tool, read-only tool list).
   */
  agentOptions: AgentOptions;
  /**
   * Retry budget/backoff. Already ANDed with `features.retry` by the overlay
   * (D11) — a disabled feature arrives as `enabled: false`.
   */
  retryPolicy: RetryPolicy;
  /** Resolved prompt texts (focus anchor + lane reminders). */
  promptPack: PromptPack;
  /** Live lane predicate (tool-mode closure; live after Ctrl+T). */
  isReadOnlyLane: () => boolean;
  /** Read-only tool-set membership (tool-set closure). */
  isReadOnlyTool: (name: string) => boolean;
  /** Receives every semantic phase; the overlay maps phases to rendering. */
  onPhase: (phase: TurnPhase) => void;
  /** Test seam; defaults to constructing the real Agent. */
  agentFactory?: (options: AgentOptions) => Agent;
}

export class ForkTurnRunner {
  /** The owned fork agent; the overlay reaches it for model picker / export / Ctrl+T. */
  readonly agent: Agent;

  /** Out-of-lane attempts in the current turn (reset at the top of run()). */
  private laneViolations = 0;
  /** Reminder queued for injection by transformContext before the next LLM call. */
  private pendingReminder: string | null = null;
  /** When true, the turn is aborted right after the escalated reminder is injected. */
  private abortAfterInject = false;
  /** Per-turn retry cancellation (D9): cancel() aborts this so the backoff wait stops. */
  private retryAbortController: AbortController | null = null;
  /** True while a turn is in flight — streaming and backoff wait included. */
  private running = false;

  constructor(private readonly options: ForkTurnRunnerOptions) {
    const agentFactory =
      options.agentFactory ?? ((agentOptions: AgentOptions) => new Agent(agentOptions));
    this.agent = agentFactory({
      ...options.agentOptions,
      transformContext: (messages) => this.transformContext(messages),
      beforeToolCall: (context) => this.beforeToolCall(context),
      afterToolCall: (context) => this.afterToolCall(context),
    });
    this.agent.subscribe((event) => this.handleAgentEvent(event));
  }

  /** True during both streaming and the retry backoff wait. */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Run one turn (user submit): prompt → strip-failed-assistant-message →
   * continue through `runWithRetry` (ADR-0001 mirror). A thrown attempt error
   * propagates out of `run()` for the caller to surface; budget exhaustion and
   * Esc-cancel errors surface via the final `messages` + `turn-end` phases.
   * A submit while a turn is in flight is ignored.
   */
  async run(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.running) return;

    // Per-turn lane state resets at the top of run().
    this.laneViolations = 0;
    this.pendingReminder = null;
    this.abortAfterInject = false;

    this.running = true;
    this.retryAbortController = new AbortController();
    const signal = this.retryAbortController.signal;

    try {
      let firstAttempt = true;
      const attempt = async (): Promise<RetryableFailure | undefined> => {
        if (!firstAttempt) this.removeTrailingAssistantError();
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
        // ADR-0001 mirror: classify against the live model context window so
        // silent overflow (pi isContextOverflow cases 2/3) is also excluded.
        classify: (result) =>
          classifyRetryable(
            result as RetryableInput,
            this.agent.state.model?.contextWindow ?? 0,
          ),
        onAttempt: (info) => {
          this.emit({ kind: "retry-wait", ...info });
        },
        policy: this.options.retryPolicy,
      });
    } finally {
      this.running = false;
      this.retryAbortController = null;
      // Final transcript snapshot + turn-end: the overlay clears its statuses
      // and re-renders here (budget-exhaustion / Esc-cancel errors included).
      this.emit({ kind: "messages", messages: [...this.agent.state.messages] });
      this.emit({ kind: "turn-end" });
    }
  }

  /** Esc / overlay dispose: abort the backoff wait and the agent run. */
  cancel(): void {
    this.retryAbortController?.abort();
    this.agent.abort();
  }

  // --- Agent event → phase translation --------------------------------------

  private handleAgentEvent(event: AgentEvent): void {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent?.type === "text_delta"
    ) {
      this.emit({ kind: "stream", delta: event.assistantMessageEvent.delta });
      return;
    }
    if (event.type === "message_end") {
      this.emit({ kind: "messages", messages: [...this.agent.state.messages] });
      return;
    }
    if (event.type === "tool_execution_start") {
      this.emit({ kind: "tool", name: event.toolName, state: "start" });
      return;
    }
    if (event.type === "tool_execution_end") {
      this.emit({ kind: "tool", name: event.toolName, state: "end" });
      // Detection signal: an error result for a tool that is not in the
      // read-only lane (absent tools produce "Tool X not found" errors).
      if (
        this.options.isReadOnlyLane() &&
        event.isError &&
        !this.options.isReadOnlyTool(event.toolName)
      ) {
        this.registerLaneViolation(event.toolName);
      }
    }
  }

  private emit(phase: TurnPhase): void {
    this.options.onPhase(phase);
  }

  // --- Lane enforcement ------------------------------------------------------

  /**
   * 1st violation → base reminder; 2nd → escalated wording + abort-after-inject
   * (the reminder is injected by transformContext before the next LLM call).
   * Texts come from the prompt pack (#13); UI copy stays in the overlay.
   */
  private registerLaneViolation(toolName: string): void {
    this.laneViolations += 1;
    const escalated = this.laneViolations >= 2;
    if (escalated) {
      this.pendingReminder = substituteTemplate(
        this.options.promptPack.laneReminders.escalated,
        { tool: toolName, count: this.laneViolations },
      );
      this.abortAfterInject = true;
    } else {
      this.pendingReminder = substituteTemplate(
        this.options.promptPack.laneReminders.base,
        { tool: toolName },
      );
    }
    this.emit({ kind: "lane", count: this.laneViolations, escalated, tool: toolName });
  }

  // --- Lane hooks (bound by the runner, never by the overlay) ----------------

  /**
   * Transient tail injections (present in the LLM request only, never stored in
   * the transcript), texts from the prompt pack: focus anchor (every turn, both
   * modes), lane preamble (read-only lane only), pending lane reminder (after
   * an out-of-lane attempt; escalated violations abort the turn right after the
   * reminder is queued).
   */
  private async transformContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
    const additions: AgentMessage[] = [
      {
        role: "user",
        content: this.options.promptPack.focusAnchor,
        timestamp: Date.now(),
      },
    ];
    if (this.options.isReadOnlyLane()) {
      additions.push({
        role: "user",
        content: this.options.promptPack.laneReminders.preamble,
        timestamp: Date.now(),
      });
    }
    if (this.pendingReminder) {
      const reminder = this.pendingReminder;
      this.pendingReminder = null;
      if (this.abortAfterInject) {
        this.abortAfterInject = false;
        setTimeout(() => this.agent.abort(), 0);
      }
      additions.push({
        role: "user",
        content: reminder,
        timestamp: Date.now(),
      });
    }
    return [...messages, ...additions];
  }

  /**
   * Belt-and-braces: block any residual present-but-disallowed tool with the
   * base reminder as the reason (blocked calls never reach afterToolCall).
   */
  private async beforeToolCall(
    context: BeforeToolCallContext,
  ): Promise<BeforeToolCallResult | undefined> {
    if (!this.options.isReadOnlyLane()) return undefined;
    if (this.options.isReadOnlyTool(context.toolCall.name)) return undefined;
    return {
      block: true,
      reason: substituteTemplate(this.options.promptPack.laneReminders.base, {
        tool: context.toolCall.name,
      }),
    };
  }

  /**
   * Layer 2: re-ground executed-but-failed read-only calls (never fires for
   * blocked/absent tools). Not a violation — no escalation count.
   */
  private async afterToolCall(
    context: AfterToolCallContext,
  ): Promise<AfterToolCallResult | undefined> {
    if (!this.options.isReadOnlyLane() || !context.isError) return undefined;
    const content = [...context.result.content];
    if (!content.some((c) => c.type === "text" && c.text.includes("🚧"))) {
      content.push({
        type: "text",
        text: this.options.promptPack.laneReminders.failedNote,
      });
    }
    return { content };
  }

  // --- Transcript helpers (pi _findLastAssistantMessage / _prepareRetry mirrors) --

  /**
   * Last assistant message in the fork transcript (pi's
   * `_findLastAssistantMessage` semantics: includes aborted/error ones). The
   * retry loop classifies this result after each attempt.
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
   * pi's `_prepareRetry` cleanup, mirrored: before a retry the failed assistant
   * message is stripped from the transcript so the error never re-enters the
   * next request (and `agent.continue()` can run — it requires a trailing
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
}
