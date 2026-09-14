<p>
  <img src="https://raw.githubusercontent.com/hu3rror/pi-better-btw-plus/main/banner.png" alt="pi-better-btw-plus" width="1100">
</p>

# pi-better-btw-plus

**[English](README.md) | 简体中文**

[![npm version](https://img.shields.io/npm/v/pi-better-btw-plus?style=for-the-badge)](https://www.npmjs.com/package/pi-better-btw-plus)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

把当前会话 fork 到一个旁路会话，主线 agent 继续干活。任务中途想查个 API 细节、验证一个思路，打开 `/btw` 提问、拿答案、关闭，主线全程不受打扰。

## Fork 谱系

pi-better-btw-plus 是 [`@yceachan/pi-better-btw`](https://www.npmjs.com/package/@yceachan/pi-better-btw) 的**维护型 fork**，后者又是 [nicobailon/pi-side-chat](https://github.com/nicobailon/pi-side-chat) 的 fork。署名链：**Nico Bailon** → **yceachan** → **hu3rror**；MIT 许可证保留全部三行版权。

上游包位于 [yceachan/ea-pi-extensions](https://github.com/yceachan/ea-pi-extensions) monorepo；本仓库是它的独立、持续开发 fork。

## 安装

```bash
pi install npm:pi-better-btw-plus
```

在 pi TUI 里用 `/btw`（别名 `/side`）或 `Alt+W` 打开旁路会话。提问、`Enter` 发送、`Esc` 关闭；重新打开继续同一段对话。

## 亮点

`@yceachan/pi-better-btw` 的全部功能都在——aside-agent 自我认知、只读车道强制、prompt pack 覆盖、`peek_main`、对话导出。本 fork 另新增：

| 功能 | 说明 |
| --- | --- |
| **输入框选区**（v1.4.0） | 输入框内拖选实时反色高亮；双击选词、三击选整个 visual 行。`Ctrl+C` / `Ctrl+Shift+C` 复制。 |
| **右键复制与粘贴** | 聊天区拖选后右键复制（延续 Windows Terminal 肌肉记忆）；输入框右键把系统剪贴板粘贴进编辑器，走编辑器内置粘贴入口。 |
| **Fork 模型切换**（`Ctrl+L`） | 侧聊内任选已认证模型，无需重建 fork。仅作用于 fork：主线模型不受影响。 |
| **Turn 级自动重试** | 与主会话共用 `settings.retry` 预算。瞬时 provider 错误退避重试，实时倒计时；`Esc` 取消。 |
| **`Ctrl+C` 清空对齐** | 无选区时 `Ctrl+C` 清空输入框；复制成功消费选区，下一次 `Ctrl+C` 回到清空语义。 |
| **`Alt+Shift+C` 整稿复制** | 复制整个草稿，paste 标记展开——与提交给 agent 的内容一致；无 kitty 协议的终端同样可用。 |
| **功能开关** | `features.rightClickCopyPaste` / `modelSwitch` / `retry` / `editorSelection` 按配置层逐项关闭。 |

### 输入框选区

侧聊打开期间独占终端鼠标，输入框因此在浮层内获得完整选区能力：

- **拖选**——反色高亮实时跟随（约 30fps）。
- **双击**——选中光标下的词。
- **三击**——选中整个 visual 行。
- **`Ctrl+C` / `Ctrl+Shift+C`**——按 chat 选区 → editor 选区 → 清空输入的顺序复制；复制成功消费选区。
- 选区是 transient 的：打字或移动光标即消失；绝不跨越 `[paste #N …]` 标记；autocomplete 弹层打开时禁用。`features.editorSelection: false` 关闭整个能力。

<img src="https://raw.githubusercontent.com/hu3rror/pi-better-btw-plus/main/docs/overlay.png" alt="pi-better-btw-plus overlay" style="zoom:33%;" />

## 快捷键

| 按键 | 作用 |
| --- | --- |
| `Alt+W` | 打开（关闭时）/ 后台化（显示时）/ 恢复（隐藏时） |
| `Enter` | 发送 |
| `Esc` | 中断流式输出或取消重试等待；空闲时关闭 |
| `Alt+T` | 切换只读 / 编辑模式 |
| `Alt+R` | 从最新主线上下文重新 fork |
| `Alt+N` | 开始空白对话 |
| `Alt+E` | 导出对话到 `$CWD/.agents/eval/pi-better-btw-<timestamp>.md` |
| `Ctrl+L` | Fork 模型选择器（`↑/↓` 选择，`Enter` 确认，`Esc` 取消） |
| `Ctrl+C` / `Ctrl+Shift+C` | 复制当前选区（chat 或 editor）；无选区时纯 `Ctrl+C` 清空输入 |
| `Ctrl+X` | 复制最后一条旁路 assistant 消息 |
| `Alt+Shift+C` | 复制输入框全部文本（paste 标记展开） |
| `Ctrl+V` / `Alt+V` | 把系统剪贴板粘贴进编辑器 |
| `PgUp` / `PgDn`、`Shift+↑` / `Shift+↓`、鼠标滚轮 | 滚动聊天历史 |
| 鼠标拖拽 | 选择聊天文本（反色高亮） |
| 双击（聊天区） | 选中渲染行 |
| 鼠标右键（聊天区） | 复制保留的选区 |
| 鼠标右键（输入框） | 粘贴 |

## 命令

- `/btw` —— 打开旁路会话；别名 `/side`（保留上游命令名兼容）。
- `peek_main` —— 仅旁路 agent 可用；按需读取主线会话近期活动。`lines`（默认 20，最大 50）、`since_fork`（仅显示旁路打开之后的活动）。

## 配置

`config.json` 从三层读取，按键由后层覆盖前层：

| 层 | 位置 |
| --- | --- |
| Bundle（默认） | 包内 `config.json` |
| 用户 | `~/.pi/agent/pi-better-btw/config.json` |
| 项目 | `<project>/.pi/pi-better-btw/config.json` |

- `features` —— 功能开关，每项默认 `true`：`rightClickCopyPaste`、`modelSwitch`、`retry`、`editorSelection`。
- `readOnlyExtensionAllowlist` —— 只读车道允许的扩展工具名；各层取并集，内置 `read`/`grep`/`find`/`ls` 与 `peek_main` 始终包含。
- `readOnlyExtensionAllowlistExclude` —— 移除内置默认项。
- `promptPack` —— 用自定义 markdown 覆盖任意注入提示（framing、焦点锚、车道提醒）；缺失键回退到随包 `prompts/`。

```json
{
  "readOnlyExtensionAllowlist": ["pi-vision-helper"],
  "features": { "editorSelection": false }
}
```

## 工作原理

- 旁路会话克隆当前会话到独立 agent（完整工具集），渲染在非抢占式顶部浮层；主编辑器保持可见。
- fork 保留主线 system prompt 于 system 槽位，并逐字注入 fork 快照——旁路请求是主线请求的 token 前缀，命中网关前缀缓存。
- 只读模式（默认）被强制：越权工具调用硬阻断，第二次违规升级并中止该轮。`peek_main` 按需读取主线近期活动。
- 浮层打开期间启用 xterm 鼠标上报并吞掉全部鼠标序列：滚轮滚动、拖拽选择、右键复制/粘贴。上报跟随浮层可见性——`Alt+W` 后台化时把鼠标还给终端。

## 开发

pi 直接加载 TypeScript，无构建步骤。把 pi 的扩展加载器指向 `./srcs/index.ts`，改完 `/reload` 即可。

```text
srcs/
├── index.ts                 # 扩展入口：命令、快捷键、浮层生命周期
├── side-chat-overlay.ts     # TUI 浮层、agent 生命周期、车道强制、鼠标路由
├── fork-turn.ts             # turn 运行器：重试退避、车道强制、相位
├── pointer-gesture.ts       # SGR 按下/拖拽/双击/三击/右键分类器
├── editor-selection.ts      # 视觉空间编辑器选区：高亮区间 + 复制文本
├── side-chat-messages.ts    # 消息渲染、换行、选择、滚动
├── config.ts                # 分层配置解析
├── prompt-pack.ts           # 提示包加载 + 模板替换
├── fork-surgery.ts          # 共享前缀 fork 快照手术
├── overlay-layout.ts        # 纯浮层几何
├── retry.ts                 # turn 级重试引擎
├── provider-retry.ts        # pi provider 层重试注入
├── clipboard-read.ts        # 平台剪贴板读取：native → xclip/wl-copy → OSC 52
├── model-switch.ts          # Ctrl+L 模型选择器
├── shortcuts.ts             # 快捷键绑定
└── …                        # status-channel、export、tool-wrapper、file tracker、mouse、write-paths
```

```bash
bun install
bun run typecheck
bun test
```

发布包包含 `srcs/`、`prompts/`、`config.json`、文档与 `banner.png`；测试不进 tarball。

## 限制

- 同一时间只能有一个旁路会话；无法在另一个可见浮层之上打开。
- 不会把消息合并回主线会话。
- bash 重叠检测是启发式的——覆盖常见写模式，非全部。
- `peek_main` 按需读取，非实时。
- 鼠标交互仅在常规（非全屏）TUI 模式下可用。

## License

MIT —— 见 [LICENSE](LICENSE)。保留全部三行版权：Nico Bailon（上游）、yceachan（中间 fork）、hu3rror（本 fork）。
