import { mock } from "bun:test";
import type { ClipboardReadOutcome } from "../../srcs/clipboard-read.ts";

let result: ClipboardReadOutcome = { ok: false, reason: "unavailable" };

export function setClipboardReadResult(text: string | null): void {
  result =
    text === null
      ? { ok: false, reason: "unavailable" }
      : { ok: true, text };
}

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
