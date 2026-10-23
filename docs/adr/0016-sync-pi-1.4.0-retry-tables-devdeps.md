# Sync to pi 1.4.0: retry tables re-synced (six wordings + status-code bounds), devDeps bumped, all internal-surface seams re-verified

The host pi moved 1.3.0 → 1.4.0 (mise, 2026-10-22), so this ADR records the
re-verification obligation from ADR 0009 and the sync pattern from ADRs
0010/0011/0013/0015 for the 1.4.0 series. pi 1.4.0 has **no breaking changes
on this extension's import surface** — the SDK typecheck gate exits 0 against
1.4.0 with zero errors, and the full suite (413 tests) passes against 1.4.0.
The only behavior-relevant drift is in pi-ai 1.4.0's `dist/utils/retry.js` /
`dist/utils/overflow.js`, where the transcribed classification tables gained
patterns under Fixed (semantic changes hiding in Fixed, per the sync
checklist). The sync diff is the smallest possible: retry-table entries
transcribed verbatim, devDeps bumped, version stamps refreshed against the
1.4.0 dist.

## Decision

- **`retry.js` mirror gains six provider wordings + one non-retryable wording,
  verbatim** from pi-ai 1.4.0 `dist/utils/retry.js`, verified with a full
  (untruncated) diff of the 1.3.0 and 1.4.0 files:
  - non-retryable: added `"subscription_sharing_workplace_individual_usage_limit_exceeded"`
    (ChatGPT Business admin-set usage limit; only the admin can raise it).
  - retryable: added `"upstream.?request.?failed"`, `"upstream_stream_read_error"`,
    `"stream was interrupted"`, `"http/?2 stream failed"` (#10920 gateway
    `response.failed` error codes), `"request to \\S+ failed, reason:"` (#10996
    node-fetch system errors, e.g. Google ADC OAuth token refresh),
    `"stream disconnected before completion"` (#11057 Codex CLI mid-stream
    disconnects relayed by proxies).
  - retryable: `"429"/"500"/"502"/"503"/"504"/"520"/"524"` replaced with
    `"(?<![a-z0-9])(?:429|500|502|503|504|520|524)(?![a-z0-9])"` — status codes
    must not match inside a longer word or number (#11057, e.g. a request id or
    byte count). This is the one **tightening** (previously-matching texts like
    "4291" no longer classify retryable); all additions are pure supersets of
    the previous match sets.
  **Behavior-affecting**: with a provider reporting these wordings, the fork's
  turn loop now retries (matching the main session, ADR 0013/0015's parity
  rationale); texts with status codes embedded in longer numbers/words now fail
  fast instead of retrying (pi 1.4.0 #11057 parity).
- **`overflow.js` mirror**: pi 1.4.0 removed the bodyless-400/413 pattern from
  `OVERFLOW_PATTERNS`, added the generic
  `/^(?:[\w -]+ API error \(413\):|413(?:\s|:|$))/i` pattern, and gated the
  bodyless-400/413 wording on `provider === "cerebras"` via a separate
  constant. The fork keeps its unconditional bodyless-400/413 match (ADR 0007:
  the fork's `RetryableFailure` carries no `provider` field), and adds the
  generic 413 pattern verbatim. Re-verified outcome-equivalence: a bodyless 400
  is neither overflow nor retryable in pi 1.4.0, so both paths end in
  no-retry; the generic 413 pattern matches exactly what pi 1.4.0 matches
  (overflow wins over retryable wording in both).
- **All internal-surface seams re-verified against the 1.4.0 dist** (the ADR
  0009 upgrade obligation; the fresh numbers live in the source comments):
  - pi-tui `dist/tui.js`, `dist/word-navigation.js`/`.d.ts`, `dist/terminal.js`:
    **byte-identical** to 1.3.0 — the fork's `resolveOverlayLayout` mirror
    (tui.js L836-924, parseSizeValue L81) and the word-navigation deep import
    need no change, only the version stamp (1.4.0).
  - pi-tui `dist/tui-alt-screen.js`: exactly one line removed — the
    `process.platform !== "win32"` gate in `handleRightClickPaste` (right-click
    paste now works on all platforms in pi's own TUI). Not mirrored by the fork
    (the fork implements its own right-click paste path, issue #7, gated by
    `features.rightClickCopyPaste`).
  - pi-tui 1.4.0 `.d.ts` additions (`Terminal.restoreOnExit`,
    `getExitRestorePrefix/Suffix`, private `exitRestoreHandler`) are additive;
    the runtime `tui.js`/`terminal.js` already carried the machinery in 1.3.0
    (the 1.4.0 change is types catching up). The fork uses none of them.
  - pi-ai `dist/compat.js`, `dist/utils/retry.js`/`overflow.js` structure:
    the fork's classifier/loop mirrors the tables and the decision order
    (overflow branch first, then retryable — pi-coding-agent 1.4.0
    `agent-session.js` still classifies overflow before retryable, L2433/3042).
    `runWithRetry`'s backoff formula matches pi 1.4.0's `retryDelayMs`
    (`baseDelayMs * 2^(attempt-1)` capped at `maxAgentDelayMs`,
    `DEFAULT_MAX_AGENT_RETRY_DELAY_MS = 60_000`) — both unchanged.
  - pi-coding-agent `dist/core/sdk.js`: the `injectProviderRetry` `??`-fallback
    chain is unchanged (`buildRequestOptions` L194-203, `streamFn` L261-262).
    1.4.0's `buildRequestOptions` additionally injects
    `identity: getClientIdentity(...)` (L205) and a `transformHeaders` hook;
    neither is part of the retry-key chain the fork mirrors, so the fork does
    not reproduce them. `getRetrySettings()` still applies the 60s
    `maxAgentDelayMs` default (settings-manager L699).
  - pi-coding-agent `dist/core/extensions/runner.d.ts` L134 (the ADR 0009
    prototype patch target): unchanged from 1.3.0.
- **pi-ai `telemetryContext` → `telemetry` rename** (types.d.ts) is a breaking
  SDK change but outside the extension's surface (the fork's stream types do
  not touch the telemetry option). Same for the new `identity?: ClientIdentity`
  options (pi-ai stream options, `AgentOptions.identity`,
  `DEFAULT_AGENT_IDENTITY`): additive; the fork's side-chat `Agent` inherits
  pi's default identity automatically and needs no change.
- **devDependencies bumped** `^1.3.0` → `^1.4.0` for all four
  `@earendil-works/pi-*` packages; `bun run typecheck` is green against 1.4.0
  and the full suite passes (413 tests). Import surface re-verified: top-level
  entries, `pi-ai/compat`, and the deep import
  `pi-tui/dist/word-navigation.js` all resolve against 1.4.0.
- **Version stamps refreshed** across `srcs/` and `test/` (1.3.0 → 1.4.0) and
  READMEs (both languages) pin 1.4.0; the retry.ts header records the
  1.4.0 re-sync alongside the 1.3.0 transcription baseline.

## Considered options

- **Skip the status-code tightening (keep plain "429"/"500"…)** (rejected):
  the fork's table must match pi 1.4.0 verbatim ("照抄语义，不发明私有协议");
  the lookaround bounds are pi's deliberate #11057 fix and are pure
  tightening (no previously-retried legit text loses retry).
- **Import `isContextOverflow`/`isRetryableAssistantError` from pi-ai instead
  of the transcribed tables** (rejected): these exports predate 1.4.0 (present
  in 1.3.0), and the fork's D9 seam keeps the retry engine pi-runtime-free,
  driven by fakes in tests; importing would re-couple the engine to pi-ai's
  `AssistantMessage` shape. The transcription remains the design; this sync
  only re-syncs the tables. (Revisit if the tables drift again.)
- **Adopt `isRecoverableLength` / client identity / `Terminal.restoreOnExit`**
  (not adopted): new 1.4.0 capabilities, none touching a surface the fork
  exercises today — see the sync report's adoption table.
- **Rewrite line-number claims in older ADRs** (rejected): per the convention
  recorded in ADRs 0008/0009/0010/0015, older ADRs are historical records of
  what was verified at decision time; the live source comments carry the fresh
  numbers.

## Consequences

- `test/retry.test.ts` gained the six wordings + the Business-plan wording in
  the retryable/non-retryable fixtures at the `classifyRetryable` seam, plus a
  dedicated #11057 test pinning that status codes embedded in longer
  numbers/words are not retryable while standalone codes still are; the full
  suite stays green (413 pass) and `bun run typecheck` is green against 1.4.0.
- The behavior-affecting items (six wordings now retried; embedded status codes
  now fail fast) are code-inferred; runtime confirmation
  [NEEDS MANUAL VERIFICATION].
- ADRs 0001–0015 remain historical records, untouched.
