/**
 * Fork model switching (issue #5): pure list-building / thinking-level clamp
 * unit tests + overlay integration (Alt+M modal, apply, streaming reject).
 *
 * `getSelectListTheme()` from pi-coding-agent returns lazy closures over the
 * global theme singleton (throws "Theme not initialized" without initTheme),
 * so it is mocked with a plain theme for the picker render tests.
 */
import { describe, expect, mock, test } from "bun:test";
import type { SideChatOverlay as SideChatOverlayType } from "../srcs/side-chat-overlay.ts";
import {
  buildModelChoices,
  clampThinkingLevelForModel,
  modelKey,
} from "../srcs/model-switch.ts";

// Load the real module, then mock only the select-list theme (the overlay
// imports the rest of pi-coding-agent at runtime, so a partial mock would
// break it). Must happen before importing side-chat-overlay.ts.
const realPi = await import("@earendil-works/pi-coding-agent");
const identity = (text: string) => text;
mock.module("@earendil-works/pi-coding-agent", () => ({
  ...realPi,
  getSelectListTheme: () => ({
    selectedPrefix: identity,
    selectedText: identity,
    description: identity,
    scrollInfo: identity,
    noMatch: identity,
  }),
}));
const { SideChatOverlay, buildSideChatHintLines } = await import("../srcs/side-chat-overlay.ts");

import type { Model } from "@earendil-works/pi-ai";

// --- Fake model / registry fixtures -----------------------------------------

/** Build a minimal real-shaped Model fixture (all required fields). */
function makeModel(
  id: string,
  reasoning = true,
  thinkingLevelMap?: Record<string, string | null>,
): Model<any> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "test",
    baseUrl: "http://test.local",
    reasoning,
    thinkingLevelMap,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };
}

function makeScoped(model: Model<any>, thinkingLevel?: string) {
  return { model, thinkingLevel } as any;
}

/** Minimal ModelRegistry stub: available catalogue + per-model auth. */
function makeRegistry(
  available: Model<any>[],
  authed: string[],
  providerDisplayName = "Test Provider",
) {
  return {
    getAvailable: () => available,
    hasConfiguredAuth: (model: { id: string }) => authed.includes(model.id),
    getProviderDisplayName: () => providerDisplayName,
  };
}

// --- Overlay fixture ----------------------------------------------------------

const theme: any = { fg: (_name: string, text: string) => text };
const WIDTH = 102;

function makeOverlay(overrides: any = {}): SideChatOverlayType {
  const opts: any = {
    tui: {
      terminal: { columns: 120, rows: 40, write: () => {} },
      requestRender: () => {},
    },
    theme,
    forkContext: {
      messages: [],
      model: makeModel("current-model"),
      systemPrompt: "",
      thinkingLevel: "medium",
      cwd: "/tmp",
      extensionTools: [],
    },
    tracker: { writeCount: 0 },
    modelRegistry: makeRegistry([], []),
    scopedModels: [],
    sessionManager: { getEntries: () => [], getLeafId: () => null },
    promptPack: {
      framing: "",
      focusAnchor: "",
      laneReminders: { preamble: "", base: "", escalated: "", failedNote: "" },
    },
    readOnlyExtensionAllowlist: [],
    retryPolicy: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
    features: { rightClickCopyPaste: true, modelSwitch: true, retry: true },
    onOverlapWarning: async () => true,
    onBackground: () => {},
    onExport: () => {},
    onClose: () => {},
    ...overrides,
  };
  return new SideChatOverlay(opts);
}

const ALT_M = "\x1bm"; // legacy Alt+M: ESC + m
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";

function picker(overlay: SideChatOverlayType): any {
  return (overlay as any).modelPicker;
}

function agentState(overlay: SideChatOverlayType): any {
  // The overlay owns the runner; the agent lives behind runner.agent.
  return (overlay as any).runner.agent.state;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// --- Pure: buildModelChoices --------------------------------------------------

describe("buildModelChoices", () => {
  const a = makeModel("a");
  const b = makeModel("b");
  const c = makeModel("c");

  test("scoped models win when the session scoped any", () => {
    const choices = buildModelChoices(
      [makeScoped(b), makeScoped(c)],
      [a, b, c],
      () => true,
    );
    expect(choices.map((ch) => ch.model.id)).toEqual(["b", "c"]);
  });

  test("empty scoped set falls back to the available catalogue", () => {
    const choices = buildModelChoices([], [a, b, c], () => true);
    expect(choices.map((ch) => ch.model.id)).toEqual(["a", "b", "c"]);
  });

  test("models without configured auth are dropped from both sources", () => {
    const scoped = buildModelChoices(
      [makeScoped(a), makeScoped(b)],
      [a, b, c],
      (m) => m.id !== "a",
    );
    expect(scoped.map((ch) => ch.model.id)).toEqual(["b"]);
    const fallback = buildModelChoices(
      [],
      [a, b, c],
      (m) => m.id !== "c",
    );
    expect(fallback.map((ch) => ch.model.id)).toEqual(["a", "b"]);
  });

  test("scoped thinking level is preserved; fallback leaves it undefined", () => {
    const scoped = buildModelChoices(
      [makeScoped(b, "high")],
      [a, b, c],
      () => true,
    );
    expect(scoped[0].thinkingLevel).toBe("high");
    const fallback = buildModelChoices([], [a, b, c], () => true);
    expect(fallback.every((ch) => ch.thinkingLevel === undefined)).toBe(true);
  });

  test("empty everywhere yields an empty list", () => {
    expect(buildModelChoices([], [], () => true)).toEqual([]);
  });
});

// --- Pure: clampThinkingLevelForModel -----------------------------------------

describe("clampThinkingLevelForModel", () => {
  test("a model without reasoning clamps any level to off", () => {
    const plain = makeModel("plain", false);
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      expect(clampThinkingLevelForModel(plain as any, level as any)).toBe("off");
    }
  });

  test("a reasoning model keeps a supported level", () => {
    const reasoning = makeModel("thinking");
    expect(
      clampThinkingLevelForModel(reasoning as any, "medium" as any),
    ).toBe("medium");
  });

  test("a level explicitly nulled in the map clamps down", () => {
    const capped = makeModel("capped", true, { medium: "m", high: null });
    expect(
      clampThinkingLevelForModel(capped as any, "high" as any),
    ).toBe("medium");
    expect(
      clampThinkingLevelForModel(capped as any, "max" as any),
    ).toBe("medium");
  });
});

// --- Overlay: Alt+M picker ------------------------------------------------------

describe("side-chat-overlay model picker", () => {
  const modelA = makeModel("model-a");
  const modelB = makeModel("model-b", false); // no reasoning
  const available = [modelA, modelB];

  test("Alt+M opens the modal list; the frame renders it", () => {
    const overlay = makeOverlay({
      modelRegistry: makeRegistry(available, ["model-a", "model-b"]),
    });
    overlay.handleInput(ALT_M);
    expect(picker(overlay)).not.toBeNull();
    const lines = overlay.render(WIDTH);
    const stripped = lines.map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, ""));
    expect(stripped.some((l: string) => l.includes("model-a"))).toBe(true);
    expect(stripped.some((l: string) => l.includes("Select model"))).toBe(true);
    expect(stripped.some((l: string) => l.includes("↑/↓ select"))).toBe(true);
  });

  test("the list uses scoped models when configured, else the catalogue", () => {
    const scoped = makeOverlay({
      modelRegistry: makeRegistry(available, ["model-a", "model-b"]),
      scopedModels: [makeScoped(modelB)],
    });
    scoped.handleInput(ALT_M);
    const items = picker(scoped).filteredItems;
    expect(items.map((i: any) => i.value)).toEqual([modelKey(modelB)]);
  });

  test("unauthenticated models never reach the list", () => {
    const overlay = makeOverlay({
      modelRegistry: makeRegistry(available, ["model-a"]), // b lacks auth
    });
    overlay.handleInput(ALT_M);
    const items = picker(overlay).filteredItems;
    expect(items.map((i: any) => i.value)).toEqual([modelKey(modelA)]);
  });

  test("no authenticated models: picker stays closed with a status hint", () => {
    const overlay = makeOverlay({
      modelRegistry: makeRegistry(available, []),
    });
    overlay.handleInput(ALT_M);
    expect(picker(overlay)).toBeNull();
    const M: any = (overlay as any).messages;
    expect(
      M.render(80).some((l: string) => l.includes("No authenticated models")),
    ).toBe(true);
  });

  test("Enter applies the selected model; thinking clamps for non-reasoning", () => {
    const forkModel = makeModel("current-model");
    const overlay = makeOverlay({
      modelRegistry: makeRegistry(available, ["model-a", "model-b"]),
      forkContext: {
        messages: [],
        model: forkModel,
        systemPrompt: "",
        thinkingLevel: "medium",
        cwd: "/tmp",
        extensionTools: [],
      },
    });
    // Preselected current model (index 0 = model-a). Move down to model-b
    // (non-reasoning) and confirm.
    overlay.handleInput(ALT_M);
    overlay.handleInput(DOWN);
    overlay.handleInput(ENTER);
    expect(picker(overlay)).toBeNull();
    expect(agentState(overlay).model.id).toBe("model-b");
    expect(agentState(overlay).thinkingLevel).toBe("off");
    // The fork's model object (main-session model) is untouched (fork-local).
    expect((overlay as any).options.forkContext.model).toBe(forkModel);
  });

  test("Enter on the preselected current model keeps it", () => {
    const overlay = makeOverlay({
      modelRegistry: makeRegistry(available, ["model-a", "model-b"]),
    });
    overlay.handleInput(ALT_M);
    overlay.handleInput(ENTER);
    expect(agentState(overlay).model.id).toBe("model-a");
    expect(agentState(overlay).thinkingLevel).toBe("medium");
  });

  test("a scoped thinking level overrides the current level", () => {
    const overlay = makeOverlay({
      modelRegistry: makeRegistry(available, ["model-a", "model-b"]),
      scopedModels: [makeScoped(modelB, "low")],
    });
    overlay.handleInput(ALT_M);
    overlay.handleInput(ENTER);
    // model-b has no reasoning → the scoped "low" still clamps to off.
    expect(agentState(overlay).model.id).toBe("model-b");
    expect(agentState(overlay).thinkingLevel).toBe("off");
  });

  test("Esc cancels without touching the agent state", () => {
    const overlay = makeOverlay({
      modelRegistry: makeRegistry(available, ["model-a", "model-b"]),
    });
    overlay.handleInput(ALT_M);
    overlay.handleInput(ESC);
    expect(picker(overlay)).toBeNull();
    expect(agentState(overlay).model.id).toBe("current-model");
    expect(agentState(overlay).thinkingLevel).toBe("medium");
  });

  test("opening is rejected while streaming", () => {
    const overlay = makeOverlay({
      modelRegistry: makeRegistry(available, ["model-a", "model-b"]),
      // A turn in flight: the runner reports isRunning and the picker stays
      // shut (the model cannot be swapped mid-turn).
      runnerFactory: () =>
        ({
          agent: {
            state: {
              model: makeModel("current-model"),
              thinkingLevel: "medium",
              messages: [],
            },
          },
          isRunning: true,
          run: async () => {},
          cancel: () => {},
        }) as any,
    });
    overlay.handleInput(ALT_M);
    expect(picker(overlay)).toBeNull();
    const M: any = (overlay as any).messages;
    expect(
      M.render(80).some((l: string) =>
        l.includes("Model switch unavailable while streaming"),
      ),
    ).toBe(true);
  });

  test("header status shows the current fork model", () => {
    const overlay = makeOverlay({
      modelRegistry: makeRegistry(available, ["model-a", "model-b"]),
    });
    const lines = overlay.render(WIDTH);
    expect(
      lines.some((l: string) => l.includes("[Model: current-model")),
    ).toBe(true);
  });

  test("Alt+W while the picker is open cancels it and backgrounds", () => {
    let backgrounded = false;
    const overlay = makeOverlay({
      modelRegistry: makeRegistry(available, ["model-a", "model-b"]),
      onBackground: () => {
        backgrounded = true;
      },
    });
    overlay.handleInput(ALT_M);
    expect(picker(overlay)).not.toBeNull();
    overlay.handleInput("\x1bw"); // Alt+W
    expect(picker(overlay)).toBeNull();
    expect(backgrounded).toBe(true);
    // The fork model was not applied (cancel, not confirm).
    expect(agentState(overlay).model.id).toBe("current-model");
  });
  test("modelSwitch=false: Alt+M is inert, the picker never opens (D11)", () => {
    const overlay = makeOverlay({
      features: { rightClickCopyPaste: true, modelSwitch: false, retry: true },
      modelRegistry: makeRegistry(available, ["model-a"]),
    });
    overlay.handleInput(ALT_M);
    expect(picker(overlay)).toBeNull();
    // The fork keeps its current model.
    expect(agentState(overlay).model.id).toBe("current-model");
  });
  test("after a model switch, the next turn's framing names the new model (self-report)", async () => {
    // Regression: the framing block carries `Model: {{model}}`, substituted at
    // open time with the MAIN session's model. Alt+M switches the fork's
    // runtime model but the framing text stayed stale, so asking the agent
    // "what model are you" answered with the old one. Every turn re-substitutes
    // the framing block with the current fork model.
    let fakeRunner: any;
    const overlay = makeOverlay({
      promptPack: {
        framing: "Model: {{model}}",
        focusAnchor: "",
        laneReminders: { preamble: "", base: "", escalated: "", failedNote: "" },
      },
      retryPolicy: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
      // Harness: build the runner from the overlay's assembled deps; the fake
      // agent carries the initial state (framing message included) and swallows
      // the turn so it never hits the network.
      runnerFactory: (runnerOptions: any) => {
        const initialState = runnerOptions.agentOptions.initialState;
        fakeRunner = {
          agent: {
            state: {
              ...initialState,
              messages: [...(initialState?.messages ?? [])],
            },
          },
          isRunning: false,
          run: async () => {},
          cancel: () => {},
        };
        return fakeRunner;
      },
    });
    // Switch the fork model the way Alt+M confirm does.
    const st = (overlay as any).runner.agent.state;
    st.model = makeModel("glm-new", false);
    // Submit through the editor (the overlay's public submit path).
    overlay.handleInput("hi");
    overlay.handleInput("\r");
    await tick();
    const framing = (st.messages as any[]).find((m) =>
      String(m.content ?? "").includes("Model:"),
    );
    expect(framing?.content).toContain("Model: glm-new");
  });

});

describe("buildSideChatHintLines (D11 feature-aware hints)", () => {
  const base = {
    scrollHint: "Pg/Scr ↑↓",
    escHint: "Esc close",
    modeHint: "Ctrl+T edit",
  };

  test("all features on: right-click and Alt+M are advertised", () => {
    const [primary, secondary] = buildSideChatHintLines({
      ...base,
      features: { rightClickCopyPaste: true, modelSwitch: true, retry: true },
    });
    expect(primary).toContain("R-click copy/paste");
    expect(secondary).toContain("A+m model");
  });

  test("rightClickCopyPaste=false: the right-click hint is dropped, hotkey hint stays", () => {
    const [primary] = buildSideChatHintLines({
      ...base,
      features: { rightClickCopyPaste: false, modelSwitch: true, retry: true },
    });
    expect(primary).not.toContain("R-click");
    expect(primary).toContain("C+c copy");
  });

  test("modelSwitch=false: the Alt+M hint is dropped, other Alt-actions stay", () => {
    const [, secondary] = buildSideChatHintLines({
      ...base,
      features: { rightClickCopyPaste: true, modelSwitch: false, retry: true },
    });
    expect(secondary).not.toContain("A+m");
    expect(secondary).toContain("A+w bg");
  });
});
