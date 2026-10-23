import { describe, expect, test } from "bun:test";
import { makeOverlay as sharedMakeOverlay } from "./helpers/make-overlay.ts";

// Shared clipboard write-side mock (must load before side-chat-overlay.ts,
// which imports copyToClipboard from @earendil-works/pi-coding-agent).
await import("./helpers/clipboard-mock.ts");
const { copiedTexts } = await import("./helpers/clipboard-mock.ts");
const { SideChatOverlay } = await import("../srcs/side-chat-overlay.ts");

const makeOverlay = (messages?: any[], overrides: Record<string, unknown> = {}) =>
  sharedMakeOverlay(SideChatOverlay, messages, overrides);

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const COPY_INPUT = "\x1b[99;4u";

describe("Alt+Shift+C copy input (issue #23)", () => {
  test("copies the whole input editor text without touching the input", async () => {
    const overlay = makeOverlay();
    overlay.handleInput("draft prompt");
    const editor: any = (overlay as any).editor;
    expect(editor.getText()).toBe("draft prompt");
    overlay.handleInput(COPY_INPUT);
    await tick();
    expect(copiedTexts()).toEqual(["draft prompt"]);
    expect(editor.getText()).toBe("draft prompt");
  });

  test("copies paste-marker-expanded text (submit semantics)", async () => {
    const overlay = makeOverlay();
    const manyLines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    overlay.handleInput(`\x1b[200~${manyLines}\x1b[201~`);
    const editor: any = (overlay as any).editor;
    expect(editor.getText()).toContain("[paste #1");
    overlay.handleInput(COPY_INPUT);
    await tick();
    expect(copiedTexts()).toEqual([manyLines]);
  });

  test("empty input flashes a hint and copies nothing", async () => {
    const overlay = makeOverlay();
    overlay.handleInput(COPY_INPUT);
    await tick();
    expect(copiedTexts()).toEqual([]);
    const M: any = (overlay as any).messages;
    expect(M.render(80).some((l: string) => l.includes("Input is empty"))).toBe(
      true,
    );
  });

  test("success shows the copy feedback with char count", async () => {
    const overlay = makeOverlay();
    overlay.handleInput("hello input");
    overlay.handleInput(COPY_INPUT);
    await tick();
    const M: any = (overlay as any).messages;
    expect(M.render(80).some((l: string) => l.includes("Copied"))).toBe(true);
    expect(M.render(80).some((l: string) => l.includes("11 chars"))).toBe(true);
    copiedTexts();
  });

  test("copies via the legacy ESC+C encoding (no kitty protocol)", async () => {
    const overlay = makeOverlay();
    overlay.handleInput("legacy draft");
    overlay.handleInput("\x1bC");
    await tick();
    expect(copiedTexts()).toEqual(["legacy draft"]);
  });

  test("copies via the modifyOtherKeys encoding (mode-2 fallback)", async () => {
    // pi-tui enables modifyOtherKeys mode 2 when kitty negotiation fails;
    // terminals that honor it send Alt+Shift+C as ESC [ 27 ; 3 ; 99 ~.
    const overlay = makeOverlay();
    overlay.handleInput("mok draft");
    overlay.handleInput("\x1b[27;3;99~");
    await tick();
    expect(copiedTexts()).toEqual(["mok draft"]);
  });
});
