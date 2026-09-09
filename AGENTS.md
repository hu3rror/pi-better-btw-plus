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

`npm publish` 由维护者亲自执行(涉及 npm 安全验证)。Agent 负责 bump 版本、commit、打 annotated tag、push(`git push origin main` + `git push origin refs/tags/vX.Y.Z`)，然后停下交还;不要代跑 `npm publish`。
