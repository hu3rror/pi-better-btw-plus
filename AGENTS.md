# AGENTS.md

pi-better-btw 的 fork（`pi-better-btw-plus`），侧聊 overlay 扩展的开发仓库。上游：`yceachan/ea-pi-extensions`（monorepo 中的 `packages/pi-better-btw`，已通过 subtree split 保留完整历史）。

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues via the `gh` CLI（当前仓库尚未添加 remote，推送后生效）。See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles mapped to GitHub labels, all defaults (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` at the repo root + `docs/adr/`. See `docs/agents/domain.md`.

## 开发

- Typecheck: `bun run typecheck`
- Test: `bun run test`
- 包结构：`srcs/`（扩展源码）、`prompts/`（prompt pack 文本）、`config.json`（bundle 默认配置）、`test/`（bun 单元测试）

### Releases

发布走 **Trusted Publisher(OIDC)直接流**（`.github/workflows/publish.yml`，零 token）：push `v*` tag 触发 CI（bun install --frozen-lockfile → bun run test → tag↔version 校验 → `npm publish --provenance`），**tag push 即发布，全自动，无人工 2FA 闸门**。
Agent 负责 bump 版本、commit、打 annotated tag（`git tag -a vX.Y.Z -m "vX.Y.Z"`，需与 package.json version 一致）、push（`git push origin main` + `git push origin refs/tags/vX.Y.Z`，受限操作需当轮授权）。
**发布闸门**：无——CI 经 OIDC 直接发布；错误回滚用 `npm unpublish <version>`（72 小时内，需本地登录态；超期 `npm deprecate`）。前置：npmjs.com 的 Trusted Publisher Allowed actions 需允许 `npm publish`（只允许 stage 会 403）。
**发布说明**：GitHub Release 由 agent 在发布后撰写——按 Features / Fixes / Docs-Chore 分类整理（`gh release create` 手动建），而不是只留 workflow 的 `--generate-notes` 比较链接；workflow 不自动建 Release。
同版本重复发布会被拒（semver 唯一索引），需换新版本号。
