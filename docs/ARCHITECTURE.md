# Nexus Architecture

最后更新：2026-07-25

目标：给维护者一个当前真实可运行的结构图，不保留已经删除的 Node/npm/PM2 叙事，也不把 tmux-only 的旧边界误当成当前事实。

## 当前运行形态

```text
Browser / PWA
  ↕ WebSocket / REST
Rust server (nexus-server)
  ↕ Rust child runtimes
Session backend
  ├─ tmux session:window        default / stable
  └─ native Rust PTY registry   opt-in / staging
  ↕ shell / claude / codex
```

后端选择：

- 默认是 `tmux`，生产路径仍按 `nexus-tmux.service` 持久化 session。
- `native` 已有 opt-in 路径：`NEXUS_SESSION_BACKEND=native`、`nexus-native-pty-supervisor`、SQLite native session registry、native scrollback、`nexus-native-session` CLI attach。
- `native` 仍在收敛阶段，不是默认生产路径；文档、发布和回滚都必须保留 tmux 回退路径。

静态资源与前端源码的当前现实：

- Rust server 直接伺服 `frontend/dist/` 和 `public/`
- `frontend/dist/` 是 vendored 静态 bundle
- 仓库重新携带 `frontend/src/`、`frontend/package.json`、Vite/Tailwind 配置
- 运行时仍只依赖构建产物 `frontend/dist/`

## 启动链

### 前台启动

```text
bash start.sh
  -> 检查 .env
  -> 检查 frontend/dist/index.html
  -> 必要时补齐 Claude / Codex CLI 所在 PATH
  -> 必要时补构建缺失的 Rust release binaries
  -> 启动 rust-runtime/target/release/nexus-server
```

### 安装器路径

```text
./setup.sh
  -> cargo run --bin nexus-setup --release
  -> 写入 systemd user units
  -> 启动 nexus-tmux.service
  -> 启动 nexus-native-pty.service（未启用 native backend 时保持空闲轮询）
  -> 启动 nexus.service
  -> 安装 ~/.local/bin/nexus-native-session symlink
```

### 关键约束

- `start.sh` 不会重建前端静态资源
- `start.sh` 与 `scripts/nexus-tmux-service.sh` 会在运行时补齐 agent CLI PATH，但不会安装缺失的 CLI
- Rust 代码改动后要先显式 `cargo build --release`
- 前端代码改动后要在 `frontend/` 下显式构建
- `frontend/dist/` 缺失时服务直接失败
- 切换 session backend 需要重启 `nexus`，因为 child runtimes 启动时读取 `NEXUS_SESSION_BACKEND`

## Rust 模块边界

### 入口与装配

| 文件 | 作用 |
|---|---|
| `rust-runtime/src/bin/nexus-server.rs` | 薄入口，只负责调用 `nexus_rust_runtime::server::run()` |
| `rust-runtime/src/lib.rs` | 共享模块出口 |

### Rust server 内部模块

| 路径 | 作用 |
|---|---|
| `rust-runtime/src/server/mod.rs` | server 入口、router 装配、服务启动与 graceful shutdown |
| `rust-runtime/src/server/runtime.rs` | server 共享核心：`AppState`、managed runtimes、请求 DTO 与通用 helper |
| `rust-runtime/src/server/config.rs` | 配置读取、profile / feature config 入口 |
| `rust-runtime/src/server/layouts.rs` | PC split-view active layout API 与 `data/workspace-layouts.json` 持久化 |
| `rust-runtime/src/server/prompts.rs` | 单用户提示词库的鉴权 CRUD/排序、校验、并发锁与 `data/prompts.json` 原子持久化 |
| `rust-runtime/src/server/workspace.rs` | workspace / 文件系统相关 handler |
| `rust-runtime/src/server/version.rs` | 版本与更新检查 |
| `rust-runtime/src/server/session_ws.rs` | project / channel / websocket 入口；默认映射到 tmux，native 模式走 Rust PTY runtime；负责服务端心跳和关闭握手 |

### 共享逻辑

| 文件 | 作用 |
|---|---|
| `rust-runtime/src/runtime_config.rs` | `.env`、可执行路径、数据目录解析 |
| `rust-runtime/src/path_utils.rs` | 路径规整、静态文件保护、递归复制/删除 |
| `rust-runtime/src/shell.rs` | shell 类型与命令规划 |
| `rust-runtime/src/project_defaults.rs` | 默认 shell / profile 持久化 |
| `rust-runtime/src/sanitize.rs` | 文件名、窗口名、用户输入清洗 |
| `rust-runtime/src/auth.rs` | JWT 校验 |
| `rust-runtime/src/codex_home.rs` | Codex runtime HOME 的配置规整、global import、trust/auth 生成、共享状态链接与物化单一事实源 |
| `rust-runtime/src/child_runtime_protocol.rs` | transport-neutral JSON-line request/notify/response/event contract、writer lifecycle；同时服务 stdio child runtime 与 native supervisor socket |

### Child runtimes

| 文件 | 作用 |
|---|---|
| `rust-runtime/src/bin/nexus-session-runtime.rs` | projects / channels / sessions / Codex 历史的 request dispatch |
| `rust-runtime/src/bin/nexus_session_runtime/backend.rs` | session backend capability 装配；按 catalog / lifecycle / cleanup 三个窄 port 选择 adapter |
| `rust-runtime/src/bin/nexus_session_runtime/backend/{catalog,lifecycle,cleanup}.rs` | capability contract 与 tmux/native 两个真实 adapter；contract test 可注入 local fake，不进入 HTTP/JSON interface |
| `rust-runtime/src/bin/nexus_session_runtime/backend/support.rs` | native process/runtime cleanup 等 adapter 内部 helper |
| `rust-runtime/src/bin/nexus-window-launch-runtime.rs` | 新建窗口和 shell 的领域 dispatch；wire contract 复用共享 protocol |
| `rust-runtime/src/bin/nexus-pty-runtime.rs` | PTY attach / output / broker 的薄入口 |
| `rust-runtime/src/bin/nexus-codex-home.rs` | Codex 隔离 HOME CLI；实际物化委托给共享 `codex_home` module |
| `rust-runtime/src/bin/nexus-setup.rs` | `.env` + systemd user units + tmux bootstrap |
| `rust-runtime/src/bin/nexus-native-pty-supervisor.rs` | native backend 的持久 PTY supervisor |
| `rust-runtime/src/bin/nexus-native-session.rs` | 从宿主机终端列出/attach native session 的 CLI |

### Native session 支撑模块

| 文件 | 作用 |
|---|---|
| `rust-runtime/src/native_session_registry.rs` | SQLite native project/channel/process/metadata registry，默认落到 `data/native-sessions/session.db` |
| `rust-runtime/src/native_session_cli.rs` | `nexus-native-session list/attach` CLI 实现 |
| `rust-runtime/src/pty_runtime.rs` | `NEXUS_SESSION_BACKEND` selector、native supervisor client、native scrollback、PTY 生命周期；stdio 与 Unix socket 共用 `child_runtime_protocol` envelope/writer |
| `scripts/nexus-native-pty-service.sh` | 根据 `.env` 或 `data/session-backend.json` 等配置决定是否 exec supervisor |

## 静态资源与前端

当前仓库的前端相关路径：

| 路径 | 作用 |
|---|---|
| `frontend/index.html` | Vite 开发入口 |
| `frontend/src/*` | React 前端源码 |
| `frontend/package.json` | 前端依赖与构建脚本 |
| `frontend/vite.config.ts` | Vite 构建配置 |
| `frontend/tailwind.config.js` | Tailwind 主题配置 |
| `frontend/dist/index.html` | 单页入口 |
| `frontend/dist/assets/*` | vendored JS/CSS bundle |
| `public/manifest.json` | PWA manifest |
| `public/icon.svg` | 图标 |
| `public/sw.js` | Service worker |

前端工作流：

- 开发入口在 `frontend/src/`
- 构建命令由 `frontend/package.json` 提供
- 构建输出仍落到 `frontend/dist/`
- Rust server 不关心源码层，只关心 `frontend/dist/`

当前前端主入口已从“单大组件”继续收口为“入口编排 + hook / 子视图”结构：

| 路径 | 作用 |
|---|---|
| `frontend/src/main.tsx` | 应用挂载入口，并在页面 load 事件触发时注册 `/sw.js` Service Worker |
| `frontend/src/WorkspaceBrowser.tsx` | 工作区文件管理：文件树、编辑、上传与管理；文件查看/下载使用 Authorization Bearer fetch 与 Blob URL，JWT 不进入 URL query |
| `frontend/src/Terminal.tsx` | 顶层编排：overlay、drawer、sidebar、toolbar、lazy 面板装配 |
| `frontend/src/PromptLibrary.tsx` | 提示词库列表/编辑器、搜索、拖拽排序、复制、列表直插当前终端、脏状态与响应式交互 |
| `frontend/src/promptLibrary/api.ts` | 提示词库鉴权 REST client、类型与前后端共享长度边界 |
| `frontend/src/terminal/terminalConnection.ts` | 浏览器终端连接 port：URL、open/resize、data/autoscroll、close-code、retry/backoff 与 cleanup；production WebSocket 和测试 fake 共用 contract |
| `frontend/src/terminal/terminalApplicationScroll.ts` | 通用临时滚动模式与 SGR wheel 编码；不按应用名称或标题推断能力 |
| `frontend/src/terminal/useTerminalScrollMode.ts` | 每个视图独立保存临时滚动选择；同目标重连保留，切换目标或刷新恢复自动 |
| `frontend/src/terminal/useTerminalRuntime.ts` | 单窗 xterm、输入代理与移动端键盘行为；通过 adapter 投影连接状态 |
| `frontend/src/terminal/useTerminalPaneRuntime.ts` | PC split-view pane 的 xterm/状态 adapter；共享 terminal connection policy |
| `frontend/src/terminal/useTerminalSessions.ts` | tmux session/window 列表、切换、创建、轮询状态 |
| `frontend/src/terminal/useTerminalArtifacts.ts` | scrollback、上传、通知、文件冲突处理 |
| `frontend/src/terminal/DesktopSidebar.tsx` | 桌面端 session/sidebar 壳层 |
| `frontend/src/terminal/MobileSessionDrawer.tsx` | 移动端 session drawer 壳层 |
| `frontend/src/terminal/SplitWorkspaceView.tsx` | PC 右侧主工作区 split-view 编排、layout toolbar、状态条 |
| `frontend/src/terminal/TerminalPane.tsx` | 单个 split pane：header、drop target、empty/stale/error/loading/live 状态 |
| `frontend/src/terminal/useWorkspaceLayout.ts` | active layout GET/PUT、前端 normalize、保存状态 |

终端连接与应用内滚动的关键语义：

- `session_ws.rs` 默认每 10 秒发送 WebSocket Ping；`NEXUS_WS_HEARTBEAT_MS` 可改为其他正数，无效值回退到默认值。
- 浏览器关闭连接时，server 参与标准关闭握手；非预期断开由 `terminalConnection.ts` 走指数退避重连，最多 8 次。
- xterm 6 的历史位置以公开的 `buffer.active.viewportY/baseY` 为准，不读取旧 `.xterm-viewport.scrollTop`。移动端纵向拖动由单一手势处理器调用 `scrollLines`，禁止浏览器同时 pan；pinch 与横向切换仍由终端手势处理器负责。标准 mouse tracking 开启时，触摸转换为 wheel 事件交给 xterm 按已协商协议编码；关闭后恢复普通历史滚动。
- `terminalInput.ts` 在单窗和 split pane 同时绑定 `onData` 与 `onBinary`，二进制输入经 WebSocket Binary → broker `rawBytes` → PTY 原样写入；旧 `rawMessage` 字段仍兼容。PTY 输出使用每个 reader 独立的增量 UTF-8 解码器，跨 read 的半个字符不会被提前替换。
- tmux 每个浏览器连接独占一个 client PTY/grouped session，共享原窗口中的应用进程；首次 attach 带真实尺寸，reader 启动前注册 client，禁止尾片段 replay。窗口级 snapshot 聚合连接数，断开只回收自己的 client/group。共享 pane 逻辑尺寸仍由 tmux window-size 策略决定。native 保留旧生命周期与 replay，完整恢复尚未实现。
- 新网页声明 `terminalProtocol=2`；tmux attach 返回 `replayPolicy=tmux-redraw` 时，server 在所有文本前发版本 1 的二进制 `terminal-state` JSON。浏览器排队写 RIS 再接收 tmux 完整重绘；文本 JSON 不作为控制帧。未知控制失败关闭；广播 lag 关闭 1013、client EOF 关闭 1011，清理后重连获取新重绘。旧客户端和 native 不接收新控制帧。
- 连接错误显示在终端外的状态 UI 中，不向 PTY 内容插入 Nexus 状态 ANSI；旧 socket、定时器与写入回调在连接替换/销毁后不再更新当前界面。初次 resize 发送真实行列，不再使用临时少一行的尺寸。
- xterm scrollback 只负责普通终端历史。默认“自动滚动”只遵循公开终端模式，不依据 Grok 等标题、正文、2026 或 alternate screen 猜测应用能力。没有标准鼠标模式的 TUI 可在当前视图临时选择“应用滚动 (SGR)”，把滚轮或手机纵向滑动编码后发回应用；退出该应用后应切回自动，避免把鼠标输入送入普通 shell。
- 标准鼠标模式始终优先，避免手动补偿重复发包；Ctrl+wheel 不作为应用输入。临时选择不触发重连，不跨 pane 共享；同目标断线重连保留，切换目标或刷新重置。私有 capability/launch profile 仍未实现。

## 数据落点

默认数据目录：`data/`

| 路径 | 内容 |
|---|---|
| `data/toolbar-config.json` | 工具栏配置 |
| `data/project-shell-defaults.json` | 项目默认 shell / profile |
| `data/workspace-layouts.json` | PC split-view active layout；坏文件/非法内容 fail-open 到默认 single |
| `data/prompts.json` | 全局单用户提示词库；坏文件 fail-closed，所有修改使用锁和临时文件原子替换 |
| `data/session-backend.json` | UI 保存的目标 session backend；`tmux` 或 `native` |
| `data/configs/` | Claude profile |
| `data/codex-configs/` | Codex profile |
| `data/uploads/` | 上传文件 |
| `data/codex-runtime/` | Codex profile channel 的隔离 HOME；`.codex/skills` 等共享状态应链接回真实 `~/.codex` |
| `data/native-sessions/session.db` | native backend project/channel/process registry |
| `data/native-sessions/supervisor.sock` | native PTY supervisor Unix socket |
| `data/native-sessions/scrollback/` | native backend 有界 scrollback |

事实源说明：

- tmux 是默认 backend 的交互会话事实源
- native 模式下 `data/native-sessions/session.db` 是 native project/channel/process metadata 事实源
- `~/.codex` 是共享 Codex 历史与 skills 事实源
- `nexus-codex-home` 负责物化 Codex 隔离 HOME；部署链必须构建它，否则 profile channel 可能拿到旧的 `.codex` 物化逻辑
- `data/` 主要保存配置与本地状态；只有 native backend 引入了受限的 SQLite registry，不要把它扩张成通用业务数据库
- `data/prompts.json` 是供交互式终端复用的提示词库；正文插入当前终端时不会额外发送回车

## 运维现实

默认守护方式是 `systemd`，不是 PM2。

相关文件：

| 文件 | 说明 |
|---|---|
| `start.sh` | 前台启动入口 |
| `setup.sh` | 安装器入口 |
| `scripts/nexus-paths.sh` | 运行时补齐 Claude / Codex CLI PATH |
| `scripts/nexus-tmux-service.sh` | tmux 守护脚本 |
| `scripts/nexus-native-pty-service.sh` | native PTY supervisor 守护脚本；仅在 backend 为 native 时 exec supervisor |
| `deploy/systemd/nexus.service` | systemd 服务样例 |
| `deploy/systemd/nexus-tmux.service` | tmux 服务样例 |
| `deploy/systemd/nexus-native-pty.service` | native PTY supervisor 服务样例 |

## 验证面

当前权威验证路径：

```bash
npm run check
```

重点覆盖：

- 根脚本、CI、frontend dist 漂移保护
- `nexus-setup` 不再依赖 Node/PM2
- `start.sh` 对 vendored frontend bundle 的行为
- `frontend/dist/` 资源完整性 smoke
- native PTY runtime / supervisor / CLI 的 binary-level 回归
- session catalog/lifecycle/cleanup capability 的 local fake contract tests，以及 tmux/native binary parity
- stdio 与 Unix supervisor socket 共用的 JSON-line codec/writer contract
- terminal connection fake WebSocket contract 与 browser regression

默认值真相源：

- `PORT=59000`
- `GITHUB_REPO=Jiang0977/nexus`

## 不要再做的事

- 不要把 PM2 重新带回默认运行链
- 不要把前端源码误当成运行时入口，线上仍靠 `frontend/dist/`
- 不要把过时文档里的 `npm run setup` / `pm2 start` 当成有效指令
- 不要把 `native` 写成默认生产 backend；当前仍是 opt-in/staging
- 不要在 native 模式出问题时删除 tmux 回退路径
