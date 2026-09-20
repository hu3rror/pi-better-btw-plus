import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { PromptPackManifest } from "./prompt-pack.ts";
import type { ProviderRetrySettings } from "./provider-retry.ts";
import type { RetryPolicy } from "./retry.ts";
/**
 * Layered config resolution for pi-better-btw.
 *
 * Sources, in increasing precedence (a layer only contributes keys it
 * actually defines — absent/invalid keys fall through to the layer below):
 *
 *   1. bundle   — <extensionDir>/config.json            (shipped defaults)
 *   2. user     — ~/.pi/agent/pi-better-btw/config.json (personal defaults)
 *   3. project  — <cwd>/.pi/pi-better-btw/config.json   (per-project overrides)
 *
 * Merge semantics:
 * - `readOnlyExtensionAllowlist` is UNIONED across layers in bundle → user →
 *   project order (deduped, first occurrence wins). A higher layer adds tools,
 *   it never drops the defaults shipped below it.
 * - `readOnlyExtensionAllowlistExclude` removes names from the final list, so
 *   a bundled default can be dropped explicitly.
 * - `promptPack` merges per leaf key (framing / focusAnchor / each lane
 *   reminder), higher layer wins; relative paths resolve against the layer's
 *   own directory (so a user-level manifest may live next to the user config).
 *
 * Loaded fresh at every side-chat open — no caching, so edits to any layer
 * apply on the next open (same philosophy as the prompt pack).
 */

/**
 * Per-feature kill switches (D11). Each defaults to true; a layer only
 * overrides the keys it defines, so a user can disable one behavior without
 * touching the others (or the bundle defaults). Read-only here — the
 * switches are resolved at every side-chat open, like the rest of the config.
 */
export interface SideChatFeatures {
  /** Right-click copy (chat selection) / paste (editor). Default: true. */
  rightClickCopyPaste: boolean;
  /** Ctrl+L fork model picker. Default: true. */
  modelSwitch: boolean;
  /** Turn-level auto-retry of transient provider errors. Default: true. */
  retry: boolean;
  /** Left-drag selection on the input editor (spec #24). Default: true. */
  editorSelection: boolean;
}

export interface SideChatConfig {
  readOnlyExtensionAllowlist: string[];
  promptPack: PromptPackManifest | undefined;
  features: SideChatFeatures;
}

export interface LoadConfigOptions {
  /** Directory of the extension bundle (base for the bundle config.json). */
  extensionDir: string;
  /** Current working directory; project layer is skipped when absent. */
  cwd?: string;
  /** User config dir override (tests). Defaults to ~/.pi/agent/pi-sidechat. */
  userConfigDir?: string;
  /** Surfaces config problems (invalid JSON) instead of logging to console. */
  onWarning?: (message: string) => void;
}

export const CONFIG_SUBDIR = "pi-better-btw";
export const USER_CONFIG_DIR = join(homedir(), ".pi", "agent", CONFIG_SUBDIR);
/** pi's own agent config dir (home of the shared settings.json). */
export const AGENT_CONFIG_DIR = join(homedir(), ".pi", "agent");

/**
 * Read pi's `settings.retry` budget (D8) via pi's own `SettingsManager` —
 * file reading, deep merge (project wins per key), legacy migration
 * (`retry.maxDelayMs` → `retry.provider.maxRetryDelayMs`) and the canonical
 * defaults (enabled=true, maxRetries=3, baseDelayMs=2000, maxAgentDelayMs=60000)
 * all come from pi; no
 * hand-rolled duplicate. The `retry.provider` block (spec #20 D4: timeoutMs /
 * maxRetries / maxRetryDelayMs) is forwarded only when a provider block is
 * actually configured, and only number keys; it is consumed solely by the
 * overlay's stream assembly, never by the turn loop. A present-but-unreadable
 * settings file warns and contributes nothing (pi's own fallback).
 */
export interface LoadRetryPolicyOptions {
  /** Agent config dir holding pi's global settings.json (~/.pi/agent). */
  agentConfigDir?: string;
  /** cwd for the project layer (<cwd>/.pi/settings.json); skipped when absent. */
  cwd?: string;
  onWarning?: (message: string) => void;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


export function loadRetryPolicy(options: LoadRetryPolicyOptions = {}): RetryPolicy {
  const agentConfigDir = options.agentConfigDir ?? AGENT_CONFIG_DIR;
  const settings = SettingsManager.create(options.cwd ?? process.cwd(), agentConfigDir, {
    projectTrusted: true,
  });
  // Surface load errors (invalid JSON etc.) through the caller's warning hook,
  // mirroring the old loader's present-but-unreadable → warn behavior.
  for (const err of settings.drainErrors()) {
    options.onWarning?.(`pi-better-btw: ignoring invalid settings (${err.scope})`);
  }
  const retry = settings.getRetrySettings();
  // Provider block (spec #20): forward only number keys from an actually
  // configured `retry.provider`. getProviderRetrySettings() defaults
  // maxRetryDelayMs to 60000 even when no block exists, so configured-ness is
  // detected from the (already-migrated) per-scope settings; an absent block
  // keeps `provider` undefined so the overlay's stream assembly stays identity
  // (D3: unconfigured users keep the bare streamSimple, zero overhead).
  const providerRetry = settings.getProviderRetrySettings();
  const providerConfigured = [
    settings.getGlobalSettings(),
    settings.getProjectSettings(),
  ].some((scope) => isPlainRecord(scope.retry) && isPlainRecord(scope.retry.provider));
  const providerBlock: ProviderRetrySettings = {};
  if (providerConfigured) {
    // Number filter kept (vs. blindly forwarding getProviderRetrySettings) to
    // keep the D3 identity contract stable: non-number keys never reach
    // injectProviderRetry, and an unconfigured provider stays undefined.
    if (typeof providerRetry.timeoutMs === "number") providerBlock.timeoutMs = providerRetry.timeoutMs;
    if (typeof providerRetry.maxRetries === "number") providerBlock.maxRetries = providerRetry.maxRetries;
    if (typeof providerRetry.maxRetryDelayMs === "number")
      providerBlock.maxRetryDelayMs = providerRetry.maxRetryDelayMs;
  }
  return {
    enabled: retry.enabled,
    maxRetries: retry.maxRetries,
    baseDelayMs: retry.baseDelayMs,
    // Backoff ceiling (pi 0.86.0): getRetrySettings() already applies the
    // 60s default, so forwarding it always mirrors pi's agent loop exactly.
    maxAgentDelayMs: retry.maxAgentDelayMs,
    ...(Object.keys(providerBlock).length > 0 ? { provider: providerBlock } : {}),
  };
}

interface ConfigLayer {
  readOnlyExtensionAllowlist: string[] | undefined;
  readOnlyExtensionAllowlistExclude: string[] | undefined;
  promptPack: PromptPackManifest | undefined;
  /** Feature switches this layer actually defines (undefined = falls through). */
  features: Partial<SideChatFeatures> | undefined;
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value.filter(
    (n): n is string => typeof n === "string" && n.length > 0,
  );
  return names.length > 0 ? names : undefined;
}

/** Boolean feature switch; non-boolean values are ignored (fall through). */
function parseBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Resolve a prompt-pack path against the layer's dir; non-strings stay undefined. */
function resolvePath(value: unknown, dir: string): string | undefined {
  if (typeof value !== "string") return undefined;
  return isAbsolute(value) ? value : join(dir, value);
}

function parsePromptPack(
  value: unknown,
  dir: string,
): PromptPackManifest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const rec = value as Record<string, unknown>;
  const lane = rec.laneReminders;
  const laneRec =
    lane && typeof lane === "object" && !Array.isArray(lane)
      ? (lane as Record<string, unknown>)
      : undefined;
  return {
    framing: resolvePath(rec.framing, dir),
    focusAnchor: resolvePath(rec.focusAnchor, dir),
    laneReminders: {
      base: resolvePath(laneRec?.base, dir),
      escalated: resolvePath(laneRec?.escalated, dir),
      failedNote: resolvePath(laneRec?.failedNote, dir),
      preamble: resolvePath(laneRec?.preamble, dir),
    },
  };
}

function parseConfigLayer(raw: unknown, dir: string): ConfigLayer {
  const rec =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const rawFeatures = rec.features;
  const featureRec =
    rawFeatures && typeof rawFeatures === "object" && !Array.isArray(rawFeatures)
      ? (rawFeatures as Record<string, unknown>)
      : undefined;
  return {
    readOnlyExtensionAllowlist: parseStringArray(
      rec.readOnlyExtensionAllowlist,
    ),
    readOnlyExtensionAllowlistExclude: parseStringArray(
      rec.readOnlyExtensionAllowlistExclude,
    ),
    promptPack: parsePromptPack(rec.promptPack, dir),
    features: featureRec
      ? {
          rightClickCopyPaste: parseBoolean(featureRec.rightClickCopyPaste),
          modelSwitch: parseBoolean(featureRec.modelSwitch),
          retry: parseBoolean(featureRec.retry),
          editorSelection: parseBoolean(featureRec.editorSelection),
        }
      : undefined,
  };
}

/** Read one config file; absent or invalid JSON contributes nothing (with a warning). */
function readLayer(
  path: string,
  dir: string,
  onWarning?: (message: string) => void,
): ConfigLayer {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return parseConfigLayer(raw, dir);
  } catch {
    if (existsSync(path) && onWarning) {
      // Present but unreadable: warn instead of silently ignoring a typo.
      onWarning(`pi-better-btw: ignoring invalid config ${path}`);
    }
    return parseConfigLayer(undefined, dir);
  }
}

/** Union allowlists bundle → user → project, then apply excludes. */
function mergeAllowlists(layers: ConfigLayer[]): string[] {
  const names: string[] = [];
  for (const layer of layers) {
    for (const name of layer.readOnlyExtensionAllowlist ?? []) {
      if (!names.includes(name)) names.push(name);
    }
  }
  const excluded = new Set<string>();
  for (const layer of layers) {
    for (const name of layer.readOnlyExtensionAllowlistExclude ?? [])
      excluded.add(name);
  }
  return names.filter((name) => !excluded.has(name));
}

/** Per-leaf-key promptPack merge, higher layer wins; undefined when nothing defined. */
function mergePromptPacks(
  layers: ConfigLayer[],
): PromptPackManifest | undefined {
  const merged: PromptPackManifest = {};
  const lane: NonNullable<PromptPackManifest["laneReminders"]> = {};
  let defined = false;
  for (const layer of layers) {
    const pack = layer.promptPack;
    if (!pack) continue;
    if (pack.framing !== undefined) {
      merged.framing = pack.framing;
      defined = true;
    }
    if (pack.focusAnchor !== undefined) {
      merged.focusAnchor = pack.focusAnchor;
      defined = true;
    }
    const layerLane = pack.laneReminders ?? {};
    for (const key of [
      "base",
      "escalated",
      "failedNote",
      "preamble",
    ] as const) {
      if (layerLane[key] !== undefined) {
        lane[key] = layerLane[key];
        defined = true;
      }
    }
  }
  if (Object.keys(lane).length > 0) merged.laneReminders = lane;
  return defined ? merged : undefined;
}

/**
 * Feature switches merge per leaf key, higher layer wins; keys no layer
 * defines keep their default (true). A layer can disable one behavior
 * (`"retry": false`) without re-declaring the others.
 */
const FEATURE_KEYS = [
  "rightClickCopyPaste",
  "modelSwitch",
  "retry",
  "editorSelection",
] as const;
function mergeFeatures(layers: ConfigLayer[]): SideChatFeatures {
  const features: SideChatFeatures = {
    rightClickCopyPaste: true,
    modelSwitch: true,
    retry: true,
    editorSelection: true,
  };
  for (const layer of layers) {
    const layerFeatures = layer.features;
    if (!layerFeatures) continue;
    for (const key of FEATURE_KEYS) {
      const value = layerFeatures[key];
      if (value !== undefined) features[key] = value;
    }
  }
  return features;
}

export function loadConfig(options: LoadConfigOptions): SideChatConfig {
  const layers: ConfigLayer[] = [];
  layers.push(
    readLayer(
      join(options.extensionDir, "config.json"),
      options.extensionDir,
      options.onWarning,
    ),
  );
  const userConfigDir = options.userConfigDir ?? USER_CONFIG_DIR;
  layers.push(
    readLayer(
      join(userConfigDir, "config.json"),
      userConfigDir,
      options.onWarning,
    ),
  );
  if (options.cwd) {
    const projectDir = join(options.cwd, ".pi", CONFIG_SUBDIR);
    layers.push(
      readLayer(join(projectDir, "config.json"), projectDir, options.onWarning),
    );
  }
  return {
    readOnlyExtensionAllowlist: mergeAllowlists(layers),
    promptPack: mergePromptPacks(layers),
    features: mergeFeatures(layers),
  };
}
