import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import type { ScopedModel } from "@earendil-works/pi-coding-agent";

/**
 * Fork model switching (issue #5): pure list-building and thinking-level
 * clamping. The overlay applies the chosen model to its own agent only
 * (fork-local, ADR 0002) — the main session's model is never touched.
 */

/** A selectable fork model: the model plus an optional scoped thinking level. */
export interface ModelChoice {
  model: Model<any>;
  /**
   * Thinking level pinned by the scoped pattern (e.g. "model:high"), when the
   * session scoped one explicitly. Undefined otherwise — the current level is
   * kept and clamped to the new model's capabilities.
   */
  thinkingLevel?: ThinkingLevel;
}

/**
 * Build the pickable model list (D6):
 * - scoped models win when the session configured any (`--models` /
 *   `enabledModels`); an empty scoped set falls back to the available
 *   catalogue;
 * - models without configured auth are dropped outright ("只显示"而非置灰 —
 *   choices that would inevitably fail are absent, not disabled).
 */
export function buildModelChoices(
  scoped: readonly ScopedModel[],
  available: readonly Model<any>[],
  hasAuth: (model: Model<any>) => boolean,
): ModelChoice[] {
  const source: ModelChoice[] =
    scoped.length > 0
      ? scoped.map((s) => ({ model: s.model, thinkingLevel: s.thinkingLevel }))
      : available.map((model) => ({ model }));
  return source.filter((choice) => hasAuth(choice.model));
}

/**
 * Clamp a thinking level to what the new model supports, mirroring the main
 * session's `setThinkingLevel` semantics (it delegates to the same
 * `clampThinkingLevel` from pi-ai): a model without reasoning clamps any
 * level to `"off"`, and pi's request builders map `"off"` to no reasoning
 * request. Levels above a model's `thinkingLevelMap` ceiling clamp down.
 */
export function clampThinkingLevelForModel(
  model: Model<any>,
  level: ThinkingLevel,
): ThinkingLevel {
  return clampThinkingLevel(model, level);
}

/** Canonical identity key for a model (provider + id). */
export function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}\0${model.id}`;
}
