# AGENTS.md

pi-better-btw 的 fork（`pi-better-btw-plus`），侧聊 overlay 扩展的开发仓库。上游：`yceachan/ea-pi-extensions`（monorepo 中的 `packages/pi-better-btw`，已通过 subtree split 保留完整历史）。

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues via the `gh` CLI（当前仓库尚未添加 remote，推送后生效）。See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles mapped to GitHub labels, all defaults (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at the repo root + `docs/adr/`. See `docs/agents/domain.md`.

## 开发

- Typecheck: `bun run typecheck`
- Test: `bun run test`
- 包结构：`srcs/`（扩展源码）、`prompts/`（prompt pack 文本）、`config.json`（bundle 默认配置）、`test/`（bun 单元测试）

### Releases

发布走 **Trusted Publisher(OIDC)暂存流**（`.github/workflows/publish.yml`，零 token）：push `v*` tag 触发 CI（bun install --frozen-lockfile → bun run test → tag↔version 校验 → `npm stage publish --provenance`），包进入 npmjs 暂存区并自动生成 provenance。
Agent 负责 bump 版本、commit、打 annotated tag（`git tag -a vX.Y.Z -m "vX.Y.Z"`，需与 package.json version 一致）、push（`git push origin main` + `git push origin refs/tags/vX.Y.Z`，受限操作需当轮授权），然后停下交还。
**发布闸门**：维护者本地 `npm stage approve <stage-id>`（2FA）后才真正发布；stage-id 从 CI 日志的 Stage 步骤取。错误回滚用 `npm stage reject <stage-id>`。`npm publish` 由维护者亲自执行，Agent 不代跑。
同版本重复暂存会被拒（semver 唯一索引），需先 `npm stage reject` 清掉旧暂存或换新版本号。
