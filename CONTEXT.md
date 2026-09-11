# pi-better-btw-plus

A self-maintained fork of `@yceachan/pi-better-btw` — a side-chat overlay extension
for pi. While the overlay is visible it owns the terminal's mouse input, so conveniences
the main session inherits from Windows Terminal or `AgentSession` (right-click
copy/paste, model switching, auto-retry) must be re-implemented inside the overlay.

## Language

**Fork**:
The side-chat conversation opened via `/side` (alias `/btw`), derived from the main
session's current messages, model, and system prompt. It keeps its own message
history and its own model selection.
_Avoid_: calling the fork a "window" (that's the overlay); calling it a "branch"

**Refork** (Alt+R):
Discard the fork's message history and re-derive it from the main session's current
context. Distinct from clearing (Alt+N), which starts an empty fork.

**Overlay**:
The terminal surface the fork renders on (a bottom band). While visible it enables
xterm mouse reporting (button + motion + SGR) and consumes every mouse sequence,
so terminal-native selection and context menus are unavailable inside it.

**Background** (Alt+W):
Hide the overlay without destroying the fork; releases mouse reporting and restores
the terminal's native selection behavior.

**Turn**:
One user submit through to the agent's finished response. The unit the retry loop
wraps, and the unit out-of-lane escalation can abort.

**Attempt** (尝试):
One agent run (prompt or continue) inside a turn. The unit the retry loop
iterates over; a turn holds several attempts when transient provider errors
retry. The retry countdown ("Retrying 1/3") counts attempts.

**Lane**:
The on-task frame the prompt pack defines for a fork. Out-of-lane attempts trigger
lane reminders (base wording, then escalated), and two violations abort the turn.
_Avoid_: using "lane" as a synonym for the fork conversation itself

**Retry budget**:
The `settings.retry` block (`enabled` / `maxRetries` / `baseDelayMs`) interpreted
as an auto-retry policy for fork turns: transient provider errors retry with
exponential backoff; context overflow and aborts never do.

**Paste marker**:
The `[paste #N +X lines]` / `[paste #N X chars]` placeholder the editor inserts for
large pastes (>10 lines or >1000 chars), expanded back to full text at submit.

**Pointer gesture**:
The overlay's mouse interaction model — press/drag/double-click selection, wheel
scroll, right-click copy and paste. The umbrella term over mouse selection.

**Mouse selection**:
The drag-selection gesture: left-drag anchors a range, double-click selects a
line. One pointer gesture; the selection it leaves is the single source for
hotkey copy (Ctrl+C / Ctrl+Shift+C) and right-click copy.
