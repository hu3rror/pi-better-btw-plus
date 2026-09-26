import { matchesKey, type KeyId } from "@earendil-works/pi-tui";

/** Open, background, or restore the side chat from the main editor. */
export const SIDE_CHAT_SHORTCUT: KeyId = "alt+w";

export interface Keybinding {
  readonly keys: readonly KeyId[];
  /**
   * Short label — the compact hint bar renders it next to the first key
   * (e.g. `Ctrl+V paste`).
   */
  readonly label: string;
  /**
   * Longer description — the keymap screen renders it next to all keys
   * (e.g. `Ctrl+V/Alt+V paste`). Falls back to `label` when absent.
   */
  readonly description?: string;
  /**
   * Raw terminal encodings that also trigger this action, besides the
   * parser-recognizable `keys`. Needed because pi-tui's parser cannot express
   * alt+shift+letter: its legacy branch only maps ESC+lowercase to alt+letter,
   * and its modifyOtherKeys parse drops the shift bit. Terminals without the
   * kitty keyboard protocol (Windows Terminal < 1.25) deliver Alt+Shift+C as
   * the legacy ESC+'C' form (shift folded into case), which parseKey returns
   * undefined for — so the binding must match the raw bytes too. Only
   * copyInput needs this today.
   */
  readonly raw?: readonly string[];
}

/**
 * Side-chat keybindings — the single source of truth for each action's bound
 * key(s) AND its hint labels. `handleInput` matches against `.keys` and the
 * hint bar / keymap screen render from `.label` / `.description`, so a rebind
 * updates matching and display together instead of scattering magic strings
 * across handleInput / hints / docs.
 */
export const KEYBINDINGS = {
  /** Open (closed) / background (visible) / restore (hidden). */
  background: { keys: [SIDE_CHAT_SHORTCUT], label: "bg", description: "background" },
  /** Re-fork from the latest main context. */
  refork: { keys: ["alt+r"], label: "refork" },
  /** Start an empty conversation. */
  clear: { keys: ["alt+n"], label: "new" },
  /** Export the transcript. */
  export: { keys: ["alt+e"], label: "export" },
  /** Fork model picker (pi `app.model.select` parity). */
  modelPicker: { keys: ["ctrl+l"], label: "model", description: "model picker" },
  /** Read-only / edit mode toggle (Ctrl+T freed for pi's thinking toggle). */
  toggleMode: { keys: ["alt+t"], label: "mode", description: "toggle edit/read-only" },
  /**
   * Copy the active mouse selection (pi `tui.input.copy` parity). Without
   * one, bare Ctrl+C clears the input box (pi `app.clear` parity, spec #22);
   * Ctrl+Shift+C stays a forced copy.
   */
  copySelection: { keys: ["ctrl+c", "ctrl+shift+c"], label: "copy" },
  /** Copy the last side-chat assistant message (pi `app.message.copy` parity). */
  copyLastMessage: { keys: ["ctrl+x"], label: "last" },
  /** Copy all input editor text (expanded paste markers — submit semantics). */
  copyInput: { keys: ["alt+shift+c"], raw: ["\x1bC", "\x1b[27;3;99~"], label: "draft" },
  /** Paste clipboard text (pi `app.clipboard.pasteImage` parity). */
  paste: { keys: ["ctrl+v", "alt+v"], label: "paste" },
  /** Open the keymap screen (full keymap modal; pi `app.tools.expand` key). */
  keymapScreen: { keys: ["ctrl+o"], label: "help" },
} as const satisfies Record<string, Keybinding>;

/** Capitalize one key part: `ctrl` → `Ctrl`. */
function formatKeyPart(part: string): string {
  return part.charAt(0).toUpperCase() + part.slice(1);
}

/** Display form of keys: `["ctrl+c", "ctrl+shift+c"]` → `Ctrl+C/Ctrl+Shift+C`. */
export function formatKeyText(keys: readonly KeyId[]): string {
  return keys
    .map((k) => k.split("+").map(formatKeyPart).join("+"))
    .join("/");
}

/**
 * Display pieces of a binding. `longForm` uses all keys + the longer
 * description (keymap screen); compact mode uses the first key + the short
 * label (hint bar). Kept separate from rendering so the overlay can style
 * keys dim and labels muted (pi keyHint grammar) while shortcuts.ts stays
 * the source.
 */
export function bindingText(
  kb: Keybinding,
  longForm = false,
): { keyText: string; label: string } {
  return {
    keyText: formatKeyText(longForm ? kb.keys : kb.keys.slice(0, 1)),
    label: longForm ? (kb.description ?? kb.label) : kb.label,
  };
}

/** True when `data` matches any of the keys. */
export function matchesAnyKey(data: string, keys: readonly KeyId[]): boolean {
  return keys.some((key) => matchesKey(data, key));
}

/** True when `data` matches a binding's keys or one of its raw encodings. */
export function matchesKeybinding(data: string, kb: Keybinding): boolean {
  if (kb.raw?.includes(data)) return true;
  return matchesAnyKey(data, kb.keys);
}
