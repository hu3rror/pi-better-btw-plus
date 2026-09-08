# Fork turns retry themselves instead of using AgentSession

pi's auto-retry lives in `AgentSession`, but this extension drives a bare `Agent`:
`AgentSession` bundles session persistence, compaction, and branch summaries that
the fork neither needs nor can host. The fork's turn loop therefore reimplements
turn-level retry, mirroring pi's classifier (`_isRetryableError` — overloaded /
rate limit / 5xx retry, context overflow and aborts excluded) and its cleanup of
failed assistant messages, so the side chat behaves identically to the main session.

## Considered options

- Reuse `AgentSession` instead of the bare `Agent`: rejected — it pulls in the whole
  session layer and its I/O assumptions; the fork only needs a prompt loop with retry.
- Delegate retry to the provider SDK's own retry settings (`settings.retry.provider`):
  rejected — that path is per-provider HTTP retry and does not match the turn-level
  semantics the main session exposes.
