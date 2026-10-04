<p>
  <img src="https://raw.githubusercontent.com/hu3rror/pi-better-btw-plus/main/banner.png" alt="pi-better-btw-plus" width="1100">
</p>

# pi-better-btw-plus

**[English](README.md) | 简体中文**

[![npm version](https://img.shields.io/npm/v/pi-better-btw-plus?style=for-the-badge)](https://www.npmjs.com/package/pi-better-btw-plus)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

面向 [pi](https://github.com/earendil-works/pi-coding-agent)（编码 agent）的侧聊浮层扩展。主线 agent 继续干活的同时，`/btw` 把当前会话 fork 到一个独立浮层——查个 API 细节、验证一个思路，拿到答案就关掉。主线全程不受打扰。

## 功能

### 侧聊

- **不抢占主线的 fork**——侧聊是从当前会话克隆出的独立 agent，渲染在顶部浮层；主编辑器保持可见，主线照常运行。
- **默认只读**——越权工具调用会被直接拦截（第二次违规升级并中止该轮）；`peek_main` 按需读取主线近期活动；`Alt+T` 切换编辑模式。
- **前缀缓存友好**——侧聊请求与主线共享上下文，能命中网关前缀缓存，更快更省。
- **会话工具**——从最新主线上下文重新 fork（`Alt+R`）、开启空白对话（`Alt+N`）、后台化不丢状态（`Alt+W`）、导出对话记录（`Alt+E`）、用 prompt pack 覆盖任意注入提示。
- **文件冲突防护**——侧聊打开期间主线写过的文件会受到保护：向这些路径写入前会先要求确认。

### 与 pi 官方保持一致

不引入自创的交互语言，快捷键与行为都遵循 pi 官方惯例，侧聊用起来和主会话完全一样：

- **快捷键与主会话一致**——复制/清空、粘贴、复制消息、模型选择、键位表均遵循 pi 官方绑定（`tui.input.copy`、`app.clear`、`app.clipboard.pasteImage`、`app.message.copy`、`app.model.select`、`app.tools.expand`）；键位冲突时让位给 pi：`Alt+T` 切换模式，把 `Ctrl+T` 留给 pi 的思考开关。
- **行为与主会话一致**——重试、溢出判断、剪贴板、模型选择的行为与 pi 本身一致，浮层布局也沿用 pi 的窗口几何。

### 终端肌肉记忆，浮层内重新实现

侧聊打开期间独占终端鼠标，主会话从 Windows Terminal 或 `AgentSession` 继承的那些便利，需要在浮层里重新实现：

| 功能 | 说明 |
| --- | --- |
| **输入框选区** | 输入框内拖选实时反色高亮；双击选词、三击选中整行。`Ctrl+C` / `Ctrl+Shift+C` 复制。 |
| **右键复制与粘贴** | 聊天区拖选后右键复制（延续 Windows Terminal 肌肉记忆）；输入框右键把系统剪贴板内容粘贴进来，通过编辑器自带的粘贴逻辑。 |
| **Fork 模型切换**（`Ctrl+L`） | 侧聊内可随时换用任意已配置的模型，无需重建 fork；只对侧聊生效，主线模型不受影响。 |
| **单轮自动重试** | 与主会话共用 `settings.retry` 预算；服务商出现暂时性错误时自动退避重试，带实时倒计时，`Esc` 可取消。 |
| **`Ctrl+C` 清空输入** | 无选区时 `Ctrl+C` 清空输入框；复制成功后选区消失，下一次 `Ctrl+C` 恢复清空行为。 |
| **`Alt+Shift+C` 复制整个草稿** | 复制全部草稿文本，粘贴标记展开——与真正提交给 agent 的内容完全一致；不支持 kitty 协议的终端也能用。 |
| **键位表弹窗**（`Ctrl+O`） | 底部提示条只显示高频键；按 `Ctrl+O` 弹出完整键位表，按功能分组。 |
| **功能开关** | `features.rightClickCopyPaste` / `modelSwitch` / `retry` / `editorSelection` 按配置层逐项关闭。 |

浮层打开期间会接管全部鼠标操作：滚轮滚动、拖拽选择、右键复制/粘贴；`Alt+W` 后台化后鼠标交还给终端。

### 输入框选区

- **拖选**——反色高亮实时跟随（约 30fps）。
- **双击**——选中光标下的词；**三击**——选中整行。
- 选区是临时的：打字或移动光标即消失；不会跨过 `[paste #N …]` 粘贴标记；自动补全弹窗打开时禁用。

## 安装与快速上手

```bash
pi install npm:pi-better-btw-plus
```

pi TUI 中用 `/btw`（或原名 `/side`）或 `Alt+W` 打开。提问、`Enter` 发送、`Esc` 关闭；重新打开继续同一段对话。

> [!NOTE]
> 已验证与 pi `1.0.2` 兼容。

## 快捷键

| 按键 | 作用 |
| --- | --- |
| `Alt+W` | 打开（关闭时）/ 后台化（显示时）/ 恢复（隐藏时） |
| `Ctrl+O` | 弹出完整的键位表 |
| `Enter` / `Esc` | 发送 / 中断流式输出或取消重试等待；空闲时关闭 |
| `Alt+T` | 切换只读 / 编辑模式 |
| `Alt+R` | 从最新主线上下文重新 fork |
| `Alt+N` | 开始空白对话 |
| `Alt+E` | 导出对话到 `$CWD/.agents/eval/pi-better-btw-<timestamp>.md` |
| `Ctrl+L` | Fork 模型选择器（`↑/↓` 选择，`Enter` 确认，`Esc` 取消） |
| `Ctrl+C` / `Ctrl+Shift+C` | 复制当前选区（聊天区或输入框）；无选区时 `Ctrl+C` 清空输入 |
| `Ctrl+X` | 复制最后一条侧聊助手消息 |
| `Alt+Shift+C` | 复制输入框全部文本（粘贴标记展开） |
| `Ctrl+V` / `Alt+V` | 把系统剪贴板内容粘贴进输入框 |
| `PgUp` / `PgDn`、`Shift+↑` / `Shift+↓`、鼠标滚轮 | 滚动聊天历史 |
| 鼠标拖拽 / 双击 | 选择聊天文本（反色高亮）/ 选中整行 |
| 鼠标右键 | 复制保留的选区（聊天区）/ 粘贴（输入框） |

## 命令

- `/btw`、`/side`——打开侧聊（两个命令均已注册、效果相同；`/btw` 与项目同名，`/side` 是沿用旧名）。
- `peek_main`——仅侧聊 agent 可用；按需读取主线会话近期活动。`lines`（默认 20，最大 50）、`since_fork`（仅显示侧聊打开之后的活动）。

## 配置

`config.json` 从三层读取，按键由后层覆盖前层：

| 层 | 位置 |
| --- | --- |
| Bundle（默认） | 包内 `config.json` |
| 用户 | `~/.pi/agent/pi-better-btw/config.json` |
| 项目 | `<project>/.pi/pi-better-btw/config.json` |

- `features`——功能开关，每项默认 `true`：`rightClickCopyPaste`、`modelSwitch`、`retry`、`editorSelection`。
- `readOnlyExtensionAllowlist`——只读模式下允许调用的扩展工具；各层取并集，内置 `read`/`grep`/`find`/`ls` 与 `peek_main` 始终包含。
- `readOnlyExtensionAllowlistExclude`——移除内置默认项。
- `promptPack`——用你自己的 markdown 文件覆盖任意注入提示（如 framing、焦点锚、越界提醒），缺失的键回退到包内自带 `prompts/`。

```json
{
  "readOnlyExtensionAllowlist": ["pi-vision-helper"],
  "features": { "editorSelection": false }
}
```

## 工作原理

- 侧聊是把当前会话克隆出的独立 agent，渲染在顶部浮层——主编辑器保持可见，主线照常运行。
- 只读模式（默认开启）强制生效：越权工具调用被直接拦截，第二次违规升级并中止该轮。`peek_main` 按需读取主线近期活动。
- 浮层打开期间会接管鼠标：滚轮滚动、拖拽选择、右键复制/粘贴；`Alt+W` 后台化后鼠标交还给终端。

## 开发

pi 直接加载 TypeScript，无构建步骤。把 pi 的扩展加载器指向 `./srcs/index.ts`（入口；`srcs/` 其余文件为浮层、越界拦截、重试与剪贴板相关代码），改完 `/reload` 即可。

```bash
bun install
bun run typecheck
bun test
```

## 限制

- 同一时间只能开一个侧聊；无法在另一个可见浮层之上打开。
- 不会把消息合并回主线会话。
- bash 写入冲突检测是启发式的——覆盖常见写模式，并非全部。
- `peek_main` 按需读取，非实时。
- 鼠标交互仅在常规（非全屏）TUI 模式下可用。

## License 与起源

MIT —— 见 [LICENSE](LICENSE)。本项目是 [`@yceachan/pi-better-btw`](https://www.npmjs.com/package/@yceachan/pi-better-btw) 的持续维护 fork，其上游是 [nicobailon/pi-side-chat](https://github.com/nicobailon/pi-side-chat)。保留全部三行版权：Nico Bailon、yceachan、hu3rror。
