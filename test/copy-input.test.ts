/**
 * Alt+Shift+C copy-input integration tests (issue #23): the hotkey copies
 * the whole input editor text — paste markers expanded, i.e. the same text
 * a submit would send — to the system clipboard.
 *
 * Same overlay seam and clipboard write-side mock as test/select.test.ts:
 * drive the real overlay through `handleInput` with terminal sequences and
 * assert what flowed into the mocked `copyToClipboard`, plus the status
 * line feedback. The input editor is reached through the established
 * `(overlay as any).editor` handle for seeding/asserting editor text.
 */
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

// Alt+Shift+C via kitty CSI-u: mod = shift|alt + 1 = 4 (same encoding
// convention as `\x1b[99;6u` for ctrl+shift+c in test/select.test.ts).
// The legacy ESC+C form is unparseable (parseKey only maps ESC+lowercase
// to alt+letter), so tests use the CSI-u sequence.
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
    // Unlike Ctrl+C's clear-input lane, copy never modifies the draft.
    expect(editor.getText()).toBe("draft prompt");
  });

  test("copies paste-marker-expanded text (submit semantics)", async () => {
    const overlay = makeOverlay();
    // >10 lines via bracketed paste folds into a [paste #1 +X lines] marker.
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
    copiedTexts(); // consume the copy this test produced
  });
});
