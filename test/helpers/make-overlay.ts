/**
 * Shared side-chat overlay test harness: builds a `SideChatOverlay` against a
 * mocked TUI/theme with the same options every overlay suite uses, and seeds
 * it with default messages + one render (geometry needed by mouse tests).
 *
 * The overlay constructor is passed in rather than statically imported so each
 * test file keeps control of its `mock.module` ordering — the overlay must
 * load only after the clipboard mocks are registered (see clipboard-mock.ts /
 * clipboard-read-mock.ts), which top-level `await import(...)` calls in the
 * test file guarantee.
 */
import type { SideChatOverlay as SideChatOverlayType } from "../../srcs/side-chat-overlay.ts";

/** Width the overlay would compute for 120 columns (floor(120*0.85) = 102). */
export const OVERLAY_TEST_WIDTH = 102;

export const theme: any = { fg: (_name: string, text: string) => text };

export const DEFAULT_MESSAGES: any[] = [
  { role: "user", content: "hello world this is a long message" },
  {
    role: "assistant",
    content: [{ type: "text", text: "assistant reply with some content" }],
  },
  {
    role: "toolResult",
    toolName: "bash",
    content: [{ type: "text", text: "tool output line" }],
  },
];

/** Constructor shape, so the helper stays free of a static overlay import. */
export type OverlayConstructor = new (opts: any) => SideChatOverlayType;

export function makeOverlay(
  Overlay: OverlayConstructor,
  messages: any[] = DEFAULT_MESSAGES,
  overrides: Record<string, unknown> = {},
): SideChatOverlayType {
  const opts: any = {
    tui: {
      terminal: { columns: 120, rows: 40, write: () => {} },
      requestRender: () => {},
    },
    theme,
    forkContext: {
      messages: [],
      model: { id: "test-model" },
      systemPrompt: "",
      thinkingLevel: "off",
      cwd: "/tmp",
      extensionTools: [],
    },
    tracker: { writeCount: 0 },
    modelRegistry: {},
    sessionManager: { getEntries: () => [], getLeafId: () => null },
    promptPack: {
      framing: "",
      focusAnchor: "",
      laneReminders: { preamble: "", base: "", escalated: "", failedNote: "" },
    },
    readOnlyExtensionAllowlist: [],
    retryPolicy: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
    onOverlapWarning: async () => true,
    onBackground: () => {},
    onExport: () => {},
    onClose: () => {},
    ...overrides,
  };
  const overlay = new Overlay(opts);
  (overlay as any).messages.setMessages(messages);
  overlay.render(OVERLAY_TEST_WIDTH);
  return overlay;
}
