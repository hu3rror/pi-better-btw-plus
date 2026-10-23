import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { PromptPackManifest } from "./prompt-pack.ts";
import type { ProviderRetrySettings } from "./provider-retry.ts";
import type { RetryPolicy } from "./retry.ts";

export interface SideChatFeatures {
  /** Right-click copy (chat selection) / paste (editor). Default: true. */
  rightClickCopyPaste: boolean;
  /** Ctrl+L fork model picker. Default: true. */
  modelSwitch: boolean;
  /** Turn-level auto-retry of transient provider errors. Default: true. */
  retry: boolean;
  /** Left-drag selection on the input editor (spec #24). Default: true. */
  editorSelection: boolean;
  /** Fullscreen copy-on-select mirror (spec #37): copy a just-formed
   * selection on release without consuming it, like pi's
   * `fullscreenCopyOnSelect`. Default: false (hotkey/right-click copy stays
   * the default copy path in both modes). */
  fullscreenCopyOnSelect: boolean;
}

export interface SideChatConfig {
  readOnlyExtensionAllowlist: string[];
  promptPack: PromptPackManifest | undefined;
  features: SideChatFeatures;
}

export interface LoadConfigOptions {
  extensionDir: string;
  cwd?: string;
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
  agentConfigDir?: string;
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
    // Backoff ceiling (pi 1.4.0): getRetrySettings() already applies the
    // 60s default, so forwarding it always mirrors pi's agent loop exactly.
    maxAgentDelayMs: retry.maxAgentDelayMs,
    ...(Object.keys(providerBlock).length > 0 ? { provider: providerBlock } : {}),
  };
}

interface ConfigLayer {
  readOnlyExtensionAllowlist: string[] | undefined;
  readOnlyExtensionAllowlistExclude: string[] | undefined;
  promptPack: PromptPackManifest | undefined;
  features: Partial<SideChatFeatures> | undefined;
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value.filter(
    (n): n is string => typeof n === "string" && n.length > 0,
  );
  return names.length > 0 ? names : undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

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
          fullscreenCopyOnSelect: parseBoolean(featureRec.fullscreenCopyOnSelect),
        }
      : undefined,
  };
}

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

const FEATURE_KEYS = [
  "rightClickCopyPaste",
  "modelSwitch",
  "retry",
  "editorSelection",
  "fullscreenCopyOnSelect",
] as const;
function mergeFeatures(layers: ConfigLayer[]): SideChatFeatures {
  const features: SideChatFeatures = {
    rightClickCopyPaste: true,
    modelSwitch: true,
    retry: true,
    editorSelection: true,
    // Opt-in mirror (spec #37): unlike the other switches this one defaults
    // to false — gestures must never copy on their own unless asked.
    fullscreenCopyOnSelect: false,
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
