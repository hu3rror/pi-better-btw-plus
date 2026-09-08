/**
 * Clipboard write-side mock — shared facility for clipboard tests.
 *
 * The real `copyToClipboard` cascade (native addon → wl-copy/xclip → OSC 52)
 * is platform-dependent: on Windows the native addon wins and no OSC 52
 * sequence is ever written to stdout, so intercepting `process.stdout.write`
 * cannot assert copy content there. Instead, `@earendil-works/pi-coding-agent`
 * is mocked with its real exports spread and only `copyToClipboard` overridden
 * (the overlay imports the rest of the module at runtime, so a partial mock
 * would break it). Tests assert that the copied text flowed into the mocked
 * clipboard function rather than into platform-specific output.
 *
 * Usage (each test file gets its own instance; import this before importing
 * anything that calls `copyToClipboard`, e.g. `side-chat-overlay.ts`):
 *
 * ```ts
 * await import("./helpers/clipboard-mock.ts");
 * const { capturedCopies, copiedTexts, setCopyImplementation } = await import(
 *   "./helpers/clipboard-mock.ts",
 * );
 * const { SideChatOverlay } = await import("../srcs/side-chat-overlay.ts");
 * ```
 *
 * Assert with `copiedTexts()` (returns and drains) or `capturedCopies`
 * directly. Simulate copy failure with `setCopyImplementation(() => { throw ... })`
 * and restore with `resetCopyImplementation()`.
 */
import { mock } from "bun:test";

/** Texts that flowed into the mocked clipboard, in copy order. */
export const capturedCopies: string[] = [];

/** The active clipboard implementation; swap it per test to simulate failures. */
const capture = async (text: string): Promise<void> => {
  capturedCopies.push(text);
};
let impl: (text: string) => Promise<void> = capture;

/** Replace the clipboard implementation (e.g. one that throws). */
export function setCopyImplementation(
  fn: (text: string) => Promise<void>,
): void {
  impl = fn;
}

/** Restore the default capturing implementation. */
export function resetCopyImplementation(): void {
  impl = capture;
}

/** Return and drain the texts captured so far. */
export function copiedTexts(): string[] {
  const out = [...capturedCopies];
  capturedCopies.length = 0;
  return out;
}

// Load the real module first, then mock it with `copyToClipboard` overridden.
// `mock.module` applies to the importing test file's module graph, so the
// overlay must be imported after this file.
const real = await import("@earendil-works/pi-coding-agent");
mock.module("@earendil-works/pi-coding-agent", () => ({
  ...real,
  copyToClipboard: (text: string) => impl(text),
}));
