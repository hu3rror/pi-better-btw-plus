<p>
  <img src="https://raw.githubusercontent.com/hu3rror/pi-better-btw-plus/main/banner.png" alt="pi-better-btw-plus" width="1100">
</p>

# pi-better-btw-plus

**English | [简体中文](README.zh-CN.md)**

[![npm version](https://img.shields.io/npm/v/pi-better-btw-plus?style=for-the-badge)](https://www.npmjs.com/package/pi-better-btw-plus)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

Fork the current conversation into a side chat while the main agent keeps working. In the middle of a task, open `/btw`, ask about an API detail or sanity-check an approach, get an answer, close it. The main thread is never interrupted.

## Fork lineage

pi-better-btw-plus is a **maintained fork** of [`@yceachan/pi-better-btw`](https://www.npmjs.com/package/@yceachan/pi-better-btw), which is itself a fork of [nicobailon/pi-side-chat](https://github.com/nicobailon/pi-side-chat). Author chain: **Nico Bailon** → **yceachan** → **hu3rror**. The MIT license keeps all three copyright lines.

The upstream package lives in the [yceachan/ea-pi-extensions](https://github.com/yceachan/ea-pi-extensions) monorepo; this repo is its standalone, actively developed fork.

## Install

```bash
pi install npm:pi-better-btw-plus
```

In pi's TUI, open the side chat with `/btw` (alias `/side`) or `Alt+W`. Ask, press `Enter`, close with `Esc`. Reopening continues the same conversation.

## Highlights

Everything in `@yceachan/pi-better-btw` is here — aside-agent self-cognition, read-only lane enforcement, prompt-pack overrides, `peek_main`, transcript export. This fork adds:

| Feature | What you get |
| --- | --- |
| **Input editor selection** (v1.4.0) | Drag-select inside the input box with a live inverse-video highlight; double-click selects a word, triple-click a whole visual line. `Ctrl+C` / `Ctrl+Shift+C` copy it. |
| **Right-click copy & paste** | Drag-select chat text and right-click to copy — Windows Terminal muscle memory. Right-click inside the input editor pastes the system clipboard through the editor's own paste entry. |
| **Fork model switching** (`Ctrl+L`) | Pick any authenticated model for the side chat without rebuilding the fork. Fork-local: the main session's model is never touched. |
| **Turn-level auto-retry** | Shares pi's `settings.retry` budget. Transient provider errors back off with a live countdown; `Esc` cancels. |
| **`Ctrl+C` clear-input parity** | With nothing selected, `Ctrl+C` clears the input box. A successful copy consumes the selection, so the next `Ctrl+C` returns to clearing. |
| **`Alt+Shift+C` full-draft copy** | Copies the whole draft with paste markers expanded — exactly what a submit would send. Works on terminals without the kitty protocol too. |
| **Feature kill switches** | `features.rightClickCopyPaste` / `modelSwitch` / `retry` / `editorSelection` turn any of the above off per config layer. |

### Input editor selection

The side chat owns the terminal's mouse while open, so the input editor gets real selection support instead of the terminal's:

- **Drag** — select a range with a live inverse-video highlight (~30fps).
- **Double-click** — select the word under the cursor.
- **Triple-click** — select the whole visual line.
- **`Ctrl+C` / `Ctrl+Shift+C`** — copy the chat selection first, then the editor selection, then clear the input. Copying consumes the selection.
- Selections are transient: typing or moving the cursor clears them. They never cross a `[paste #N …]` marker, and they are disabled while the autocomplete popup is open. `features.editorSelection: false` disables the whole surface.

<img src="https://raw.githubusercontent.com/hu3rror/pi-better-btw-plus/main/docs/overlay.png" alt="pi-better-btw-plus overlay" />

## Keybindings

| Key | Action |
| --- | --- |
| `Alt+W` | Open (closed) / background (visible) / restore (hidden) |
| `Enter` | Send |
| `Esc` | Interrupt streaming or cancel a retry backoff; close when idle |
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
| Mouse drag | Select chat text (inverse-video highlight) |
| Double-click (chat) | Select the rendered line |
| Mouse right-click (chat) | Copy the retained selection |
| Mouse right-click (editor) | Paste |

## Commands

- `/btw` — open the side chat; alias `/side` (upstream name kept for compatibility).
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

- The side chat clones the current session into its own agent with the full tool set, rendered in a non-capturing top overlay; the main editor stays visible underneath.
- The fork keeps the main lane's system prompt in the system slot and injects the fork snapshot verbatim, so the side request is a token prefix of the main request — gateway prefix-cache hits.
- Read-only mode (default) is enforced: an out-of-lane tool call is hard-blocked, a second violation escalates and aborts the turn. `peek_main` reads the main session's recent activity on demand.
- While the overlay is open, xterm mouse reporting is enabled and every mouse sequence is consumed: wheel scrolls, drag selects, right-click copies or pastes. Reporting follows overlay visibility — backgrounding (`Alt+W`) hands the mouse back to the terminal.

## Development

pi loads TypeScript directly — there is no build step. Point pi's extension loader at `./srcs/index.ts` and `/reload` after edits.

```text
srcs/
├── index.ts                 # extension entry: commands, shortcut, overlay lifecycle
├── side-chat-overlay.ts     # TUI overlay, agent lifecycle, lane enforcement, mouse routing
├── fork-turn.ts             # turn runner: retry backoff, lane enforcement, phases
├── pointer-gesture.ts       # SGR press/drag/double-/triple-click/right-click classifier
├── editor-selection.ts      # visual-space editor selection: highlight ranges + copy text
├── side-chat-messages.ts    # message rendering, wrapping, selection, scrolling
├── config.ts                # layered config resolution
├── prompt-pack.ts           # prompt-pack loader + template substitution
├── fork-surgery.ts          # shared-prefix fork snapshot surgery
├── overlay-layout.ts        # pure overlay geometry
├── retry.ts                 # turn-level retry engine
├── provider-retry.ts        # pi provider-layer retry injection
├── clipboard-read.ts        # platform clipboard read: native → xclip/wl-copy → OSC 52
├── model-switch.ts          # Ctrl+L model picker
├── shortcuts.ts             # hotkey bindings
└── …                        # status-channel, export, tool-wrapper, file tracker, mouse, write-paths
```

```bash
bun install
bun run typecheck
bun test
```

The package ships `srcs/`, `prompts/`, `config.json`, the docs and `banner.png`; tests stay out of the tarball.

## Limitations

- One side chat at a time; won't open on top of another visible overlay.
- Doesn't merge messages back into the main thread.
- Bash overlap detection is heuristic — catches common write patterns, not all.
- `peek_main` is on-demand, not live.
- Mouse interaction works only in the regular (non-fullscreen) TUI mode.

## License

MIT — see [LICENSE](LICENSE). All three copyright lines are retained: Nico Bailon (upstream), yceachan (intermediate fork), hu3rror (this fork).
