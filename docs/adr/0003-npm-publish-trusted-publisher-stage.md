# npm 发布走 Trusted Publisher 暂存流(CI 暂存,维护者 2FA approve)

发布链路定为 `.github/workflows/publish.yml`(tag `v*` push 触发):bun install
→ bun run test → tag↔version 校验 → `npm stage publish --provenance`,包进入
npmjs 暂存区;真正发布由维护者本地 `npm stage approve <stage-id>`(2FA)执行,
错误回滚用 `npm stage reject <stage-id>`。workflow 内零 token(Trusted
Publishing / OIDC,`id-token: write`),provenance 由 npm 自动签名写入
sigstore transparency log。前置条件(摸底确认):包已存在于 registry、仓库
public、npm 账号已开 2FA。

## 对 upstream npm-release 模板的两处偏离(记录,避免下一位 reader 误判)

1. **依赖安装与测试用 bun 而非 npm**。模板定制点写"有 package-lock.json 用
   `npm ci`,无则 `npm install`";本项目无 package-lock.json(有 bun.lock),
   `npm ci` 会直接失败,而 `npm install` 会生成与 bun 生态不一致的依赖树。
   项目事实标准是 bun(`bun run test` / `bun run typecheck` 均为 AGENTS.md 文档
   命令),故 CI 用 `oven-sh/setup-bun` + `bun install --frozen-lockfile` +
   `bun run test`。stage 打包只按 `files` 字段,与依赖安装方式无关。
2. **CONTEXT.md 不补发布流词条**。模板步骤 7 要求"有 CONTEXT.md 等领域文档时
   补发布流词条";CONTEXT.md 定位为领域术语表(Language 段),发布流不是领域
   词汇,塞入会污染词汇表。该决策改以本 ADR 沉淀——决策记录归决策记录,
   术语表归术语表。

## Considered options

- 直接流(B,`npm publish` 全自动)vs 暂存流(A):选 A——AGENTS.md 既有约定
  "`npm publish` 由维护者亲自执行",且 A 流把 OIDC 仓库所有权与 2FA 双闸门
  结合,误暂存可 `npm stage reject` 回滚。
- `npm ci` / `npm install` vs `bun install --frozen-lockfile`:选 bun——见偏离 1。
- CONTEXT.md 词条 vs ADR 记录:选 ADR——见偏离 2。
