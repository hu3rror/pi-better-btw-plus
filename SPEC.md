# Spec: side-chat 右键复制/粘贴、模型切换、retry 支持

> 状态：ready-for-agent（按 `/skill:to-spec` 产出；仓库尚未有 GitHub remote，先落盘在根目录，推送后可 `gh issue create` 同步为 issue 并打 `ready-for-agent` 标签）

## Problem Statement

pi-better-btw（侧聊 overlay 扩展）在 Windows Terminal 下有三个痛点：

1. **右键无法复制/粘贴**：侧聊打开期间，鼠标选中文字后右键无法复制；输入框右键也无法粘贴。终端原生选择/右键菜单在 overlay 可见期间被完全禁用。
2. **无法手动选择其他 model**：侧聊固定使用主会话的模型，没有切换入口。
3. **不支持 pi 设置中的 retry 机制**：pi 的 `settings.retry`（瞬时错误自动重试，默认 3 次、指数退避）在主会话生效，但侧聊完全不生效，瞬时错误直接显示错误结束。

## Solution

- 侧聊 overlay 内部实现完整的右键语义（与 Windows Terminal 惯例一致）：聊天区有选区时右键 = 复制选区；输入框右键 = 从系统剪贴板粘贴文本到光标处。
- 侧聊内新增模型选择器（键盘驱动），可随时切换 fork 的模型，切换后继续当前对话。
- 侧聊的 turn 循环接入与 pi 主会话一致的自动重试：读 `settings.retry` 预算，对可重试的瞬时 provider 错误指数退避自动重试，并在界面显示重试状态。

## User Stories

1. 作为侧聊用户，我想在侧聊消息区用鼠标拖拽选中文字后右键即可复制，以便沿用 Windows Terminal 的肌肉记忆，而不必改用 Ctrl+C 热键。
2. 作为侧聊用户，我想在侧聊输入框内右键即可粘贴剪贴板文本，以便快速粘贴外部内容。
3. 作为侧聊用户，我想右键粘贴支持多行文本并正确归一化换行/制表符，以便粘贴代码块不被破坏。
4. 作为侧聊用户，我想在没有选区时右键聊天区不产生任何副作用，以便误触右键不会复制错误内容。
5. 作为侧聊用户，我想在侧聊中按快捷键打开模型选择列表，以便手动选择对话使用的模型。
6. 作为侧聊用户，我想模型列表只显示当前会话可用（scoped）且已配置认证的模型，以便不会选到必然失败的模型。
7. 作为侧聊用户，我想切换到无 reasoning 能力的模型时 thinking level 自动钳制，以便不出现非法请求。
8. 作为侧聊用户，我想切换模型后继续原对话上下文，以便不用重开侧聊。
9. 作为侧聊用户，我想侧聊头部/提示栏显示当前模型，以便知道正在和哪个模型对话。
10. 作为侧聊用户，我想在瞬时 provider 错误（overloaded / rate limit / 5xx）时侧聊自动重试，以便与主会话行为一致。
11. 作为侧聊用户，我想重试时看到退避倒计时状态，以便知道正在自动重试而不是卡死。
12. 作为侧聊用户，我想重试次数耗尽后仍显示最终错误，以便知道确实失败了。
13. 作为侧聊用户，我想按 Esc 可以取消进行中的重试等待，以便不想等时可以立即停止。
14. 作为侧聊用户，我想重试遵守 `settings.retry` 的 `enabled/maxRetries/baseDelayMs` 配置，以便不重试时（如本地模型调试）不产生意外延迟。
15. 作为侧聊用户，我想上下文溢出类错误不触发重试，以便不会无意义地重复失败请求。
16. 作为侧聊用户，我想背景化（Alt+W）侧聊后终端原生选择/右键行为恢复，以便需要时仍能用终端原生的方式操作主界面。

## Implementation Decisions

- **D1（鼠标捕获模型不变）**：overlay 可见期间维持现有的 xterm 鼠标上报（button + motion + SGR）。终端逃逸序列不支持按区域开/关鼠标模式，因此不做区域化 passthrough；右键在 overlay 内部成为应用层动作，而不是试图转发给终端。背景化（Alt+W）保持为恢复终端原生行为的出口。
- **D2（右键语义）**：在现有鼠标事件处理中增加右键（button 2）分支，按命中区域决策：
  - 聊天消息区 + 存在拖拽选区 → 复制选区（复用现有复制到剪贴板 + 状态提示逻辑）；
  - 输入编辑器区 → 粘贴；
  - 其它区域（边框/头部）→ 忽略。
  释放右键时执行动作，避免按下即触发。
- **D3（剪贴板读取）**：新增自包含的剪贴板读取 helper。写剪贴板沿用公开导出的 `copyToClipboard`；读剪贴板需要自行实现：Windows 优先走 `Get-Clipboard -Raw`（与 pi 自身读剪贴板图片的 PowerShell 通道一致），fallback OSC 52 query。不支持时静默降级并提示。
- **D4（编辑器粘贴）**：粘贴使用编辑器组件的编程式光标插入 API（原子 undo、触发 onChange），与既有粘贴标记流一致；文本先做换行/制表符归一化。
- **D5（模型切换机制）**：保持 fork 自己的 transcript 不变，运行时替换 agent 的当前模型（agent 循环每次 prompt 都重新读取当前模型，无需重建 agent）。切换后按新模型能力钳制 thinking level。主会话的 `pi.setModel` 不动 —— 侧聊模型选择只影响 fork 自身。
- **D6（模型列表来源）**：优先使用会话作用域模型集（scoped models），为空（未配置 scoping）时回退到可用模型目录；用认证状态过滤/置灰未配置认证的模型。
- **D7（模型选择 UI）**：选择器渲染在 overlay 内部（模态列表模式），不用宿主的选择对话框 —— 宿主在 overlay 已打开时拒绝第二个 overlay。快捷键打开（建议 Alt+M），上下选择、回车确认、Esc 取消，复用现有列表主题。
- **D8（retry 预算读取）**：扩展已从同一 agent 配置目录读取分层用户配置；新增从共享 settings 文件读 `retry` 块，默认值与 pi 一致（enabled=true, maxRetries=3, baseDelayMs=2000）。
- **D9（重试循环）**：在侧聊 turn 提交处包一层重试循环：错误分类器判定可重试（缺失 status、408/409/429、5xx），排除 abort 与上下文溢出；按 `baseDelayMs * 2^(n-1)` 退避，期间显示 "Retrying (attempt n)…" 状态并可被 Esc 取消；预算耗尽后展示最终错误。重试前对失败 assistant 消息的处理与 pi 主会话的清理语义对齐（不把错误消息重复送入下一次请求）。
- **D10（UI 呈现）**：头部状态区显示当前模型；提示栏新增绑定提示（Alt+M 选模型、右键复制/粘贴说明）。
- **D11（可配置性）**：右键复制/粘贴、模型切换、retry 均可通过扩展分层配置开关（bundle/user/project），默认开启，避免破坏既有用户行为。

## Testing Decisions

- **测试原则**：只测外部行为，不测实现细节；纯函数逻辑优先拆出单测，鼠标 SGR 端到端与 TUI 交互走手动验证。
- **测试模块与既有 seam**：
  - 可重试错误分类器（纯函数：错误对象 → 是否可重试 + 退避毫秒数）—— 单测，直接断言分类表与退避序列；
  - retry 预算/退避调度（纯逻辑：attempts vs maxRetries、delay 序列）—— 单测；
  - 模型列表构建与认证过滤（纯逻辑：scoped models + 认证状态 → 可选列表）—— 单测；
  - 右键命中决策（纯逻辑：命中区域 + 有无选区 → 复制/粘贴/忽略）—— 单测；
  - 剪贴板读取的降级路径 —— 单测（mock 平台通道失败 → fallback → 返回 null）；
  - 配置解析新增字段 —— 并入现有配置解析测试（`test/` 下已有 config 相关单测作 prior art）；
  - SGR 解析、拖拽选区的既有单测（`test/select.test.ts` 一类的 prior art）保持绿色。
- **手动验证（Windows Terminal + 本机 pi 0.85.x）**：侧聊内拖选→右键复制→系统剪贴板内容正确；输入框右键粘贴多行文本；Alt+M 列表选择/取消；对本地不可达端点触发瞬时错误观察自动重试与退避状态；Esc 取消重试；Alt+W 背景化后主界面原生选择恢复。

## Out of Scope

- overlay 可见期间主区域（overlay 之外）的终端原生选择恢复 —— 鼠标上报按区域开启在终端协议层面不可行，属于固有取舍。
- 右键粘贴图片 —— 仅文本。
- 侧聊模型选择同步到主会话（`pi.setModel` 的持久化语义只作用于主会话，fork 是独立 lane）。
- 提供 UI 编辑 `settings.retry` —— 只读遵循 pi 的配置。
- 侧聊的自动压缩（compaction）或其它 AgentSession 层能力 —— 本 spec 只补 retry。

## Further Notes

- 目标环境：pi 0.85.1（`@earendil-works/pi-coding-agent` / `pi-tui` 0.85.1），Windows Terminal。上游 pi 的 fullscreen 模式已实现 Windows 右键粘贴（alt-screen 组件的 `onRightClickPaste`），是实现 D2/D3 的直接先例。
- 公开 API 中只有 `copyToClipboard`（写剪贴板）；`readClipboardText` 未从包根导出，故 D3 需要自研读侧。
- 上游仓库结构与历史已通过 `git subtree split` 保留在本仓库（87 个提交，仅含本包内容），后续改动可直接作为 fork 提交。
- 交付形态：优先给上游 `yceachan/ea-pi-extensions` 提 PR；维护者不接受再以本仓库为基线二开。
