import { matchesKey, type KeyId } from "@earendil-works/pi-tui";

/** Open, background, or restore the side chat from the main editor. */
export const SIDE_CHAT_SHORTCUT: KeyId = "alt+w";

interface Keybinding {
  readonly keys: readonly KeyId[];
  readonly hint: string;
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
  /** Paste clipboard text (pi `app.clipboard.pasteImage` parity). */
  paste: { keys: ["ctrl+v", "alt+v"], hint: "C+v paste" },
} as const satisfies Record<string, Keybinding>;

/** True when `data` matches any of the keys. */
export function matchesAnyKey(data: string, keys: readonly KeyId[]): boolean {
  return keys.some((key) => matchesKey(data, key));
}
