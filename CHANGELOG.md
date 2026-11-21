# Changelog

## [1.7.5] - 2026-11-21

### Features

- Sync to pi 1.6.0: devDependencies bumped to `^1.6.0`; import surface re-verified against the new types.

### Fixes

- Five new retryable provider-failure wordings retry in the side chat: gateway drops surfaced as `Connection closed.`, bare Node socket codes (`ECONNRESET`/`EPIPE`/etc.) and `connection reset by peer`, the Codex WebSocket 60-minute connection limit, and streams `cut short after the reply had begun`.
- Editor-selection helpers return a copy of the rendered lines when no selection is active, adapting to pi-tui 1.6.0's `readonly` render contract.

### Docs-Chore

- Compatibility notes in README pin pi 1.6.0.
- Add ADR 0019 (pi 1.6.0 sync).

## [1.7.4] - 2026-11-04

### Features

- Sync to pi 1.5.0: devDependencies bumped to `^1.5.0`; import surface re-verified against the new types.
- New integration test wires the real classifier into `runWithRetry`.

### Fixes

- Zhipu/Z.ai usage-limit errors (code 1308) no longer retry in the side chat.
- LiteLLM context-overflow failures no longer retry in the side chat.

### Docs-Chore

- Stale pi version stamps removed from comments; retry tables now match pi-ai 1.5.0 order exactly.
- Compatibility notes in README pin pi 1.5.0.
- Add ADR 0018 (pi 1.5.0 sync).
