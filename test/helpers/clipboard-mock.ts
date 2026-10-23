import { mock } from "bun:test";

export const capturedCopies: string[] = [];

const capture = async (text: string): Promise<void> => {
  capturedCopies.push(text);
};
let impl: (text: string) => Promise<void> = capture;

export function setCopyImplementation(
  fn: (text: string) => Promise<void>,
): void {
  impl = fn;
}

export function resetCopyImplementation(): void {
  impl = capture;
}

export function copiedTexts(): string[] {
  const out = [...capturedCopies];
  capturedCopies.length = 0;
  return out;
}

// Load the real module first, then mock it with `copyToClipboard` overridden.
// `mock.module` applies to the importing test file's module graph, so the
// overlay must be imported after this file.
const real = await import("@earendil-works/pi-coding-agent");
const identity = (text: string) => text;
mock.module("@earendil-works/pi-coding-agent", () => ({
  ...real,
  copyToClipboard: (text: string) => impl(text),
  // Lazy select-list theme closures normally read pi's global theme singleton
  // (throws "Theme not initialized" without initTheme). The overlay constructs
  // the editor with these at open time and renders a SelectList whenever the
  // autocomplete popup or model picker is open, so suites that open those need
  // a plain identity theme (same pattern as model-switch.test.ts).
  getSelectListTheme: () => ({
    selectedPrefix: identity,
    selectedText: identity,
    description: identity,
    scrollInfo: identity,
    noMatch: identity,
  }),
}));
