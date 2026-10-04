<p>
  <img src="https://raw.githubusercontent.com/hu3rror/pi-better-btw-plus/main/banner.png" alt="pi-better-btw-plus" width="1100">
</p>

# pi-better-btw-plus

**English | [简体中文](README.zh-CN.md)**

[![npm version](https://img.shields.io/npm/v/pi-better-btw-plus?style=for-the-badge)](https://www.npmjs.com/package/pi-better-btw-plus)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

A side-chat overlay for [pi](https://github.com/earendil-works/pi-coding-agent), the coding agent. While the main agent keeps working, `/btw` forks the current conversation into its own overlay — ask about an API detail, sanity-check an approach, get an answer, close it. The main thread is never interrupted.

## Features

### The side chat

- **Non-blocking fork** — the side chat is a fresh agent cloned from your current session, rendered in a top overlay. The main editor stays visible underneath and keeps running.
- **Read-only by default** — out-of-lane tool calls are hard-blocked (a second violation escalates and aborts the turn); `peek_main` reads the main session's recent activity on demand; `Alt+T` switches to edit mode.
- **Prefix-cache friendly** — the side request shares the main session's context, so it hits the gateway's prefix cache and stays fast and cheap.
- **Conversation tools** — re-fork from the latest context (`Alt+R`), start an empty conversation (`Alt+N`), background without losing state (`Alt+W`), export the transcript (`Alt+E`), override any injected prompt with a prompt pack.
- **Write-overlap guard** — files the main session has written while the side chat is open are protected: writing to one of those paths asks for confirmation first.

### Aligned with pi

No custom interaction language — shortcuts and behavior follow pi's own conventions, so the side chat feels like the main session:

- **Shortcuts mirror the main session** — copy/clear, paste, last-message copy, model picker and keymap screen follow pi's official bindings (`tui.input.copy`, `app.clear`, `app.clipboard.pasteImage`, `app.message.copy`, `app.model.select`, `app.tools.expand`). When a key collides, pi wins: `Alt+T` toggles mode so `Ctrl+T` stays pi's thinking toggle.
- **Behavior matches the main session** — retry, overflow handling, clipboard and model selection work exactly like pi itself, and the overlay follows pi's own window geometry.

### Terminal muscle memory, re-implemented

The overlay owns the terminal's mouse while open, so conveniences the main session inherits from Windows Terminal or `AgentSession` are rebuilt inside it:

| Feature | What you get |
| --- | --- |
| **Input editor selection** | Drag-select inside the input box with a live inverse-video highlight; double-click selects a word, triple-click a whole visual line. `Ctrl+C` / `Ctrl+Shift+C` copy it. |
| **Right-click copy & paste** | Drag-select chat text and right-click to copy — Windows Terminal muscle memory. Right-click inside the input editor pastes the system clipboard through the editor's own paste entry. |
| **Fork model switch** (`Ctrl+L`) | Pick any authenticated model for the side chat without rebuilding the fork. Fork-local: the main session's model is never touched. |
| **Turn-level auto-retry** | Shares pi's `settings.retry` budget. Transient provider errors back off with a live countdown; `Esc` cancels. |
| **`Ctrl+C` clear-input parity** | With nothing selected, `Ctrl+C` clears the input box. A successful copy consumes the selection, so the next `Ctrl+C` returns to clearing. |
| **`Alt+Shift+C` full-draft copy** | Copies the whole draft with paste markers expanded — exactly what a submit would send. Works on terminals without the kitty protocol too. |
| **Keymap screen** (`Ctrl+O`) | The hint bar shows only the essentials; `Ctrl+O` opens the full keymap, grouped by function. |
| **Feature kill switches** | `features.rightClickCopyPaste` / `modelSwitch` / `retry` / `editorSelection` turn any of the above off per config layer. |

While the overlay is open it consumes every mouse sequence: wheel scrolls, drag selects, right-click copies or pastes. Background it (`Alt+W`) and the mouse returns to the terminal.

### Input editor selection

- **Drag** — select a range with a live inverse-video highlight (~30fps).
- **Double-click** — select the word under the cursor; **triple-click** — the whole visual line.
- Selections are transient (typing or moving the cursor clears them), never cross a `[paste #N …]` marker, and are disabled while the autocomplete popup is open.

## Install & quick start

```bash
pi install npm:pi-better-btw-plus
```

In pi's TUI, open the side chat with `/btw` (or the original `/side`) or `Alt+W`. Ask, press `Enter`, close with `Esc`. Reopening continues the same conversation.

> [!NOTE]
> Verified against pi `1.0.2`.

## Keybindings

| Key | Action |
| --- | --- |
| `Alt+W` | Open (closed) / background (visible) / restore (hidden) |
| `Ctrl+O` | Open the keymap screen (full keymap modal) |
| `Enter` / `Esc` | Send / interrupt streaming or cancel a retry backoff; close when idle |
| `Alt+T` | Toggle read-only / edit mode |
| `Alt+R` | Re-fork from the latest main context |
| `Alt+N` | Start an empty conversation |
| `Alt+E` | Export the transcript to `$CWD/.agents/eval/pi-better-btw-<timestamp>.md` |
| `Ctrl+L` | Fork model picker (`↑/↓` select, `Enter` confirm, `Esc` cancel) |
| `Ctrl+C` / `Ctrl+Shift+C` | Copy the active selection (chat or editor); bare `Ctrl+C` with none clears the input |
| `Ctrl+X` | Copy the last side-chat assistant message |
| `Alt+Shift+C` | Copy the whole input editor text (paste markers expanded) |
| `Ctrl+V` / `Alt+V` | Paste the system clipboard into the editor |
| `PgUp` / `PgDn`, `Shift+↑` / `Shift+↓`, mouse wheel | Scroll the chat history |
| Mouse drag / double-click | Select chat text (inverse-video highlight) / the rendered line |
| Mouse right-click | Copy the retained selection (chat) / paste (editor) |

## Commands

- `/btw`, `/side` — open the side chat (both are registered, aliases of each other; `/btw` is the project's namesake, `/side` the original name).
- `peek_main` — available to the side agent only; reads the main session's recent activity. `lines` (default 20, max 50), `since_fork` (only activity after the side chat opened).

## Configuration

`config.json` is read from three layers; a later layer overrides earlier ones per key:

| Layer | Location |
| --- | --- |
| Bundle (defaults) | `config.json` in the package |
| User | `~/.pi/agent/pi-better-btw/config.json` |
| Project | `<project>/.pi/pi-better-btw/config.json` |

- `features` — kill switches, each defaulting to `true`: `rightClickCopyPaste`, `modelSwitch`, `retry`, `editorSelection`.
- `readOnlyExtensionAllowlist` — extension tools allowed in the read-only lane. Lists union across layers; the builtin `read`/`grep`/`find`/`ls` and `peek_main` are always included.
- `readOnlyExtensionAllowlistExclude` — remove bundled defaults.
- `promptPack` — override any injected prompt (framing, focus anchor, lane reminders) with your own markdown files; missing keys fall back to the bundled `prompts/`.

```json
{
  "readOnlyExtensionAllowlist": ["pi-vision-helper"],
  "features": { "editorSelection": false }
}
```

## How it works

- The side chat is a fresh agent cloned from your current session, rendered in a top overlay — the main editor stays visible and keeps running underneath.
- Read-only mode (default) is enforced: an out-of-lane tool call is blocked, and a second violation escalates and aborts the turn. `peek_main` reads the main session's recent activity on demand.
- While the overlay is open it owns the mouse: wheel scrolls, drag selects, right-click copies or pastes. Backgrounding (`Alt+W`) returns the mouse to the terminal.

## Development

pi loads TypeScript directly — there is no build step. Point pi's extension loader at `./srcs/index.ts` (the entry point; the rest of `srcs/` holds the overlay, lane enforcement, retry and clipboard code) and run `/reload` after edits.

```bash
bun install
bun run typecheck
bun test
```

## Limitations

- One side chat at a time; won't open on top of another visible overlay.
- Doesn't merge messages back into the main thread.
- Bash overlap detection is heuristic — catches common write patterns, not all.
- `peek_main` is on-demand, not live.
- Mouse interaction works only in the regular (non-fullscreen) TUI mode.

## License & origin

MIT — see [LICENSE](LICENSE). This project is a maintained fork of [`@yceachan/pi-better-btw`](https://www.npmjs.com/package/@yceachan/pi-better-btw), itself a fork of [nicobailon/pi-side-chat](https://github.com/nicobailon/pi-side-chat). All three copyright lines are retained: Nico Bailon, yceachan, hu3rror.
