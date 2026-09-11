# Overlay 布局单一来源：镜像 pi 私有 resolveOverlayLayout，测试为防漂移护栏

侧聊 overlay 的屏幕布局知识此前散落三处、靠手工同步，镜像数学零测试：`index.ts`
内联硬编码 `overlayOptions`（`width: "85%"`、`margin: {top:1, left:2, right:2}`）、
overlay 模块私有的 `computeChatGeometry`（镜像 pi-tui 的 `TUI.resolveOverlayLayout`
百分比/锚点/clamp 语义）、`getViewport`（第三份 maxHeight/百分比/clamp 拷贝）。
后果：改一个值（如 width 85%→80%）时 TUI 渲染正确、但 `screenToChat` 命中列集体
错位——静默鼠标 bug，只能靠手动清单发现。

决策：抽取纯函数模块 `srcs/overlay-layout.ts` 作为布局知识的唯一来源——`LAYOUT`
常量对象 + `resolveLayout`（pi 私有解析器的镜像，含换源点注释）+ `computeChatGeometry`
+ `computeSideChatHeight` + `computeOverlayViewport` + 命名帧偏移常量
（`FRAME_HEADER_LINES` / `FRAME_SIDE_PADDING`）。渲染、鼠标命中、鼠标 viewport
从同一对象派生，不可能漂移；外部行为零变化（`SideChatOverlay` 公开面签名不变，
`helpers/make-overlay.ts` 零改动），既有套件（`select.test.ts` / `paste.test.ts` /
`index-lifecycle.test.ts`）零修改全绿作回归网。

## 已核实事实（实现引用，不再猜测）

- `TuiBase.resolveOverlayLayout` 是 **private** 方法（pi-tui 0.84.2
  `dist/tui.d.ts` L272-274）——扩展编译期不可达，镜像是被迫的；
- pi-tui 0.84.2（devDeps）`dist/tui.js` L679-800 与 0.85.1（运行时，mise 安装
  `@earendil-works+pi-tui@0.85.1`）`dist/tui.js` L781-902 的 `resolveOverlayLayout`
  逐行一致（margin/percent/clamp/anchor/offset）；`parseSizeValue`（0.84.2 L24-35 /
  0.85.1 L57-68）一致；
- `resolveOverlayMaxHeight` 分支从镜像中析出、与 `computeOverlayViewport` 共享，
  使百分比/clamp 数学在模块内只有一份（消灭旧 `getViewport` 的第三份拷贝）。

## 换源点（SWAP POINT）

`resolveLayout` 的注释明确标注：若 pi 公开其布局解析器，整个函数体替换为
`return resolveOverlayLayout(options, frameHeight, termWidth, termHeight);`——
镜像的测试（`test/overlay-layout.test.ts` 镜像契约表）无论镜像还是调用上游都持续
守护行为。

## 测试策略

表驱动单测只测外部行为（「(终端尺寸, 帧尺寸) → 几何」的纯映射），不测内部实现
细节：镜像契约表（percent 含小数 / anchor / margin/width/maxHeight clamp，期望值
从 pi 两版本源码手算）、几何不变量表（`msgTopRow = 外层 row + FRAME_HEADER_LINES`、
`contentCol = 外层 col + FRAME_SIDE_PADDING`、`innerWidth = 外层 width − 4`、
editor 条带行）、高度启发表（常规/小终端）、viewport 钳制表（maxHeight + 固定
topRow）。

## Considered options

- 调用 pi 的 `resolveOverlayLayout` vs 镜像：选镜像——private 编译期不可达，仅留
  换源点；上游公开时一行切换、测试不变。
- 分散拷贝维持现状 vs 抽取单一来源模块：选单一来源——「改一行 LAYOUT、几何/
  viewport/渲染自动跟随」是 spec 的核心用户故事，分散拷贝正是静默漂移的根源。
- 顺带重构 `renderSideChatFrame` 共享 FRAME_STRUCTURE vs 命名常量 + 不变量测试
  守护：选后者——帧渲染器不动，命名常量（`FRAME_HEADER_LINES` / `FRAME_SIDE_PADDING`）
  给偏移以名字、不变量表给漂移以护栏，重构范围不膨胀。
