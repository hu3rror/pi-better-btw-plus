# Fork 注入 pi provider 层重试：注入复用而非移植/显式调用

侧聊（fork）此前只有 turn 层重试（ADR-0001）：`runWithRetry` 对分类为可重试的
assistant error message 做指数退避重试。但瞬时 provider 429（如 OpenAI 的
`rate_limit_error` + `insufficient_quota` 报文，即 tpm/rpm limit）在 fork 直接
展示最终错误，而主会话对同一报文先在 HTTP 层按 `settings.retry.provider.maxRetries`
（本机 15 次）自动恢复、通常直接成功。行为缺口来自装配层次：主会话的 streamFn 由
sdk.js 包装并注入 provider 设置，而 fork 的 streamFn 是裸的 `streamSimple`。

## 决策

在 fork 的流式装配处（overlay 组装 `agentOptions.streamFn` 的位置）用纯注入 helper
（`srcs/provider-retry.ts` 的 `injectProviderRetry`）把 `settings.retry.provider`
（`timeoutMs` / `maxRetries` / `maxRetryDelayMs`）注入流式 options，注入顺序
`options?.X ?? settings.X`（调用方显式 options 优先），逐行镜像 pi-coding-agent
0.85.1 `dist/core/sdk.js` 的 streamFn 注入链。重试循环本身由 `streamSimple` 内部
pi 自带的 `retryProviderRequest` 执行——429/408/409/5xx 指数退避+抖动，尊重
`Retry-After`，受 `maxRetryDelayMs` 上限约束——在 assistant message 产生之前
生效。未配置 `provider` 块（或无可注入键）时 helper 原样返回原流式函数（恒等），
未配置行为与现状字节级一致、零开销。

两层重试栈与主会话一致，串行执行：

1. **provider 层**（HTTP 请求层，assistant message 之前）——本次注入；
2. **turn 层**（assistant error message 分类层）——ADR-0001 镜像实现，一行不动；
3. 两层耗尽后展示最终错误。

## 为何注入而非移植/显式调用

- **不移植**：`retryProviderRequest` 不是 pi-ai 的公开导出（root/compat 均无），
  深 import `dist/utils/provider-retry.js` 会绑定宿主内部路径、版本脆弱；本地复制
  退避算法会产生与主会话双份漂移的算法（指数退避、抖动、`Retry-After` 解析均随
  上游演进）。
- **不显式调用**：在 fork 内手工实现重试循环会重复 pi 的 SDK/HTTP 层重试语义，
  且与 `streamSimple` 内部的 SDK 层重试叠加、时序难对齐。注入 options 就是把
  `streamSimple` 已经消费的键（`maxRetries` / `maxRetryDelayMs`）交回给它——复用
  pi 的 util，不发明私有重试协议。
- **零开销**：未配置时恒等透传，不引入包装层。

## 为何分类器不动

`retry.ts` 的 `isRetryableAssistantError` 对 `429: {"message":…,"code":
"insufficient_quota"}` 报文与 pi 判一致（不可重试——非重试表的 `insufficient_quota`
先短路；两表字节一致）。即 turn 层分类不是行为偏差点：缺的是它**前面**的 HTTP 层。
provider 层把这类瞬时 429 在到达分类器之前消化掉，因此分类表与镜像保持一字不动，
行为对齐边界在 provider 层；在分类层特判 `rate_limit_error` 属于在 fork 内发明
上游才有的私有协议，超出范围。

## 为何不重开 ADR-0001

ADR-0001 否决的是「用 `settings.retry.provider` 的 per-provider HTTP 重试
*替代* turn 层重试」——那会丢掉主会话在 assistant message 上的语义（溢出/中止
排除、失败消息清理、退避展示）。本次是**并存第一层**：provider 层（HTTP）串行在
turn 层（assistant message 分类）之前，与主会话的两层时序一致；turn 层语义一字
未改。ADR-0001 的结论依然成立，本 ADR 只是补上它未曾覆盖的请求层。

## 已核实事实（实现引用，不再猜测）

- pi 0.85.1 `sdk.js` streamFn 注入链：`maxRetries: options?.maxRetries ??
  providerSettings.maxRetries`，同链含 `timeoutMs` / `maxRetryDelayMs`；provider
  设置来自 `settingsManager.getProviderRetrySettings()`（=`settings.retry.provider`，
  `maxRetryDelayMs` 缺省 60000）。
- `retryProviderRequest` 非 pi-ai 公开导出（root/compat 均无），但在 streamSimple
  内部被各 OpenAI 系 stream 模块使用，消费 `options.maxRetries` /
  `options.maxRetryDelayMs`（0.85.1 运行时与 0.84.2 devDeps 均已核实）。
- `StreamOptions`（含 `SimpleStreamOptions`）公开携带 `timeoutMs` / `maxRetries` /
  `maxRetryDelayMs`（pi-ai 0.84.2 `dist/types.d.ts`）——注入目标类型公开稳定。

## 不做（scope 边界）

- `httpIdleTimeoutMs` / WebSocket 超时接线（只注入三键）。
- provider 层重试与 `features.retry` / `retry.enabled` 的门控（镜像主会话：不读
  这两个开关；D11 开关继续只管 turn 层循环）。
- 分类表任何改动、UI 编辑 `settings.retry`、TUI e2e 自动化测试面。
