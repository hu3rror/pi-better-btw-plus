# 手动测试参考

issue #1（spec）的验收清单。对应 issue #1 的「Testing Decisions → 手动验证」，另含 D11 可配置开关的验证。自动测试无法覆盖的项（真实剪贴板、终端鼠标序列、系统设置）都在这份清单里。

## 环境

- Windows Terminal + 本机 pi 0.85.1（spec 基线）
- 扩展加载 `./srcs/index.ts`，改完代码 `/reload` 后重开侧聊（config 每次打开时重读，无需 reload）
- 默认只读模式；`Alt+T` 切编辑模式

## 打开侧聊

- `/btw`（或 `/side`、`Alt+W`）打开 fork overlay
- 头部显示 `[Model: <id> • <thinking>]`（D10）

---

## A. 右键复制（聊天区）

1. 拖选一段文字 → 反色高亮
2. 在聊天区内右键 → 状态行出现 `✓ Copied N chars`；在终端别处粘贴，内容与选区一致
3. 选区在复制后**保持高亮**；再次右键 → 重新复制同一段
4. 双击整行 → 右键 → 整行复制
5. 无选区时右键聊天区 → 无任何副作用（不复制、无菜单）
6. 右键按下后移到聊天区外再松开 → 不复制（动作在 release 触发，release 位置决定）
7. `Ctrl+C` / `Ctrl+Shift+C` 热键复制仍可用（与右键互不影响）
8. `Ctrl+X` → 复制最后一条 assistant 消息到剪贴板（无需选区）

## B. 右键粘贴（输入框）

1. 复制一小段文本，在输入框内右键 → 文本插入光标处（支持光标不在末尾的情况）
2. 复制多行/代码块（>10 行或 >1000 字符）→ 编辑器出现 `[paste #N +X lines]` / `[paste #N X chars]` 标记
3. 提交（`Enter`）→ agent 收到的是**展开后的完整文本**（看回复是否包含全部内容，而非标记原文）
4. 粘贴后立即 `Ctrl+-`（undo）→ 整段粘贴一次撤销
5. 剪贴板为空 → 状态行 `Clipboard is empty`，编辑器不变
6. 剪贴板含 `\r\n` 和 `\t` → 编辑器显示 `\n` 与 4 空格（归一化）
7. 右键头部/边框 → 无副作用
8. `Ctrl+V` / `Alt+V` → 键盘粘贴，行为与右键粘贴一致（插入光标处、归一化、大段折叠标记）

> 读取失败（平台通道与 OSC 52 回退全部不可用）→ `Clipboard read failed`，编辑器不变。win32 平台通道是 `Get-Clipboard -Raw`，通常只在 PowerShell 被禁用/降级时走到失败分支，可用单测覆盖代替。


## B2. Alt+Shift+C 复制输入（issue #23）

1. 输入多行文本 → `Alt+Shift+C` → 状态行 `✓ Copied · input · N chars`，剪贴板为完整文本（多行保留），输入内容不变
2. 右键/`Ctrl+V` 粘贴 >10 行 → 出现 `[paste #N +X lines]` 标记 → `Alt+Shift+C` → 剪贴板为展开后的完整文本（不是标记字符串）
3. 清空输入框 → `Alt+Shift+C` → 状态行 `Input is empty`，剪贴板不变
4. 聊天区已有鼠标选区时 → `Alt+Shift+C` → 选区不受影响（可继续 `Ctrl+C` 复制选区）
5. 流式（agent 回复中）→ `Alt+Shift+C` → 仍可复制
6. `Ctrl+L` 模型选择器打开时 → `Alt+Shift+C` 不生效（模态接管键盘）
7. 回归：`Ctrl+C`（无选中清空输入）、`Ctrl+X`（复制最后消息）不受影响

> 兼容无 kitty keyboard protocol 的终端（Windows Terminal < 1.25）：Alt+Shift+C 以 legacy ESC+C 送达，绑定显式接受该原始编码；WT ≥ 1.25 走 kitty CSI-u。
## C. Ctrl+L 模型切换

1. `Ctrl+L` → 列表打开，只含 scoped（`--models` / `enabledModels`）或可用目录中**已配置认证**的模型
2. `↑/↓` 选择、`Enter` 确认 → 状态行 `✓ Model: <id>`，头部 `[Model: <id>]` 更新
3. `Ctrl+L` → `Esc` → 取消，模型不变
4. 切到无 reasoning 能力的模型 → 头部显示 `thinking off`（钳制生效）
5. 流式（agent 回复中）按 `Ctrl+L` → 状态行 `Model switch unavailable while streaming`，列表不打开
6. 切换后继续提问 → 原对话上下文保留（不用重开侧聊）
7. `Alt+W` 背景化再恢复 → 模型选择保留
8. `Alt+R`（refork）/ `Alt+N`（clear）/ `Esc` 关闭 → 模型重置回主会话模型

## D. retry 自动重试

默认预算：`settings.retry` = `enabled: true, maxRetries: 3, baseDelayMs: 2000`（与主会话一致，来自 `~/.pi/agent/settings.json` 合并 `<cwd>/.pi/settings.json`）。

触发瞬时错误（两种方式任选）：

- **本地不可达端点**：在 `~/.pi/agent/settings.json` 的 models 里加一个 `baseUrl: "http://127.0.0.1:9877/v1"` 的模型（端口不监听 → connection refused → 可重试），`/reload` 后用 `Ctrl+L` 切到它再提问。**验证后删除该模型并还原 settings.json。**
- **mock 503 服务器**（PowerShell 起一个恒 503 的端点，baseUrl 指过去）：

```powershell
$l = [System.Net.HttpListener]::new()
$l.Prefixes.Add("http://127.0.0.1:9877/")
$l.Start()
while ($l.IsListening) { $c = $l.GetContext(); $c.Response.StatusCode = 503; $c.Response.Close() }
```

步骤：

1. 触发瞬时错误 → 状态区出现 `Retrying (1/3) in 2s… (Esc to cancel)`，倒计时每秒递减
2. 端点恢复/重试成功 → 正常收到回复，无错误残留
3. 一直失败 → 预算耗尽（3 次）后显示最终错误
4. 退避等待期间按 `Esc` → 立即显示最后一次错误（不悬挂在中间态）
5. 设 `settings.retry.enabled: false` → 瞬时错误直接显示，无倒计时（本地模型调试场景）
6. 消息超长触发上下文溢出 → 不重试，直接显示溢出错误

## E. Alt+W 背景化

1. 侧聊可见时 `Alt+W` → overlay 隐藏，主界面恢复终端原生鼠标选择/右键
2. 再 `Alt+W` → overlay 恢复，fork 的消息与模型选择都还在

## F. D11 可配置开关

开关在分层配置的 `features` 块（bundle → `~/.pi/agent/pi-better-btw/config.json` → `<cwd>/.pi/pi-better-btw/config.json`），默认全 `true`、`fullscreenCopyOnSelect` 例外默认 `false`。在用户层写：

```json
{ "features": { "rightClickCopyPaste": false } }
```

逐项验证（每项测完还原）：

| 开关 | 置 `false` 后的预期 |
| ---- | ---- |
| `rightClickCopyPaste` | 有选区右键聊天区不复制；输入框右键不粘贴；`Ctrl+C` 热键仍正常 |
| `modelSwitch` | `Ctrl+L` 无反应，头部模型不变 |
| `retry` | 即使 `settings.retry` 开启，瞬时错误直接显示、零退避（等价 D-5） |
| `fullscreenCopyOnSelect` | 置 `true`：fullscreen 下 fork 区拖选/双击 release 即复制（不消费选区）；置 `false`/默认：release 不复制（H4） |

其它：

- 只覆盖一个键 → 其余开关保持默认开启（如只关 `retry`，右键和 Ctrl+L 仍工作）
- 非法值（如 `"retry": "disabled"`）→ 忽略，回退默认 `true`
- 还原配置后重开侧聊 → 行为恢复

## G-fullscreen. fullscreen 模式矩阵（spec #37）

以 **fullscreen 启动 pi**（pi 1.0 默认；不指定 `--tui-mode regular`）逐项检查。
fork 打开时覆盖的屏幕区 = **fork 区**，其余 = **主区**。预期：fork 区内所有鼠标行为与
regular 逐位一致；主区由 pi 原生接管。标 `[NEEDS MANUAL VERIFICATION]` 的项为
自动测试无法覆盖的 pi 侧行为。

### G1. fork 区交互（与 A/B/D 的 regular 结果对照）

| 动作 | 预期 |
| ---- | ---- |
| 拖选聊天文字 | 仅选中 fork 文本，**不复制任何内容**（默认） |
| 双击聊天行 | 选中整渲染行；**剪贴板不含主会话内容**（修复前 bug：双击复制主消息） |
| 三击 | 选整渲染行（同双击） |
| 输入框 拖选/双击词/三击行 | 与 regular 一致（反色高亮 + `Ctrl+C` 复制） |
| 有选区右键聊天区 | 复制选区且保持高亮 |
| 输入框右键 | 粘贴进 fork 编辑器（win32 不复原到主编辑器） |
| 滚轮（fork 聚焦或未聚焦） | 都滚动 fork 自身 transcript，主 transcript 不动 |
| 点 fork 头部/边框 | 无副作用、不产生主区选择 |
| 拖出 fork 边后松开 | 选区 clamp，不丢失 |
| 单击 fork 内 | fork 获得焦点（后续键入/复制落在 fork） |

### G2. 主区（fork 打开时）

| 动作 | 预期 |
| ---- | ---- |
| 主区可见部分 拖选/双击/右键 | pi 原生行为；若 pi `fullscreenCopyOnSelect` 开启，选择自动复制（fork 区不受影响） |

### G3. Alt+W / 关闭 —— 上报所有权回归 `[NEEDS MANUAL VERIFICATION]`

1. fork 打开 → `Alt+W` 后台化 → 主区 拖选/滚轮/链接 仍工作（pi 鼠标未被杀掉）
2. 重新显示 fork → 主区鼠标依旧正常
3. 关闭 fork → 主区鼠标依旧正常（修复前：会杀到重进 alt-screen 才恢复）

### G4. `features.fullscreenCopyOnSelect`（opt-in 镜像）

1. 用户层设 `{ "features": { "fullscreenCopyOnSelect": true } }` → 重开侧聊
2. fork 区 拖选/双击 → release 即复制（状态行 `✓ Copied N chars`），**高亮保留**
3. 点按（无拖）→ 不复制
4. 还原配置 → release 不再复制（默认回到 G1 第一行）

## G. 回归

- 拖选松开鼠标**不自动复制**（复制只走右键/热键）
- 滚轮滚动、`PgUp`/`PgDn`、双击选行仍正常
- `Esc` 空闲关闭、`Alt+R` refork、`Alt+N` clear、`Alt+E` 导出正常
- 提示栏两行仍在：`… · C+c copy · C+x last · A+⇧C all · C+v paste · R-click copy/paste · …` 与 `A+w bg · A+r fork · A+n new · A+e export · C+l model`

## 故障排查

| 现象 | 排查 |
| ---- | ---- |
| 右键复制无反应 | 是否有活跃选区；光标是否在聊天区内；`features.rightClickCopyPaste` 是否被关 |
| 右键粘贴无反应 | 剪贴板是否有文本；光标是否在输入框内；同上 |
| `Ctrl+L` 打不开 | 流式期间被拒（状态行有提示）；`features.modelSwitch: false` |
| 无 retry 倒计时 | `settings.retry.enabled: false` 或 `features.retry: false`；错误类别不可重试（溢出/配额/abort） |
| 剪贴板读不到 | win32 平台通道 `Get-Clipboard -Raw` 不可用且 OSC 52 无回退时的预期行为（`Clipboard read failed`） |
| fullscreen 双击/拖选复制出主会话内容 | 修复前行为（fork 区无人认领鼠标）；确认加载含 spec #37 的版本，`/reload` 后重开侧聊 |
| fullscreen 下 Alt+W / 关闭后主区鼠标失效 | 修复前行为（扩展关闭了 pi 的鼠标上报）；同上 |

---

## 验收记录

| 分组 | 结果 | 备注 |
| ---- | ---- | ---- |
| A 右键复制 | ☐ | |
| B 右键粘贴 | ☐ | |
| C 模型切换 | ☐ | |
| D retry | ☐ | |
| E 背景化 | ☐ | |
| F 配置开关 | ☐ | |
| G 回归 | ☐ | |
| H 复制输入 | ☐ | |

全部通过后关闭 issue #1。
