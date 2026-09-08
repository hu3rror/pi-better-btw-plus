/**
 * Clipboard read-side mock — shared facility for right-click paste tests.
 *
 * The overlay's paste path calls `readClipboardTextFromSystem()` from
 * clipboard-read.ts. This helper mocks that module with the real exports
 * spread and a settable outcome, so tests drive small / large / empty /
 * failed reads without touching the host clipboard (mirror of
 * helpers/clipboard-mock.ts, the write-side facility from D13).
 *
 * Usage (import this before importing anything that pulls in
 * side-chat-overlay.ts, which statically imports the reader):
 *
 * ```ts
 * await import("./helpers/clipboard-read-mock.ts");
 * const { setClipboardReadResult, setClipboardReadEmpty } = await import(
 *   "./helpers/clipboard-read-mock.ts",
 * );
 * const { SideChatOverlay } = await import("../srcs/side-chat-overlay.ts");
 * ```
 *
 * `setClipboardReadResult(null)` simulates every platform channel failing;
 * `setClipboardReadEmpty()` simulates a readable but empty clipboard.
 */
import { mock } from "bun:test";
import type { ClipboardReadOutcome } from "../../srcs/clipboard-read.ts";

let result: ClipboardReadOutcome = { ok: false, reason: "unavailable" };

/** Set the text the next clipboard read resolves to (null = read failed). */
export function setClipboardReadResult(text: string | null): void {
  result =
    text === null
      ? { ok: false, reason: "unavailable" }
      : { ok: true, text };
}

/** Simulate a readable clipboard that holds no text. */
export function setClipboardReadEmpty(): void {
  result = { ok: false, reason: "empty" };
}

// Load the real module first, then mock it with only the read entry
// overridden. `mock.module` applies to the importing test file's module
// graph, so the overlay must be imported after this file.
const real = await import("../../srcs/clipboard-read.ts");
mock.module("../../srcs/clipboard-read.ts", () => ({
  ...real,
  readClipboardTextFromSystem: async () => result,
}));
