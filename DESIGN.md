# Nexus 前端设计规范

> 整理日期：2026-09-10。依据当前前端源码整理，供新增页面、组件和界面调整时参考。本文保留原有设计约束，并区分已实现的设计惯例与待统一项；不代表已完成浏览器视觉验收或无障碍认证。

## 1. 设计定位

Nexus 是以终端为中心的工作台。项目、通道、文件、提示词和设置围绕终端展开，主界面优先保留终端的可用面积，并明确当前输入会发送到哪个通道。

- **视觉基调**：Slate 灰阶、蓝色强调色、细边框、紧凑排版。通过背景层次、分隔线和选中边框建立结构。
- **内容优先**：桌面适合同时观察多个终端；移动端围绕一个当前终端组织操作。
- **操作就近**：通道操作在侧栏或会话面板，单 pane 操作在 pane 标题栏，终端快捷输入在工具栏。
- **状态可辨**：连接、通道活动、当前焦点、保存结果分别表达，不能把“连接正常”解释成“任务完成”。
- **延续现有实现**：React + TypeScript、Tailwind CSS、自有 `Icon` 和 xterm.js；当前没有独立的通用 Button/Dialog 组件库。

来源：[应用入口](frontend/src/App.tsx)、[终端编排](frontend/src/Terminal.tsx)、[前端依赖](frontend/package.json)。

### 1.1 原有设计约束

以下是项目既有的设计要求；后文中的现状记录不代表所有组件均已满足。

- 单用户、工具型产品优先，视觉强化不得遮挡主操作，不引入无实际用途的仪表盘和重装饰。
- 项目、通道、历史和文件必须明确所属工作区。新增入口要区分“切换上下文”与“查看当前上下文的附加信息”。
- 历史等属于当前工作区的能力放在工作区内部，不与工作区列表并列为全局一级导航。
- 移动端保留显式返回入口，系统返回不能是唯一退出路径。

| 面板语汇 | 职责 |
| --- | --- |
| `workspace shell` | 主工作区，承载终端与当前操作 |
| `manager panel` | 项目、通道管理，支持切换、创建、删除、重命名 |
| `memory panel` | 历史、记录、可回溯信息，例如 Codex 历史会话 |
| `utility panel` | 文件、设置及辅助工具 |

同一屏内应清楚区分管理与历史面板，不混淆它们的操作语义。

## 2. 主题与颜色

### 2.1 语义色板

界面颜色通过 CSS 变量和 `nexus` Tailwind 命名空间使用。新组件优先使用下表中的语义类，避免在组件内另建一套明暗色板。

| 用途 | CSS 变量 | Tailwind 示例 | 深色 | 浅色 |
| --- | --- | --- | --- | --- |
| 主背景 | `--nexus-bg` | `bg-nexus-bg` | `#0f172a` | `#ffffff` |
| 次级表面、输入区域 | `--nexus-bg2` | `bg-nexus-bg-2` | `#1e293b` | `#f1f5f9` |
| 菜单、抽屉背景 | `--nexus-menu-bg` | `bg-nexus-menu-bg` | `#1e293b` | `#ffffff` |
| 边框、分隔线 | `--nexus-border` | `border-nexus-border` | `#334155` | `#e2e8f0` |
| 主要文字 | `--nexus-text` | `text-nexus-text` | `#f1f5f9` | `#0f172a` |
| 次要文字 | `--nexus-text2` | `text-nexus-text-2` | `#94a3b8` | `#64748b` |
| 弱提示、占位信息 | `--nexus-muted` | `text-nexus-muted` | `#475569` | `#94a3b8` |
| 当前条目背景 | `--nexus-tab-active` | `bg-nexus-tab-active` | `#1e293b` | `#f1f5f9` |
| 主操作、焦点 | `--nexus-accent` | `bg-nexus-accent` | `#3b82f6` | `#3b82f6` |
| 成功、正常运行 | `--nexus-success` | `text-nexus-success` | `#22c55e` | `#22c55e` |
| 等待、处理中 | `--nexus-warning` | `text-nexus-warning` | `#f59e0b` | `#f59e0b` |
| 错误、危险操作 | `--nexus-error` | `text-nexus-error` | `#ef4444` | `#ef4444` |

颜色应与文字、图标或边框共同表达状态。`muted` 用于辅助信息，不应作为主要正文的默认颜色。

### 2.2 主题切换

- CSS 的 `:root` 提供深色初始值，`:root.light` 提供浅色值。
- 终端界面初始化时优先读取 `localStorage.nexus_theme`；没有有效偏好时根据 `prefers-color-scheme` 选择主题。
- 未手动选择时跟随系统主题变化；手动选择后保存偏好。
- 应用主题时同步根节点变量、`color-scheme`、浏览器 `theme-color` 和 xterm 主题。
- 原生 `input`、`textarea`、`select` 继承 `color-scheme`，输入代理和 xterm 隐藏输入框也需要匹配主题。

虽然 Tailwind 配置声明了 `darkMode: 'class'`，当前主题切换实际使用 `.light` 与 CSS 变量。新增组件应沿用语义 token，不应假设切换器会设置 `.dark`。

来源：[全局样式](frontend/src/index.css)、[Tailwind 映射](frontend/tailwind.config.js)、[主题实现](frontend/src/terminal/theme.ts)、[主题切换入口](frontend/src/Terminal.tsx)。

## 3. 字体、字号与图标

### 3.1 排版层级

普通界面沿用 Tailwind 默认无衬线字体；命令、路径、终端内容和部分通道名称使用等宽字体。

| 场景 | 当前常见规格 |
| --- | --- |
| 登录页品牌标题 | `text-3xl` / 30px、`font-bold`、`tracking-widest` |
| 面板、工作区标题 | `text-base` / 16px、`font-semibold`；部分抽屉为 15px |
| 正文、表单、普通操作 | `text-sm` / 14px |
| 状态、次要操作 | `text-xs` / 12px |
| 分组标签、计数 | 11–13px；分组标签常使用加宽字距 |
| 提示词正文编辑器 | 13px 等宽、`leading-6` / 24px 行高 |

这些是当前组件的使用范围，不是已经抽象成代码 token 的完整字号系统。新增同类组件应优先复用对应规格。

等宽字体栈为 `Menlo, Monaco, "Cascadia Code", "Fira Code", monospace`。长名称使用 `min-w-0`、`truncate` 或省略号；重要完整名称可通过 `title` 补充，正文编辑区保留滚动能力。

### 3.2 图标

优先使用 `<Icon name="…" size={…} />`：实际 SVG 为 `viewBox="0 0 24 24"`，默认显示 20px，`fill="none"`、`stroke="currentColor"`、线宽 2、圆形端点和连接。

- 常规工具图标：18–20px。
- 紧凑 pane 操作：13–14px；列表操作常为 14–16px。
- 空状态或错误提示图标：22–28px。
- 图标颜色由父级语义文字色继承。新增纯图标按钮应提供可理解的 `aria-label`，悬停说明可使用 `title`。

来源：[图标库](frontend/src/icons.tsx)、[pane 标题栏](frontend/src/terminal/PaneHeader.tsx)、[提示词库](frontend/src/PromptLibrary.tsx)。

## 4. 间距、形状与表面

布局主要采用 Tailwind 间距阶梯，常见为 4、8、12、16、20、24px，也有 `gap-1.5`、`py-3.5` 等半阶值。

| 元素 | 当前惯例 |
| --- | --- |
| 图标与短文字间距 | 4–8px |
| 列表与紧凑工具区 | 8–12px 内边距 |
| 面板标题与内容 | 水平 16px；标题常用垂直 14px |
| 设置分组间距 | 20px |
| 基础边框 | 1px、`border-nexus-border` |
| pane、紧凑控件 | `rounded` / 4px |
| 普通按钮、输入框 | `rounded-md` / 6px 或 `rounded-lg` / 8px |
| 对话框 | `rounded-xl` / 12px |
| 底部抽屉 | `rounded-t-xl` |
| 状态点、FAB | `rounded-full` |

常驻工作区以边框分层；菜单、对话框和 FAB 使用阴影。常见遮罩是 `bg-black/70`，会话抽屉为 `bg-black/50`。大对话框已有 `0 20px 60px rgba(0,0,0,0.5)` 阴影，但阴影尚未集中为 token。

来源：[设置面板](frontend/src/GeneralSettings.tsx)、[桌面侧栏](frontend/src/terminal/DesktopSidebar.tsx)、[移动抽屉](frontend/src/terminal/MobileSessionDrawer.tsx)。

## 5. 布局与响应式

### 5.1 主界面

| 项目 | 桌面：宽度 ≥ 768px | 移动：宽度 < 768px |
| --- | --- | --- |
| 主结构 | 左侧栏 + 右侧分屏工作区 | 单终端 + 底部工具栏 + 悬浮入口 |
| 通道导航 | 展开侧栏或折叠图标轨道 | 会话管理面板及抽屉入口 |
| 终端布局 | 单窗、左右双窗、上下双窗、2×2、3×3 | 当前单终端 |
| 辅助功能 | 侧栏工具区、pane 标题栏 | 工具栏、更多菜单、FAB |

桌面侧栏展开宽 350px，折叠宽 48px；折叠轨道常用 48×40px 按钮。分屏工作区顶部栏高 52px，底部状态栏高 36px；pane 标题栏高 36px，网格外边距和间距均为 8px。

当前布局通过 Flex/Grid 配合 `min-h-0`、`min-w-0` 和 `overflow-hidden` 限定终端尺寸。页面整体不滚动，列表、编辑区等在各自容器内滚动。

布局名称的实际含义：`vertical` / `V Split` 为左右两列，`horizontal` / `H Split` 为上下两行。切换布局保留隐藏 pane 的数据，以便恢复更多分屏。

来源：[Terminal](frontend/src/Terminal.tsx)、[分屏视图](frontend/src/terminal/SplitWorkspaceView.tsx)、[布局模型](frontend/src/terminal/splitLayoutTypes.ts)。

### 5.2 面板适配

- 设置：宽度不超过 400px，随视口限制最大高度，内容区域独立滚动。
- 提示词库：桌面宽度不超过 980px，高度为 `min(760px, 100dvh - 40px)`，左列表宽 330px；移动端全屏，在列表与编辑器之间切换。
- 文件列表、工作目录浏览器：采用全屏面板。
- 移动会话抽屉：贴底、顶部圆角、最大高度 70vh，列表滚动，底部保留新建操作。
- 会话 FAB 为 52px；启用时的 Codex 历史 FAB 为 48px。位置可拖动并保存，定位时考虑工具栏占用和可视视口。

主终端容器使用 `visualViewport` 高度，缺省为 `100dvh`，以适应移动软键盘。终端内的纵向滚动、横向切换、双指缩放由终端手势逻辑处理；不要给它叠加第二套页面平移或滚动处理。

768px 是主布局边界；640px 的 `sm:` 还用于按钮文案和表单排布，1024px 用于工具栏初始折叠偏好。这些值承担不同职责。

来源：[提示词库](frontend/src/PromptLibrary.tsx)、[文件浏览器](frontend/src/WorkspaceBrowser.tsx)、[FAB](frontend/src/DraggableFab.tsx)、[移动终端运行时](frontend/src/terminal/useTerminalRuntime.ts)。

## 6. 组件与交互惯例

### 6.1 按钮与表单

- 主操作：蓝底白字，通常使用 14px、中等或半粗字重、6–8px 圆角。
- 次操作：透明或主题背景、细边框、主要或次要文字色。
- 危险操作：红色文字或边框；提示词库删除按钮已有淡红 hover 表达。
- 禁用操作：使用真实 `disabled`，并降低不透明度；已有组件使用 40% 或 50%，未统一成单一数值。
- 输入框：主题背景、边框、正文色；提示词库使用蓝色聚焦边框和弱化的占位文字。
- 异步提交：阻止重复提交，通过按钮文案或邻近状态说明处理进度，失败显示可读错误。

提示词库可作为较完整的面板参考：固定标题、可滚动内容、底部操作、加载／失败／空列表／无搜索结果状态，以及保存反馈。其 `Ctrl/Cmd+S` 保存、`Escape` 取消拖拽或关闭、未保存变更确认是该组件已实现的行为，不能假定所有弹窗均已支持。

原有按钮等级约束继续适用：每个局部区域最多一个 primary，同一行不能出现两个竞争性的主操作；secondary 用于刷新、返回、查看更多等常用次操作，quiet 用于详情、复制路径和轻量切换。danger 必须有显式文案，不能只依赖图标。warning 区域只放 secondary 或 quiet；error 区域才允许 primary 与 secondary 并存。这是设计要求，部分现有组件仍需后续对齐。

### 6.2 选择、焦点与输入目标

- 折叠侧栏当前通道使用激活背景和左侧 3px 蓝色标记。
- 当前 pane 使用蓝色外边框和 1px 内描边；标题栏展示编号、通道名称和连接状态。
- 点击侧栏通道：如果目标已在可见 pane 中，聚焦该 pane；否则替换当前聚焦 pane 的目标。
- 拖拽通道到 pane：绑定该 pane 的目标；空 pane 提供虚线边框、图标和拖入提示。
- pane 的移除按钮清空该 pane 的绑定；不要把它解释为关闭后端通道。
- 提示词“插入当前终端”发送到桌面聚焦 pane 或移动当前终端，不附加 Enter；不可写时提供失败反馈。
- 列表内复制、插入、删除等独立操作需要隔离事件，避免同时触发行选择或将输入传给终端。

来源：[提示词库](frontend/src/PromptLibrary.tsx)、[终端编排](frontend/src/Terminal.tsx)、[分屏选择逻辑](frontend/src/terminal/SplitWorkspaceView.tsx)、[拖入目标](frontend/src/terminal/PaneDropTarget.tsx)。

## 7. 终端专用设计

终端内容与外围 UI 使用不同的文字、光标和 ANSI 色板。修改外壳颜色时需要同时检查 xterm，不能只调整 CSS 背景。

| xterm 项目 | 深色 | 浅色 |
| --- | --- | --- |
| 背景 | `#0f172a` | `#ffffff` |
| 默认文字 | `#e2e8f0` | `#1e293b` |
| 光标 | `#94a3b8` | `#475569` |
| 选区背景 | `#3b82f660` | `#bfdbfe` |
| 选区文字 | `#f1f5f9` | `#1e293b` |

完整 ANSI 色板以 [theme.ts](frontend/src/terminal/theme.ts) 为准。

- 单终端默认字号 16px，读取 `nexus_font_size` 偏好；移动双指缩放限制为 8–32px。
- 桌面一般 pane 字号上限为 15px，3×3 紧凑布局上限为 12px；更小的已存偏好仍会保留。
- 两种终端初始化均启用闪烁光标，并配置 10,000 行 scrollback。
- 分屏终端容器内部使用水平 8px、垂直 4px 留白；xterm 额外保留右侧 18px 空间，防止滚动条覆盖末列。
- 深色主题对 ANSI 255 背景及部分反色组合有专门兼容样式，以避免 TUI 输入区出现刺眼白底或浅字浅底。
- 连接／重连错误放在终端外围状态 UI 中，不向 PTY 输出插入 Nexus 的状态文字。
- 历史浏览与应用滚动区分处理；界面提供“自动滚动”和“应用滚动 (SGR)”选择，临时选择在切换目标或刷新后重置。
- 用户向上查看历史时显示回到底部入口；“选字复制”提供独立文本覆盖层。

来源：[全局终端样式](frontend/src/index.css)、[单终端运行时](frontend/src/terminal/useTerminalRuntime.ts)、[pane 运行时](frontend/src/terminal/useTerminalPaneRuntime.ts)、[滚动选择器](frontend/src/terminal/TerminalScrollModeSelect.tsx)、[终端架构约束](docs/ARCHITECTURE.md)。

## 8. 状态与反馈

通道活动状态与 pane 连接状态是两套信息，不应合并为同一个含义。

| 状态类型 | 当前表达 |
| --- | --- |
| 通道最近有输出 `running` | 绿色 `#22c55e` 状态点 |
| 通道等待输入 `waiting` | 橙色 `#f59e0b` 状态点 |
| Shell 提示符 `shell` | 灰色 `#94a3b8` 状态点 |
| 未知或断开 `unknown` | 暗灰 `#475569` 状态点 |
| pane 检查中／连接中 | warning 颜色 + 状态文字 |
| pane 已连接 `live` | success 颜色 + “运行中”文字 |
| pane 错误／目标失效 | error 颜色 + 错误或失效说明 |
| 布局加载／保存／未保存 | 明确的文字状态；已保存用 success，其他状态用 warning |

通道活动由近期输出、空闲时间和提示符特征推断，属于界面提示，不是任务结果保证。失效 pane 提供说明及恢复操作；空状态给出下一步入口。成功提示使用轻量反馈，错误应保留在用户能看见的位置。

来源：[通道状态](frontend/src/windowStatus.ts)、[pane 状态栏](frontend/src/terminal/PaneHeader.tsx)、[pane 错误界面](frontend/src/terminal/TerminalPane.tsx)、[终端视口](frontend/src/terminal/TerminalViewport.tsx)。

原有状态约束继续适用：

- `loading` 保留界面骨架，避免整屏抖动。
- `empty` 说明当前范围内没有内容，并提供一个主动作。
- `warning` 不阻塞列表或主内容的继续使用。
- `error` 仅阻塞失败区域，保留上下文标题，并提供恢复动作。
- `success` 默认少提示，不主动弹出庆祝式通知。

## 9. 覆盖层与动效

当前 z-index 分散在各组件中。下表是定位层叠问题的现状索引，数值必须结合父级 stacking context 判断，不是新的全局层级枚举。

| 代表性内容 | 当前 z-index |
| --- | --- |
| 设置、默认新建窗口对话框 | 100 |
| 上传通知 | 200 |
| Profile 引导、部分菜单遮罩 | 300 |
| Codex 历史 FAB／会话 FAB | 349／350 |
| 移动会话抽屉遮罩／内容 | 400／401 |
| 文件面板、工作区浏览器 | 450 |
| 提示词库 | 460 |
| 文本复制覆盖层、上传冲突、欢迎引导 | 500 |
| 粘贴框遮罩／内容 | 700／701 |
| 短时触摸事件屏障 `GhostShield` | 9999 |

`GhostShield` 挂载到 `document.body`，默认拦截 350ms 指针事件，防止打开面板后兼容鼠标事件误触。`useOverlayGuard` 可在覆盖层打开时将 xterm 输入设为只读，并在关闭后延迟恢复。新增终端上层面板需要检查现有接入点、焦点与事件隔离。

动效以局部颜色变化和状态提示为主。Tailwind 定义了 1s 线性旋转、2s 脉冲、0.2s 淡入上移 10px 的 `slide-up`；这些是可用动画定义，不表示所有面板均使用。部分按钮使用 `active:scale-95`。

来源：[覆盖层装配](frontend/src/terminal/TerminalModalStack.tsx)、[事件屏障](frontend/src/GhostShield.tsx)、[输入保护](frontend/src/useOverlayGuard.ts)、[工具栏](frontend/src/Toolbar.tsx)、[动画配置](frontend/tailwind.config.js)。

## 10. 文案与可访问性

当前国际化支持 `zh-CN`、`en`，按本地 `nexus_language`、浏览器语言的顺序检测，回退语言为英语。新增文案应通过 `t()` 和两份语言文件维护。

用户界面优先使用“项目”“通道”“工作区”“终端”等已有术语。技术标识、路径和命令保持原样。主要操作使用具体动词，例如“复制”“插入当前终端”“保存”，错误说明要交代操作失败及可行的下一步。

标题优先交代范围和对象，例如 `Codex 历史会话 · <Project>`。warning 和 error 文案先说明本次发生了什么，再说明影响范围，避免让局部失败看起来像整个系统失效；避免“资源异常”“状态错误”等缺少具体信息的措辞。

新增组件的最低要求是：可用键盘操作、聚焦可见、纯图标按钮有可访问名称，禁用状态具备语义；对话框提供名称和 dialog 语义，提示根据紧急程度使用 `status` 或 `alert`。这些要求参考现有较完整组件，当前全站覆盖情况见下一节。

来源：[语言初始化](frontend/src/i18n/index.ts)、[中文文案](frontend/src/locales/zh-CN/translation.json)、[英文文案](frontend/src/locales/en/translation.json)、[提示词库语义](frontend/src/PromptLibrary.tsx)。

## 11. 已知差异与待统一项

本次只整理文档，以下差异没有在代码中修改，不应作为新组件的默认范式复制。

1. **背景类名不一致**：Tailwind 定义的是 `bg-nexus-bg-2`，部分分屏组件仍写作 `bg-nexus-bg2`。新增代码以配置中的名称为准。
2. **主题值有多个维护点**：`index.css` 与 `applyNexusCssVars()` 重复保存外壳色板；入口 HTML 的内联背景和初始 `theme-color` 仍为旧值 `#1a1a2e`。登录页尚未挂载 `Terminal` 的主题切换逻辑，不能认为登录前后主题初始化完全一致。
3. **部分状态使用固定色阶**：pane 错误浮层、拖入高亮和设置反馈仍含固定 red/cyan/green/yellow 类；通道状态点也使用固定颜色。其双主题表现需要分别检查。
4. **尺寸、阴影、层级尚未 token 化**：按钮禁用透明度、图标尺寸、圆角和 z-index 存在局部差异。本文记录常见值，不宣称已经全局统一。
5. **国际化尚未覆盖全界面**：pane 标题、分屏布局、部分侧栏标题和移动操作仍有硬编码中英文。
6. **无障碍仍有缺口**：部分按钮仅有 `title`，部分输入框移除了 outline 却没有明确替代焦点样式；不能假定所有弹窗有焦点约束和返回焦点能力。HTML 当前禁用了浏览器缩放，xterm 初始化关闭 `screenReaderMode`；全局样式也没有统一的 reduced-motion 策略。色彩对比度与触摸目标尺寸未在本次做系统验收。

## 12. 使用与维护

新增界面时，先复用语义色、图标和相近组件布局；涉及终端时确认输入目标、焦点和滚动归属。验证至少覆盖深／浅主题、768px 两侧布局、长名称、加载／空／错误／禁用状态，以及受影响的键盘或触摸路径。

- 仅修改本文：核对源码事实、相对链接与 diff，无需重建前端。
- 修改前端源码：至少运行 `npm run build:frontend`；正式运行时服务的是 `frontend/dist/`。
- 修改浏览器终端行为：按项目要求补充 `npm run test:browser`。
- 完整验证入口及其他范围的要求以 [AGENTS.md](AGENTS.md) 为准。

本文汇总视觉和交互设计；运行时机制继续以 [ARCHITECTURE.md](docs/ARCHITECTURE.md)、[code.md](docs/code.md) 及当前源码为准。后续实现改变上述规则时，同步更新对应章节，避免把历史快照当成当前规范。
