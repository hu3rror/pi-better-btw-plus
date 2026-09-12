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

---

# Spec: 抽取 PointerGesture 指针手势状态机模块

> 状态：ready-for-agent。同步于 issue #12（grilling 收敛 → `/skill:to-spec`）。正文以 issue #12 为准，此处留档。术语以 `CONTEXT.md` 为准（新增 **pointer gesture** 伞形词，**mouse selection** 收敛为子概念）；不重开 ADR-0001 / ADR-0002。

## Problem Statement

侧聊 overlay 的指针手势识别（press/drag/双击/右键）是一台约 200 行的状态机，但被焊死在 1513 行的 `SideChatOverlay` 类里：9 个状态字段散落在字段列表中，双击判定、手抖容差、30fps 拖拽节流等语义被内联在 `handleMouseEvent` 的事件分支里。手势语义没有名字，接口 ≈ 实现复杂度。后果：测试成本高（`select.test.ts` 535 行，必须 mock 整个 TUI + 偷窥私有状态）、bug 修复点分散（双击分类两周内修过两次：`7e65ac4`、`bf6ac68`）、`index.ts` 内联位运算与 `isLeftPress()` 重复。

## Solution

把指针手势识别抽成独立的深模块 `pointer-gesture.ts`：模块消费原始 `SgrMouseEvent`（复用 `side-chat-mouse.ts` 分类函数），产出 `GestureAction[]` 动作对象；overlay 只保留「动作 → 渲染」翻译层；`index.ts` 内联聚焦判定替换为 `isLeftPress()`。外部行为零变化。

## 关键决策（详见 issue #12）

- **D1 模块形态**：动作对象类 `onEvent(e): GestureAction[]` / `isDragging()` / `cancel()`，单一依赖方向，模块零 TUI/剪贴板/编辑器知识。
- **D2 动作集合**：`select`（含 `paint` 节流标志）/ `selectLine`（只带行号，列界由 overlay 补）/ `scroll` / `copy` / `paste`；copy 不携带选区文本（单一来源在 `SideChatMessages`）。
- **D3 语义边界**：32ms 拖拽节流与滚轮步长进模块；双击窗口 500ms / 手抖容差（同行 ≤2 列）模块内常量；按下聚焦留 index.ts 路由层（只去重 `isLeftPress()`）。
- **D4 hit 查询**：注入 `chatAt` / `clampToChat` / `overEditor` / `hasSelection` / `getSelectionAnchor` 五查询，0-based 坐标契约，SGR 1-based→0-based 转换在模块内。`getSelectionAnchor` 是硬约束：anchor 权威副本在 `SideChatMessages`（窗口平移同步移动）。
- **D5 D11 门控**：`rightClickEnabled` 模块选项，关闭时右键 press 不记区域、release 不产动作。
- **D6 翻译层**：overlay 私有 `applyGestureAction()`；模型选择器打开时的事件忽略 gate 留 overlay 层。
- **D7 公开契约**：`handleMouseEvent` / `isMouseDragging` / `cancelMouseDrag` / `getViewport` 签名不变，内部委托模块。
- **D8 依赖方向**：import `side-chat-mouse.ts` 分类函数 + `side-chat-messages.ts` 的 `CellPos` 类型（无循环）。

## 测试决策（详见 issue #12）

- 唯一新接缝：`test/pointer-gesture.test.ts`——喂 SGR 序列断言动作序列（双击窗口/手抖容差/跨行拖/clamp/跨区松手/D11 门控/cancel/拖拽中杂散右键/右键后滚轮）。
- `select.test.ts` 瘦身留 4 个 overlay 层测试，其余 19 个手势测试删除（场景被模块单测覆盖）；`paste.test.ts` 与 `SideChatMessages` 段 6 个测试原样保留。
- 抽取顺序：原样搬移（旧套件全绿作行为基线）→ index.ts 去重 → 新模块单测跑绿 → 瘦身。全程 `bun run typecheck` + `bun run test` 全绿。

## Out of Scope

- 修改 `SideChatMessages` 接口/内部；修改 index.ts 鼠标路由结构（只 1 行去重）；LayoutSpec（候选 3）、ForkTurnRunner / StatusChannel（候选 1/4）；新指针设备支持；TUI e2e 测试面；模型选择器与 retry 行为改动。

## Further Notes

- 实施顺序：抽取 → index.ts 去重 → `pointer-gesture.test.ts` → 瘦身 `select.test.ts`，每步一个 commit。
- 术语已沉淀：CONTEXT.md 新增 **Pointer gesture**（伞形词），**Mouse selection** 收敛为子概念。
- 不重开 ADR：与 ADR-0001 / ADR-0002 无交集。

---

# Spec: 抽取 Write-Paths 写路径提取模块

> 状态：已实施（候选 5 深化，grilling Q1–Q4 收敛，无对应 issue）。术语以 `CONTEXT.md` 为准（新增 **File overlap**）；不重开 ADR-0001 / ADR-0002 / ADR-0004。

## Problem Statement

`tool-wrapper.ts` 同时承担两件事：给 full lane 工具套 **File overlap** 确认包装，以及手写 shell 分词器解析 bash 命令提取写路径。解析器是一个小型语言解析器却埋在包装模块内，且**零测试**——fd 重定向 `N>&M` 族同时造成漏报与误报（`cp a b 2>&1 | tee log` 误报 `["2","log"]` 且漏掉真实目标 `b`）；`sed -i` / `perl -pi` / `awk -i inplace` 等就地写命令完全不识别（known limitation）。`extractWritePaths` 已有两个调用方（overlap 包装 + `index.ts` 写跟踪）却长在错误的模块里。

## Solution

新建 `srcs/write-paths.ts`：`extractWritePaths`（write/edit/bash 分发）与 bash 分词/路径提取整体迁入，bash 辅助函数全部内部化；`tool-wrapper.ts` 回归只做包装拦截。词法级修复 fd 重定向族：`N>&M` / `&>` / `&>>` 识别为单一构造，fd 数字不进入 operand、目标不被误报。外部行为除该修复族外零变化。

## 关键决策（grilling Q1–Q4）

- **Q1 契约**：修复 `N>&M` fd 重定向族（语法级 bug），测试覆盖 `2>&1`、`1>&2`、`&> file`、`&>>`、`2>f`；`sed -i` 等就地写为 Known Limitation，模块头注释留档 + 独立 issue 进 Backlog（网络阻塞待建）。
- **Q2 模块边界**：选项 B——`extractWritePaths` 整块搬到 `write-paths.ts`，模块即 `write-paths.ts` 这个名字；`tool-wrapper.ts` 仅保留包装拦截职责；`index.ts` import 改指新模块。
- **Q3 测试形状**：选项 A——纯黑盒契约表，只测公共 API，不导出 `tokenizeShell`；table-driven 断言，重构韧性优先。
- **Q4 术语**：CONTEXT.md 新增 **File overlap**（主 session 已写文件集合；full lane 写入命中先经确认；read-only lane 靠 strip 哲学不触达）。不立 ADR。

## 实现要点（已落实）

- 分词器 op 集合扩展：`>` `>>` `&>` `&>>` `>&` `|` `||` `&` `&&` `;`；三字符 `&>>` 分支先于两字符 map（`TWO_CHAR_OPS` 只含两字符 op）。
- 两套 op 角色集：`REDIRECT_PUSH`（`>`/`>>`/`&>`/`&>>` 推目标为写路径）与 `CONSUME_NEXT`（`>&` 只消费目标不推——fd dup 非路径）。
- operand 收集跳过「重定向前导数字 fd」（`/^\d+$/` 且下一 token 为重定向 op），`mv 2>&1 dst` 不再把 `2`/`1` 当 cmd 参数或目标。
- 契约表 34 例：修复前 `cp a b 2>&1 | tee log` → `["2","log"]`，修复后 → `["b","log"]`。

## 测试决策

- 新接缝 `test/write-paths.test.ts`：34 条黑盒契约（重定向 / fd 族 / 引号 / 分隔符 / 命令特判 tee-touch-rm-cp-mv / 忽略项 `/dev/*`、flags / write-edit-read 工具），纯公共 API，红→绿落码。
- 验证：`bun run typecheck` exit 0；`bun run test` 249 pass（原 215 + 34，0 fail）。

## Out of Scope

- `sed -i` / `perl -pi` / `awk -i inplace` 就地写识别（known limitation → 独立 backlog issue，含验收：`sed -i` 返回目标、`sed -n` 只读形态返回空）。
- 替换手写分词器为完整 shell 解析器；`<` 输入重定向 / heredoc 展开 / Windows 路径形态。
- 候选 1/2/3/4（ForkTurnRunner、PointerGesture、LayoutSpec、StatusChannel）——各自独立落地，与此节无交集。

## Further Notes

- 实施顺序：契约测试先红（模块缺失）→ 模块落码（搬迁 + fd 修复）→ tool-wrapper 瘦身（-186 行）→ index.ts import 改指 → 全绿。

---

# Spec: fork 注入 pi provider 层重试（settings.retry.provider）

> 状态：ready-for-agent。同步于 issue #20。由诊断会话（429 `insufficient_quota` 误判调查）经 grilling 收敛后落盘。术语与决策以 `CONTEXT.md`、`docs/adr/0001` 为准；实施时新开 `docs/adr/0005`。

## Problem Statement

侧聊（fork）遇到瞬时 provider 429 时直接报错，而 pi 主会话会先重试。

手动复现：请求触发 `[Error]: 429: {"message":"inference exceeds tpm/rpm limit","type":"rate_limit_error","code":"insufficient_quota"}` 后，fork 直接显示最终错误；同一请求在主会话按 `settings.retry.provider.maxRetries`（本机 15 次）在 HTTP 层先重试，通常直接成功，错误根本不出现。

## Solution

fork 的 turn 装配补上与 pi 主会话一致的 **provider 层重试**：读取 `settings.retry.provider`（`timeoutMs` / `maxRetries` / `maxRetryDelayMs`），注入到 fork agent 的流式装配，使 `streamSimple` 内部 pi 自带的 HTTP 重试（`retryProviderRequest`：429/408/409/5xx 指数退避+抖动，尊重 `Retry-After`，受 `maxRetryDelayMs` 上限约束）在 assistant message 产生之前生效。两层层级与主会话一致：provider 层（HTTP 请求层）→ turn 层（assistant error message 分类层，fork 已镜像实现、**一行不动**）。

## User Stories

1. 作为侧聊用户，我想 fork 遇到瞬时 provider 429（如 tpm/rpm limit）时先在 HTTP 层自动重试，以便与主会话行为一致，而不是直接看到最终错误。
2. 作为侧聊用户，我想 fork 的重试遵守 `settings.retry.provider.maxRetries`，以便限流窗口内能自动恢复。
3. 作为侧聊用户，我想 fork 的重试遵守 `settings.retry.provider.maxRetryDelayMs`，以便服务器要求的超长退避不超过我的上限（默认 60s）。
4. 作为侧聊用户，我想 fork 尊重服务器 `Retry-After` 指示，以便不过度请求、退避节奏与服务端一致。
5. 作为侧聊用户，我想 fork 未配置 `settings.retry.provider` 时行为与现状完全一致（零开销、单次请求），以便不配置的用户无感知。
6. 作为侧聊用户，我想 fork 的 turn 层重试语义保持现状（`enabled/maxRetries/baseDelayMs` 与分类表不变），以便已有重试行为不被破坏。
7. 作为侧聊用户，我想 `features.retry` 开关继续只管 turn 层循环，以便与主会话的 provider 层行为（不读该开关）保持一致。
8. 作为侧聊用户，我想调用方（fork 自身/未来其它装配者）显式传入的 `maxRetries`/`maxRetryDelayMs`/`timeoutMs` 优先于 settings，以便不覆盖更具体的调用方意图。
9. 作为侧聊用户，我想 `insufficient_quota` 出现在 `rate_limit_error` 报文里的 429 由 HTTP 层重试消化，以便不被计费式误判直接终结（分类器不动）。
10. 作为维护者，我想 fork 的重试栈与 pi 主会话一致（provider 层在前、turn 层在后），以便侧聊与主会话的故障恢复行为可预期对齐。
11. 作为维护者，我想实现不 deep-import pi 内部模块、不本地移植重试算法，以便不绑定宿主内部路径、不产生双份退避算法漂移。
12. 作为维护者，我想术语区分两层重试（Retry budget= turn 层 / Provider retry = HTTP 层），以便文档与讨论无歧义。

## Implementation Decisions

- **D1（复用机制 = 注入，非移植非显式调用）**：新增一个纯装配 helper，对 fork 的流式函数做 options 注入：`{ ...options, timeoutMs, maxRetries, maxRetryDelayMs }`（缺省键回退 `options?.X ?? settings.X`）。重试循环并不由该 helper 实现——`streamSimple` 内部已用 pi 的 `retryProviderRequest` 包住 SDK 调用并消费 `options.maxRetries` / `options.maxRetryDelayMs`（0.85.1 运行时与 0.84.2 devDeps 均已核实），因此注入即是复用 pi 的 util。不 deep import `@earendil-works/pi-ai/dist/utils/provider-retry.js`（非公开导出，版本脆弱），不本地移植退避算法。装配位置即今日 `streamFn` 直连 `streamSimple` 之处（overlay 组装 agent options 处）。
- **D2（注入键范围）**：`timeoutMs` + `maxRetries` + `maxRetryDelayMs` 三键全部注入（镜像 pi-coding-agent `sdk.js` 的 streamFn 注入链）。`httpIdleTimeoutMs`（另一 settings 键）不纳入。
- **D3（零开销恒等）**：`provider` 块缺失/无可注入键时，helper 原样返回原流式函数（恒等），未配置行为与现状字节级一致。
- **D4（配置管道）**：`RetryPolicy` 增加可选 `provider?: { timeoutMs?; maxRetries?; maxRetryDelayMs? }` 块，`loadRetryPolicy` 在既有 global+project `settings.retry` 合并结果上提取（缺失键落空，与 pi `getProviderRetrySettings` 同源同语义）。加载侧不默认 `maxRetryDelayMs`——pi-ai 内部对缺省值有 60000 兜底，行为一致。turn 层循环（`runWithRetry`）只读 `enabled/maxRetries/baseDelayMs`，`provider` 块仅由 overlay 的流式装配消费。
- **D5（门控）**：provider 层重试不与 `features.retry`、`settings.retry.enabled` 门控——逐行镜像 pi 主会话（其 provider 层不读这两个开关）。D11 开关继续只管扩展自研的 turn 层循环。
- **D6（分类器一行不动）**：`retry.ts` 分类表与 `isRetryableAssistantError` 镜像保持。已核实 pi 自身对该报文同样判不可重试（两表字节一致），因此 provider 层是行为对齐边界，不在分类层引入偏离。
- **D7（时序）**：provider 层（HTTP 请求层，assistant message 之前）→ 耗尽后进入 turn 层（分类 assistant error message）→ 耗尽后展示最终错误。两层串行，与主会话一致。
- **D8（文档）**：`CONTEXT.md` 词条更新——**Retry budget** 收窄为 turn 层（`enabled/maxRetries/baseDelayMs`），新增 **Provider retry** 词条（`settings.retry.provider`：HTTP 请求层重试 429/408/409/5xx，尊重 Retry-After，指数退避+抖动，在 assistant message 产生前执行）。新开 **ADR-0005**：两层重试栈、为何注入而非移植/显式调用、为何分类器不动、为何不重开 ADR-0001（其否决的是「用 provider retry *替代* turn 层」，非「并存第一层」）。

## Testing Decisions

- **测试原则**：只测外部行为与装配契约，不断言 pi-ai 内部行为（避免版本耦合）。本 bug 的调用点是 overlay 组装 `agentOptions.streamFn`——最高可测 seam 即 overlay 的 `runnerFactory` 捕获 seam。
- **核心 seam（1 个）**：overlay 装配 seam——经 `runnerFactory` 捕获 `runnerOptions`，断言：配置 `provider` 块时 `agentOptions.streamFn` 不再是裸流式函数（被包装）；未配置时是原样流式函数（恒等）。此断言在现状代码上红。
- **新单元 seam**：注入 helper 的 options 语义——缺省键被注入、调用方显式 options 优先、其余键透传、返回值透传、无配置恒等。prior art：`retry.test.ts` 的注入式假 agent / 假时钟。
- **既有 seam 复用**：配置解析 seam——`provider` 块提取、global+project 深合并、缺失键落空。prior art：`config.test.ts` 的临时目录树注入模式。
- **不做**：真实 429 端到端（无打点，成本不成比例）；0.84.2 `streamSimple` 内部行为断言。端到端回归由用户本机手动复现（`provider.maxRetries=15` 已配）。

## Out of Scope

- 分类器改动（`retry.ts` 镜像保持，一行不动）。
- `httpIdleTimeoutMs` / WebSocket 超时接线。
- provider 层重试与 `features.retry` / `retry.enabled` 的门控语义变更（按 D5 不门控）。
- UI 编辑 `settings.retry`（只读遵循 pi 的配置，沿用既有结论）。
- compaction 或其它 AgentSession 层能力。
- TUI e2e 自动化测试面。
- 对「`rate_limit_error` 类型 + `insufficient_quota` 码」的 turn 层分类器特判（属于 pi-ai 上游语义，不在 fork 内发明私有协议）。

## Further Notes

- **已核实事实（实现引用，不再猜测）**：
  - pi 0.85.1 `sdk.js` 的 streamFn wrapper 注入链：`maxRetries: options?.maxRetries ?? providerSettings.maxRetries`，同链含 `timeoutMs` / `maxRetryDelayMs`；provider 设置来自 `settingsManager.getProviderRetrySettings()`（=`settings.retry.provider`，maxRetryDelayMs 缺省 60000）。
  - `retryProviderRequest` 非 pi-ai 公开导出（root/compat 均无），但在 `streamSimple` 内部被各 OpenAI 系 stream 模块使用并消费 `options.maxRetries` / `options.maxRetryDelayMs`（0.85.1 与 0.84.2 均已核实）。
  - pi 的 `isRetryableAssistantError` 对 `429: {"message":...,"code":"insufficient_quota"}` 报文同样返回不可重试（非重试表先短路）；两表与 fork 的 `retry.ts` 字节一致 → 分类器不是行为偏差点。
  - bun `toEqual` 忽略 undefined 属性 → `RetryPolicy` 加可选 `provider` 不破坏既有配置测试断言。
- **验证缺口**：真实 429 端到端回归需用户本机手动复现（触发 tpm/rpm limit 后观察 HTTP 层重试与最终恢复）。
- Review 机械项已清理：三新/改文件补齐尾随换行（对齐仓库 LF 约定）；`TWO_CHAR_OPS` 删不可达 `"&>>"` 死键。
- 术语已沉淀：CONTEXT.md 新增 **File overlap**。
- 待办：backlog issue 创建（`gh issue create --label needs-triage`，网络恢复后执行，body 就绪于 `%TEMP%\issue-body.md`）。
