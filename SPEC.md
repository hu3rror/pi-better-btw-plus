# Spec: side-chat 右键复制/粘贴、模型切换、retry 支持（修订版）

> 状态：ready-for-agent。由 grilling 会话收敛后经 `/skill:to-spec` 重写，同步于 issue #1，取代初版 SPEC.md。术语与决策以 `CONTEXT.md`、`docs/adr/0001`、`docs/adr/0002` 为准。

## Problem Statement

pi-better-btw（侧聊 overlay 扩展）在 Windows Terminal 下有三个痛点：

1. **右键无法复制/粘贴**：侧聊打开期间，鼠标选中文字后右键无法复制；输入框右键也无法粘贴。终端原生选择/右键菜单在 overlay 可见期间被完全禁用。
2. **无法手动选择其他 model**：侧聊固定使用主会话的模型，没有切换入口。
3. **不支持 pi 设置中的 retry 机制**：pi 的 `settings.retry`（瞬时错误自动重试，默认 3 次、指数退避）在主会话生效，但侧聊完全不生效，瞬时错误直接显示错误结束。

## Solution

- 侧聊 overlay 内部实现完整的右键语义（与 Windows Terminal 惯例一致），且粘贴体验与 pi 官方主编辑器对齐：聊天区有选区时右键 = 复制选区；输入框右键 = 从系统剪贴板粘贴文本到光标处，大段粘贴折叠为 `[paste #N +X lines]` 标记、提交时展开，与主会话行为一致。
- 侧聊内新增模型选择器（Alt+M 键盘驱动），切换只作用于 fork 自身（fork-local），切换后继续当前对话。
- 侧聊的 turn 循环接入与 pi 主会话一致的自动重试：读 `settings.retry` 预算，对可重试的瞬时 provider 错误指数退避自动重试，并在界面显示重试状态。

## User Stories

1. 作为侧聊用户，我想在侧聊消息区用鼠标拖拽选中文字后右键即可复制，以便沿用 Windows Terminal 的肌肉记忆，而不必改用 Ctrl+C 热键。
2. 作为侧聊用户，我想右键复制后选区保持高亮并可再次复制，以便连续复制不同片段时行为与热键复制一致。
3. 作为侧聊用户，我想在侧聊输入框内右键即可粘贴剪贴板文本，以便快速粘贴外部内容。
4. 作为侧聊用户，我想右键粘贴多行/代码块时获得与主会话编辑器一致的体验——大段内容折叠为 `[paste #N +X lines]` 标记、提交时展开为完整文本，小段内容直接插入，换行/制表符按 pi 官方规则归一化（`\r`→`\n`、`\t`→4 空格），以便粘贴代码块不被破坏。
5. 作为侧聊用户，我想剪贴板读取失败（平台通道与 OSC 52 回退均不可用）时粘贴静默降级并提示，以便不崩溃、不静默吞掉点击。
6. 作为侧聊用户，我想在没有选区时右键聊天区不产生任何副作用，以便误触右键不会复制错误内容。
7. 作为侧聊用户，我想按 Alt+M 打开模型选择列表，以便手动选择对话使用的模型。
8. 作为侧聊用户，我想模型列表只显示当前会话可用（scoped）且已配置认证的模型，以便不会选到必然失败的模型。
9. 作为侧聊用户，我想切换到无 reasoning 能力的模型时 thinking level 自动钳制（`"off"` 映射为不请求 reasoning），以便不出现非法请求。
10. 作为侧聊用户，我想切换模型后继续原对话上下文，以便不用重开侧聊。
11. 作为侧聊用户，我想背景化（Alt+W）再恢复后仍保留 fork 选择的模型，以便不用重新选择。
12. 作为侧聊用户，我想 refork（Alt+R）/ clear（Alt+N）后模型选择重置回主会话模型，以便显式重建 lane 时语义可预期。
13. 作为侧聊用户，我想在流式（agent 响应中）期间打开模型选择器被拒绝，以便不会在响应中途更换模型导致状态混乱。
14. 作为侧聊用户，我想侧聊头部/提示栏显示当前模型，以便知道正在和哪个模型对话。
15. 作为侧聊用户，我想在瞬时 provider 错误（overloaded / rate limit / 5xx）时侧聊自动重试，以便与主会话行为一致。
16. 作为侧聊用户，我想重试时看到退避倒计时状态，以便知道正在自动重试而不是卡死。
17. 作为侧聊用户，我想重试次数耗尽后仍显示最终错误，以便知道确实失败了。
18. 作为侧聊用户，我想按 Esc 取消进行中的重试等待，并立即看到最后一次错误作为最终结果，以便不想等时可以马上停止、不悬挂在中间态。
19. 作为侧聊用户，我想重试遵守 `settings.retry` 的 `enabled/maxRetries/baseDelayMs` 配置，以便不重试时（如本地模型调试）不产生意外延迟。
20. 作为侧聊用户，我想上下文溢出类错误不触发重试，以便不会无意义地重复失败请求。
21. 作为侧聊用户，我想背景化（Alt+W）侧聊后终端原生选择/右键行为恢复，以便需要时仍能用终端原生的方式操作主界面。

## Implementation Decisions

- **D1（鼠标捕获模型不变）**：overlay 可见期间维持现有的 xterm 鼠标上报（button + motion + SGR）。终端逃逸序列不支持按区域开/关鼠标模式，因此不做区域化 passthrough；右键在 overlay 内部成为应用层动作，而不是试图转发给终端。背景化（Alt+W）保持为恢复终端原生行为的出口。
- **D2（右键语义）**：在现有鼠标事件处理中增加右键（button 2）分支，按命中区域决策：聊天消息区 + 存在拖拽选区 → 复制选区（复用现有复制到剪贴板 + 状态提示逻辑，选区保持高亮）；输入编辑器区 → 粘贴；其它区域（边框/头部）→ 忽略。释放右键时执行动作，避免按下即触发。右键命中决策不拆纯函数，直接在 overlay 鼠标事件层实现并以外部行为测试覆盖。
- **D3（剪贴板读取）**：新增自包含的剪贴板读取 helper，平台通道以**注入函数**传入：win32 → 优先 `@mariozechner/clipboard` native addon 的 `getText`（pi 自身读剪贴板用的同一 addon，亚毫秒且不阻塞事件循环），回退 `Get-Clipboard -Raw`（与 pi 自身读剪贴板图片的 PowerShell 通道一致），再回退 OSC 52 query；darwin → native addon → `pbpaste` → OSC 52；linux → OSC 52 query（`\x1b]52;c;?\x07`，读响应）。平台通道失败时逐级回退，全部不可用时返回 null，由调用方静默降级并提示。写剪贴板沿用 `copyToClipboard`（公开导出）。
- **D4（编辑器粘贴）**：粘贴**走 pi-tui Editor 内置的粘贴入口**，不手写归一化：Editor 自带大段折叠（>10 行或 >1000 字符 → `[paste #N +X lines]` / `[paste #N X chars]` 标记，提交时展开）、`normalizeText`（`\r`→`\n`、`\t`→4 空格）、原子 undo 快照与 onChange。submit 路径必须用展开后的文本（`getExpandedText` 语义）发给 agent，避免把标记原文发给模型。
- **D5（模型切换机制，已验证）**：保持 fork 自己的 transcript 不变，运行时替换 agent 的当前模型——`agent.state.model` 与 `agent.state.thinkingLevel` 均在每次 turn 构建配置快照时重读（pi-agent-core 已核实），无需重建 agent。切换后按新模型能力钳制 thinking level（`"off"` 映射为 `reasoning: undefined`），照抄主会话 `setThinkingLevel` 的 clamp 语义。主会话的模型接口不动——侧聊模型选择只影响 fork 自身（ADR 0002）。
- **D6（模型列表来源）**：优先使用会话作用域模型集（scoped models），为空（未配置 scoping）时回退到可用模型目录；**过滤**掉未配置认证的模型（"只显示"，而非置灰）。
- **D7（模型选择 UI）**：选择器渲染在 overlay 内部（模态列表模式），不用宿主的选择对话框——宿主在 overlay 已打开时拒绝第二个 overlay。Alt+M 打开，上下选择、回车确认、Esc 取消，复用现有列表主题。**流式期间拒绝打开**。选择为 overlay 实例级状态：Alt+W 背景化保留；refork（Alt+R）/ clear（Alt+N）/ Esc-close 后随实例销毁重置回主会话模型。
- **D8（retry 预算读取）**：扩展已从同一 agent 配置目录读取分层用户配置；新增从共享 settings 文件读 `retry` 块（`enabled` / `maxRetries` / `baseDelayMs`），默认值与 pi 一致（enabled=true, maxRetries=3, baseDelayMs=2000）。
- **D9（重试循环）**：turn 提交处包一层**注入式重试循环**（新 seam，拆在循环最高点）：错误分类器照抄 pi 的 `_isRetryableError` 语义（overloaded / rate limit / 5xx 可重试，缺失 status 按 pi 实际匹配，abort 与上下文溢出排除），不发明私有协议；按 `baseDelayMs * 2^(n-1)` 退避，期间显示 "Retrying (attempt n)…" 倒计时并可被 Esc 取消——**取消 = 立即展示最后一次错误作为最终结果**（与预算耗尽同构）；预算耗尽后展示最终错误。重试前对失败 assistant 消息的清理照抄主会话的 `_findLastAssistantMessage`/`_replaceMessageInPlace` 语义（不把错误消息重复送入下一次请求）。
- **D10（UI 呈现）**：头部状态区显示当前模型；提示栏新增绑定提示（Alt+M 选模型、右键复制/粘贴说明）；重试退避倒计时显示在状态区。
- **D11（可配置性）**：右键复制/粘贴、模型切换、retry 均可通过扩展分层配置开关（bundle/user/project）控制，默认开启，避免破坏既有用户行为；行为变更写入文档。
- **D12（交付形态）**：自维护 fork，不做上游 PR（扩展自行管理）。仓库已接线：origin=`hu3rror/pi-better-btw-plus`，本 spec 同步于 issue #1（`ready-for-agent`），五个 triage 标签就位。
- **D13（测试基线债）**：修复既有 4 个失败用例（Windows 上 `copyToClipboard` 走 native clipboard、OSC 52 stdout 捕获断言失效）——用 mock 替换剪贴板写侧而非按平台 skip。探针已验证可行，模式为 bun `mock.module` 局部覆盖（prototype 产物，编码了精确决策）：

```ts
mock.module("@earendil-works/pi-coding-agent", () => ({
  ...RealPi,
  copyToClipboard: (text: string) => { /* 捕获文本，返回 true */ },
}));
```

`copyToClipboard` 实际导出自 `@earendil-works/pi-coding-agent`（非 pi-tui）；spread 保留其余导出（`SideChatOverlay`、`getSelectListTheme` 等不受影响），静态导入即生效。该 mock 同时服务新增的右键复制断言。

## Testing Decisions

- **测试原则**：只测外部行为，不测实现细节；纯函数逻辑优先拆出纯函数 seam，SGR 端到端与 TUI 交互走手动验证。seam 划分已与用户确认：少而粗，每个功能一个纯模块 seam + 复用现有 overlay 集成层与 config 解析层。
- **测试模块与 seam**：
  - **剪贴板读取 helper**（平台通道注入）——单测：mock 平台通道失败 → 回退 → 返回 null；成功路径返回文本（prior art：`config.test.ts` 的临时目录树注入模式）。
  - **模型模块**（`buildModelChoices(scoped, available, hasAuth)` 列表构建 + 认证过滤；`clampThinkingLevel(model, current)` 按新模型能力钳制，含 `"off"`）——纯函数单测（prior art：`side-chat-mouse.ts` 的 SGR 分类器测试）。
  - **retry 模块**（`classifyRetryable(error)` 分类表照抄 pi；`runWithRetry({ attempt, classify, delay, signal, onAttempt })` 循环，attempt 注入 + 假时钟）——单测：连续失败 N 次、退避序列、预算耗尽、Esc 取消竞态（prior art：纯分类器测试）。
  - **overlay 集成层**（直接驱动 `handleMouseEvent`/`handleInput`，prior art：`select.test.ts` 的 overlay 套件）——右键命中三类结果（有选区复制 / 输入区粘贴 / 其它忽略、无选区无副作用）、复制后选区保留、Alt+M 选择后 `agent.state.model` 更新 + thinking 钳制、流式拒绝打开、粘贴后编辑器文本含粘贴内容（大段为标记）。
  - **配置解析新增字段**——并入现有 `config.test.ts`（prior art：分层解析测试），三开关默认值 + 分层覆盖。
- **测试基线债**：4 个失败用例按 D13 的 mock 模式修复，OSC 52 stdout 捕获作废。
- **手动验证（Windows Terminal + 本机 pi 0.85.1）**：侧聊内拖选→右键复制→系统剪贴板内容正确且选区保留；输入框右键粘贴多行/大段内容出现 `[paste #N +X lines]` 标记、提交后 agent 收到完整文本；右键点击无选区聊天区/头部无副作用；Alt+M 列表选择/取消、流式期间打不开；切换无 reasoning 模型后 thinking 被钳制；对本地不可达端点触发瞬时错误观察自动重试、倒计时与 Esc 取消；Alt+W 背景化后主界面原生选择恢复、恢复后模型选择保留。

## Out of Scope

- overlay 可见期间主区域（overlay 之外）的终端原生选择恢复——鼠标上报按区域开启在终端协议层面不可行，属于固有取舍。
- 右键粘贴图片——仅文本。
- 侧聊模型选择同步到主会话（ADR 0002：fork-local 是刻意边界）。
- 提供 UI 编辑 `settings.retry`——只读遵循 pi 的配置。
- 侧聊的自动压缩（compaction）或其它 AgentSession 层能力——本 spec 只补 retry。
- TUI 端到端自动化测试——维持手动验证，不新增 e2e 测试面。

## Further Notes

- **交付形态**：自维护 fork（Q1 确认，不做上游 PR）。实现顺序：基线债 → 鼠标右键 → 模型切换 → retry，每功能一个 commit。
- **已核实事实**（实现引用，不再猜测）：
  - `agent.state.thinkingLevel` 与 `agent.state.model` 一样每次 turn 重读（pi-agent-core `agent.js:291-292` 构建配置快照、`agent-loop.js:93-101` 消费；`types.d.ts:293-296` 注释 "Requested reasoning level for future turns"）；`"off"` → `reasoning: undefined`。
  - pi-tui `Editor` 内置粘贴折叠（>10 行 / >1000 字符）、`normalizeText`（`\r`→`\n`、`\t`→4 空格）、undo 快照；粘贴入口方法名实现时精确定位。
  - `copyToClipboard` 导出自 `@earendil-works/pi-coding-agent`；`readClipboardText` 未公开导出，读侧自研（D3）。
  - `AgentSession._isRetryableError`（overloaded / rate limit / server errors，context overflow 排除）与 `settings.retry` 结构（`enabled`/`maxRetries`/`baseDelayMs`）均在 pi 0.85.1 中确认存在。
  - bun 1.4.2 `mock.module` 局部覆盖模式（D13 原型）实测通过。
- 术语与决策记录：`CONTEXT.md`（fork/refork、overlay、background、turn、lane、retry budget、paste marker、mouse selection）、`docs/adr/0001-turn-level-retry-in-fork.md`、`docs/adr/0002-fork-local-model-selection.md`。
