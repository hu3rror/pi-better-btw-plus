/**
 * Regression tests for the layered config resolution (config.ts):
 * bundle <extensionDir>/config.json → user ~/.pi/agent/pi-better-btw →
 * project <cwd>/.pi/pi-better-btw. Allowlists union across layers with an
 * exclude escape hatch; promptPack merges per leaf key with higher layer
 * winning and paths resolved against each layer's own directory.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadRetryPolicy } from "../srcs/config.ts";
/** Build a temp three-layer config tree and return a loadConfig handle. */
function makeTree(overrides: {
  bundle?: unknown;
  user?: unknown;
  userDirName?: string;
  project?: unknown;
  cwdName?: string;
}) {
  const root = mkdtempSync(join(tmpdir(), "pi-better-btw-config-"));
  const bundleDir = join(root, "bundle");
  const userDir = join(root, overrides.userDirName ?? "user");
  const cwd = join(root, overrides.cwdName ?? "project-cwd");
  mkdirSync(bundleDir, { recursive: true });
  mkdirSync(userDir, { recursive: true });
  mkdirSync(join(cwd, ".pi", "pi-better-btw"), { recursive: true });

  if (overrides.bundle !== undefined)
    writeFileSync(
      join(bundleDir, "config.json"),
      JSON.stringify(overrides.bundle),
    );
  if (overrides.user !== undefined)
    writeFileSync(join(userDir, "config.json"), JSON.stringify(overrides.user));
  if (overrides.project !== undefined) {
    writeFileSync(
      join(cwd, ".pi", "pi-better-btw", "config.json"),
      JSON.stringify(overrides.project),
    );
  }

  const cleanup = () => rmSync(root, { recursive: true, force: true });
  const load = (opts: { cwd?: string; userConfigDir?: string } = {}) =>
    loadConfig({
      extensionDir: bundleDir,
      cwd: opts.cwd ?? cwd,
      userConfigDir: opts.userConfigDir ?? userDir,
    });
  return { load, cleanup, root, bundleDir, userDir, cwd };
}

describe("config.ts layered resolution", () => {
  test("bundle-only: allowlist used, promptPack paths resolve against the bundle dir", () => {
    const tree = makeTree({
      bundle: {
        readOnlyExtensionAllowlist: ["web_search", "source_check"],
        promptPack: {
          framing: "prompts/f.md",
          laneReminders: { base: "prompts/base.md" },
        },
      },
    });
    try {
      const cfg = tree.load();
      expect(cfg.readOnlyExtensionAllowlist).toEqual([
        "web_search",
        "source_check",
      ]);
      expect(cfg.promptPack?.framing).toBe(
        join(tree.bundleDir, "prompts/f.md"),
      );
      expect(cfg.promptPack?.laneReminders?.base).toBe(
        join(tree.bundleDir, "prompts/base.md"),
      );
    } finally {
      tree.cleanup();
    }
  });

  test("no config anywhere: empty allowlist, no promptPack (bundle defaults only)", () => {
    const tree = makeTree({});
    try {
      const cfg = tree.load();
      expect(cfg.readOnlyExtensionAllowlist).toEqual([]);
      expect(cfg.promptPack).toBeUndefined();
    } finally {
      tree.cleanup();
    }
  });

  test("user layer unions its allowlist with the bundle; order bundle → user", () => {
    const tree = makeTree({
      bundle: { readOnlyExtensionAllowlist: ["web_search", "source_check"] },
      user: { readOnlyExtensionAllowlist: ["lens_diagnostics", "query-docs"] },
    });
    try {
      expect(tree.load().readOnlyExtensionAllowlist).toEqual([
        "web_search",
        "source_check",
        "lens_diagnostics",
        "query-docs",
      ]);
    } finally {
      tree.cleanup();
    }
  });

  test("project layer unions on top of user; duplicates dedupe keeping first occurrence", () => {
    const tree = makeTree({
      bundle: { readOnlyExtensionAllowlist: ["web_search"] },
      user: { readOnlyExtensionAllowlist: ["web_search", "lens_diagnostics"] },
      project: {
        readOnlyExtensionAllowlist: ["lens_diagnostics", "pi-vision-helper"],
      },
    });
    try {
      expect(tree.load().readOnlyExtensionAllowlist).toEqual([
        "web_search",
        "lens_diagnostics",
        "pi-vision-helper",
      ]);
    } finally {
      tree.cleanup();
    }
  });

  test("exclude drops names from the final list, including a bundled default", () => {
    const tree = makeTree({
      bundle: { readOnlyExtensionAllowlist: ["web_search", "source_check"] },
      user: {
        readOnlyExtensionAllowlist: ["lens_diagnostics"],
        readOnlyExtensionAllowlistExclude: ["web_search"],
      },
    });
    try {
      expect(tree.load().readOnlyExtensionAllowlist).toEqual([
        "source_check",
        "lens_diagnostics",
      ]);
    } finally {
      tree.cleanup();
    }
  });

  test("promptPack merges per leaf key: project wins over user, user wins over bundle, relatives resolve per layer", () => {
    const tree = makeTree({
      bundle: {
        promptPack: {
          framing: "prompts/bundle-f.md",
          laneReminders: { base: "prompts/bundle-base.md" },
        },
      },
      user: {
        promptPack: {
          framing: "user-f.md",
          laneReminders: { base: "user-base.md", escalated: "user-esc.md" },
        },
      },
      project: {
        promptPack: {
          laneReminders: {
            escalated: "proj-esc.md",
            preamble: "proj-preamble.md",
            base: "proj-base.md",
          },
        },
      },
    });
    try {
      const pack = tree.load().promptPack!;
      // framing: bundle → user override (bundle value never seen).
      expect(pack.framing).toBe(join(tree.userDir, "user-f.md"));
      // base: all three layers define it → project wins.
      expect(pack.laneReminders?.base).toBe(
        join(tree.cwd, ".pi", "pi-better-btw", "proj-base.md"),
      );
      // escalated: user then project → project wins.
      expect(pack.laneReminders?.escalated).toBe(
        join(tree.cwd, ".pi", "pi-better-btw", "proj-esc.md"),
      );
      // preamble: only project defines it → still resolved against the project layer.
      expect(pack.laneReminders?.preamble).toBe(
        join(tree.cwd, ".pi", "pi-better-btw", "proj-preamble.md"),
      );
    } finally {
      tree.cleanup();
    }
  });

  test("absolute promptPack paths pass through untouched", () => {
    const tree = makeTree({
      bundle: { promptPack: { focusAnchor: "/abs/anchors/fo.md" } },
    });
    try {
      expect(tree.load().promptPack?.focusAnchor).toBe("/abs/anchors/fo.md");
    } finally {
      tree.cleanup();
    }
  });

  test("empty or non-array allowlist/exclude entries are ignored", () => {
    const tree = makeTree({
      bundle: {
        readOnlyExtensionAllowlist: [],
        readOnlyExtensionAllowlistExclude: "web_search",
      },
      user: { readOnlyExtensionAllowlist: [42, "", "query-docs"] },
    });
    try {
      expect(tree.load().readOnlyExtensionAllowlist).toEqual(["query-docs"]);
    } finally {
      tree.cleanup();
    }
  });

  test("invalid JSON in a layer is ignored (warned) without breaking the others", () => {
    const tree = makeTree({
      bundle: { readOnlyExtensionAllowlist: ["web_search"] },
      user: { readOnlyExtensionAllowlist: ["lens_diagnostics"] },
    });
    writeFileSync(join(tree.userDir, "config.json"), "{ not json !!");
    const warnings: string[] = [];
    try {
      const cfg = loadConfig({
        extensionDir: tree.bundleDir,
        cwd: tree.cwd,
        userConfigDir: tree.userDir,
        onWarning: (m) => warnings.push(m),
      });
      expect(cfg.readOnlyExtensionAllowlist).toEqual(["web_search"]);
      expect(warnings.some((w) => w.includes("invalid config"))).toBe(true);
    } finally {
      tree.cleanup();
    }
  });

  test("missing project dir contributes nothing", () => {
    const tree = makeTree({
      bundle: { readOnlyExtensionAllowlist: ["web_search"] },
    });
    const nonexistentCwd = join(tree.root, "no-such-dir");
    try {
      expect(
        tree.load({ cwd: nonexistentCwd }).readOnlyExtensionAllowlist,
      ).toEqual(["web_search"]);
    } finally {
      tree.cleanup();
    }
  });
});

/**
 * loadRetryPolicy reads pi's own settings files — global
 * <agentConfigDir>/settings.json merged with project <cwd>/.pi/settings.json
 * (project wins per key, pi's deepMergeSettings semantics) — and extracts the
 * `retry` block with pi's defaults (enabled=true, maxRetries=3, baseDelayMs=2000).
 */
describe("loadRetryPolicy (pi settings.retry)", () => {
  function makeRetryTree(overrides: {
    global?: unknown;
    project?: unknown;
  }) {
    const root = mkdtempSync(join(tmpdir(), "pi-better-btw-retry-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "cwd");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    if (overrides.global !== undefined)
      writeFileSync(
        join(agentDir, "settings.json"),
        JSON.stringify(overrides.global),
      );
    if (overrides.project !== undefined)
      writeFileSync(
        join(cwd, ".pi", "settings.json"),
        JSON.stringify(overrides.project),
      );
    const cleanup = () => rmSync(root, { recursive: true, force: true });
    return {
      cleanup,
      agentDir,
      cwd,
      load: (opts: { cwd?: string } = {}) =>
        loadRetryPolicy({ agentConfigDir: agentDir, cwd: opts.cwd ?? cwd }),
    };
  }

  test("no settings files anywhere: pi defaults (enabled, maxRetries 3, baseDelayMs 2000)", () => {
    const tree = makeRetryTree({});
    try {
      expect(tree.load()).toEqual({
        enabled: true,
        maxRetries: 3,
        baseDelayMs: 2000,
      });
    } finally {
      tree.cleanup();
    }
  });

  test("global settings.json retry block is read (maxRetries 8 like the host's)", () => {
    const tree = makeRetryTree({
      global: { retry: { enabled: true, maxRetries: 8 } },
    });
    try {
      expect(tree.load()).toEqual({
        enabled: true,
        maxRetries: 8,
        baseDelayMs: 2000,
      });
    } finally {
      tree.cleanup();
    }
  });

  test("project layer overrides the retry block per key (deep merge, pi semantics)", () => {
    const tree = makeRetryTree({
      global: { retry: { enabled: true, maxRetries: 8, baseDelayMs: 2000 } },
      project: { retry: { maxRetries: 2 } },
    });
    try {
      expect(tree.load()).toEqual({
        enabled: true,
        maxRetries: 2,
        baseDelayMs: 2000,
      });
    } finally {
      tree.cleanup();
    }
  });

  test("enabled=false is honored (local-model debugging, zero retry overhead)", () => {
    const tree = makeRetryTree({
      global: { retry: { enabled: false, maxRetries: 3 } },
    });
    try {
      expect(tree.load()).toEqual({
        enabled: false,
        maxRetries: 3,
        baseDelayMs: 2000,
      });
    } finally {
      tree.cleanup();
    }
  });

  test("invalid JSON settings file is ignored (warned) and defaults hold", () => {
    const tree = makeRetryTree({});
    writeFileSync(join(tree.agentDir, "settings.json"), "{ broken !!");
    const warnings: string[] = [];
    try {
      const policy = loadRetryPolicy({
        agentConfigDir: tree.agentDir,
        cwd: tree.cwd,
        onWarning: (m) => warnings.push(m),
      });
      expect(policy).toEqual({ enabled: true, maxRetries: 3, baseDelayMs: 2000 });
      expect(warnings.some((w) => w.includes("settings"))).toBe(true);
    } finally {
      tree.cleanup();
    }
  });

  test("non-object retry block falls back to defaults", () => {
    const tree = makeRetryTree({ global: { retry: "disabled" } });
    try {
      expect(tree.load()).toEqual({
        enabled: true,
        maxRetries: 3,
        baseDelayMs: 2000,
      });
    } finally {
      tree.cleanup();
    }
  });
});
