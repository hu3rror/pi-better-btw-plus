/**
 * Status channel — the single arbiter of the tool status line (spec issue
 * #19, architecture review candidate 4).
 *
 * Every writer of the `[Tool]: …` line goes through this channel:
 * - steady sources (spinner, retry countdown, lane-blocked, tool-running,
 *   model/export feedback) replace each other via `setSteady`;
 * - transient toasts (copy confirmation, clipboard hints) overlay the
 *   current steady text via `flash` and fall back to it on expiry.
 *
 * Timers live here — the spinner tick, the countdown tick, the flash
 * self-clear and the retry expiry hand-off (`expiresMs` → `onExpired`) —
 * driven by injected `now`/scheduler functions so tests use a fake clock.
 *
 * The module owns zero domain knowledge (no TurnPhase type, no TUI): its
 * only inputs are texts and frame numbers. UI copy stays in the overlay;
 * the channel only decides *what* is displayed at any moment.
 */
export interface SteadySourceOptions {
  /** Re-evaluate `text` every this many ms (spinner 80 / countdown 250). */
  tickMs?: number;
  /** Current text for the given frame number (0-based, reset per setSteady). */
  text: (frame: number) => string;
  /** Auto-expire the source after this many ms (retry backoff hand-off). */
  expiresMs?: number;
  /** Called when the source expires (convention: setSteady back to the spinner). */
  onExpired?: () => void;
}

/**
 * Timer plumbing (test seam): a scripted scheduler can drive every delay
 * without real time passing. IDs are opaque — the channel never inspects them.
 */
export interface StatusScheduler {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
}

export interface StatusChannelOptions extends Partial<StatusScheduler> {
  /** Receives the text that should currently be displayed. */
  render: (text: string) => void;
  /** Clock (test seam; defaults to Date.now). */
  now?: () => number;
}

interface SteadyState {
  id: string;
  opts: SteadySourceOptions;
  frame: number;
  startedAt: number;
}

export class StatusChannel {
  private steady: SteadyState | null = null;
  private steadyTimer: unknown = null;
  private flashText: string | null = null;
  private flashTimer: unknown = null;
  private readonly options: Required<StatusChannelOptions>;

  constructor(options: StatusChannelOptions) {
    this.options = {
      now: () => Date.now(),
      setInterval: (fn, ms) => globalThis.setInterval(fn, ms) as unknown,
      clearInterval: (id) => globalThis.clearInterval(id as number),
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown,
      clearTimeout: (id) => globalThis.clearTimeout(id as number),
      ...options,
    };
  }

  /**
   * Set the steady source, replacing any current one. A `tickMs`ed source
   * starts its ticker (frame counted from 0, reset on every setSteady);
   * replacing a ticked source stops its ticker. `expiresMs` is checked on
   * every tick only — a source without `tickMs` never expires.
   */
  setSteady(id: string, source: SteadySourceOptions): void {
    this.stopSteadyTimer();
    this.steady = { id, opts: source, frame: 0, startedAt: this.options.now() };
    if (source.tickMs !== undefined) {
      this.steadyTimer = this.options.setInterval(() => this.onTick(), source.tickMs);
    }
    this.paint();
  }

  /** Clear the steady source and stop its ticker; an active flash is kept. */
  clearSteady(): void {
    this.stopSteadyTimer();
    this.steady = null;
    this.paint();
  }

  /**
   * Overlay a transient toast on top of the current display; it falls back
   * to the steady source (or empties) after `clearMs`. A new flash replaces
   * an in-flight one and resets its expiry. `clearMs === undefined` never
   * auto-clears.
   */
  flash(text: string, clearMs?: number): void {
    this.stopFlashTimer();
    this.flashText = text;
    if (clearMs !== undefined && clearMs > 0) {
      this.flashTimer = this.options.setTimeout(() => this.onFlashExpired(), clearMs);
    }
    this.paint();
  }

  /** Clear everything: steady source, ticker, flash and all timers. */
  reset(): void {
    this.stopSteadyTimer();
    this.stopFlashTimer();
    this.steady = null;
    this.flashText = null;
    this.paint();
  }

  /** Stop the steady-source ticker, if any. */
  private stopSteadyTimer(): void {
    if (this.steadyTimer) {
      this.options.clearInterval(this.steadyTimer);
      this.steadyTimer = null;
    }
  }

  /** Clear the in-flight flash timer, if any. */
  private stopFlashTimer(): void {
    if (this.flashTimer) {
      this.options.clearTimeout(this.flashTimer);
      this.flashTimer = null;
    }
  }

  private onTick(): void {
    const current = this.steady;
    if (!current) return;
    current.frame += 1;
    if (
      current.opts.expiresMs !== undefined &&
      this.options.now() - current.startedAt >= current.opts.expiresMs
    ) {
      const { onExpired } = current.opts;
      this.clearSteady();
      onExpired?.();
      return;
    }
    this.paint();
  }

  private onFlashExpired(): void {
    this.flashTimer = null;
    this.flashText = null;
    this.paint();
  }

  private paint(): void {
    const text = this.flashText ?? this.steady?.opts.text(this.steady.frame) ?? "";
    this.options.render(text);
  }
}