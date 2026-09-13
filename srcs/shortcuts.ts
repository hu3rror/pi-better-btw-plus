import { matchesKey, type KeyId } from "@earendil-works/pi-tui";

/** Open, background, or restore the side chat from the main editor. */
export const SIDE_CHAT_SHORTCUT: KeyId = "alt+w";

interface Keybinding {
  readonly keys: readonly KeyId[];
  readonly hint: string;
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
 * key(s) AND its hint-bar label. `handleInput` matches against `.keys` and the
 * hint bar reads `.hint`, so a rebind updates matching and label together
 * instead of scattering magic strings across handleInput / hints / docs.
 */
export const KEYBINDINGS = {
  /** Open (closed) / background (visible) / restore (hidden). */
  background: { keys: [SIDE_CHAT_SHORTCUT], hint: "A+w bg" },
  /** Re-fork from the latest main context. */
  refork: { keys: ["alt+r"], hint: "A+r fork" },
  /** Start an empty conversation. */
  clear: { keys: ["alt+n"], hint: "A+n new" },
  /** Export the transcript. */
  export: { keys: ["alt+e"], hint: "A+e export" },
  /** Fork model picker (pi `app.model.select` parity). */
  modelPicker: { keys: ["ctrl+l"], hint: "C+l model" },
  /** Read-only / edit mode toggle (Ctrl+T freed for pi's thinking toggle). */
  toggleMode: { keys: ["alt+t"], hint: "A+t" },
  /** Copy the active mouse selection (pi `tui.input.copy` parity). */
  /**
   * Copy the active mouse selection (pi `tui.input.copy` parity). Without
   * one, bare Ctrl+C clears the input box (pi `app.clear` parity, spec #22);
   * Ctrl+Shift+C stays a forced copy.
   */
  copySelection: { keys: ["ctrl+c", "ctrl+shift+c"], hint: "C+c copy/clear" },
  /** Copy the last side-chat assistant message (pi `app.message.copy` parity). */
  copyLastMessage: { keys: ["ctrl+x"], hint: "C+x last" },
  /** Copy all input editor text (expanded paste markers — submit semantics). */
  copyInput: { keys: ["alt+shift+c"], raw: ["\x1bC", "\x1b[27;3;99~"], hint: "A+⇧C all" },
  /** Paste clipboard text (pi `app.clipboard.pasteImage` parity). */
  paste: { keys: ["ctrl+v", "alt+v"], hint: "C+v paste" },
} as const satisfies Record<string, Keybinding>;

/** True when `data` matches any of the keys. */
export function matchesAnyKey(data: string, keys: readonly KeyId[]): boolean {
  return keys.some((key) => matchesKey(data, key));
}

/** True when `data` matches a binding's keys or one of its raw encodings. */
export function matchesKeybinding(data: string, kb: Keybinding): boolean {
  if (kb.raw?.includes(data)) return true;
  return matchesAnyKey(data, kb.keys);
}
