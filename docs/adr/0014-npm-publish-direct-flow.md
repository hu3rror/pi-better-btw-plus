# npm publish moves from staged flow to direct flow (supersedes ADR 0003)

ADR 0003 chose the staged flow: CI ran `npm stage publish --provenance` and
the maintainer approved locally with 2FA before the version went live. The
release workflow now uses the direct flow: pushing a `v*` tag triggers CI to
run `npm publish --provenance` via Trusted Publisher (OIDC), publishing
immediately with no human gate.

## Why the change

- The maintainer accepted full automation: a tag push releases immediately,
  no 2FA approve step and no stage-id handover.
- npmjs Trusted Publisher exposes "Allowed actions" as independent
  permissions. The direct flow requires the configuration to allow
  `npm publish`; a stage-only configuration would 403 the CI publish. This
  prerequisite is checked by the maintainer on npmjs.com (agent never does
  it), documented in AGENTS.md.
- Rollback semantics change: `npm stage reject` (pre-publish,
  side-effect-free) is replaced by `npm unpublish <version>` within 72 hours
  (needs local login) and `npm deprecate` beyond that window.

## Unchanged from ADR 0003

- Trusted Publisher / OIDC, zero token, provenance auto-generated.
- `bun install --frozen-lockfile` + `bun run test` + tag↔version check
  (bun deviation from the npm-release template, recorded in 0003, stays).
- First-release exception: a package not on the registry yet cannot use OIDC
  (the Trusted Publisher binding requires an existing package) — the
  maintainer publishes the first version locally, then binds the TP.

## Considered options

- Staged flow (keep 0003) vs direct flow: direct chosen — the maintainer
  accepted full automation. The staged flow remains available in the
  npm-release skill (dual-flow, direct by default) for repos that require a
  human gate.
- Placeholder GitHub Release in the workflow vs agent-created: no placeholder
  — repo convention is categorized release notes by the agent, never CI
  `--generate-notes` placeholders (AGENTS.md Release notes section).
