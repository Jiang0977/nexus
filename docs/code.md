# Nexus 源码导览

最后更新：2026-07-25

目标：告诉维护者“现在该从哪里读”，同时区分源码层和运行时入口。

## 先知道三件事

1. 真实启动链是 `start.sh -> rust-runtime/target/release/nexus-server`
2. 浏览器运行时 UI 来自 `frontend/dist/`
3. tmux 是默认会话事实源；native backend 是 opt-in/staging，并在 `data/native-sessions/` 保存 registry/scrollback

## 推荐阅读顺序

1. `start.sh`
2. `scripts/nexus-paths.sh`
3. `rust-runtime/src/lib.rs`
4. `rust-runtime/src/bin/nexus-server.rs`
5. `rust-runtime/src/server/mod.rs`
6. `rust-runtime/src/bin/nexus-session-runtime.rs`
7. `rust-runtime/src/bin/nexus_session_runtime/backend.rs`
8. `rust-runtime/src/child_runtime_protocol.rs`
9. `rust-runtime/src/codex_home.rs`
10. `rust-runtime/src/bin/nexus-window-launch-runtime.rs`
11. `rust-runtime/src/bin/nexus-pty-runtime.rs`
12. `rust-runtime/src/bin/nexus-task-runtime.rs`
13. `rust-runtime/src/native_session_registry.rs`
14. `rust-runtime/src/native_session_cli.rs`
15. `rust-runtime/tests/*.rs`

## 根目录里最重要的文件

| 路径 | 作用 |
|---|---|
| `start.sh` | 前台启动入口 |
| `scripts/nexus-paths.sh` | 启动早期修正 Claude / Codex CLI PATH |
| `setup.sh` | Rust 安装器入口 |
| `nexus-run-claude.sh` | Claude shell 启动脚本 |
| `nexus-run-codex.sh` | Codex shell 启动脚本 |
| `frontend/src/` | React 前端源码 |
| `frontend/package.json` | 前端依赖与构建脚本 |
| `frontend/dist/` | vendored 前端静态资源 |
| `public/` | PWA 静态资源 |
| `rust-runtime/src/bin/*.rs` | 运行时与 child runtimes |
| `scripts/nexus-native-pty-service.sh` | native PTY supervisor 守护脚本 |
| `rust-runtime/tests/*.rs` | Rust integration tests |

## Rust 模块地图

### 入口

| 文件 | 作用 |
|---|---|
| `rust-runtime/src/bin/nexus-server.rs` | 薄入口，只负责调用 `nexus_rust_runtime::server::run()` |
| `rust-runtime/src/lib.rs` | 共享 helper 出口 |

### server 内部模块

| 文件 | 作用 |
|---|---|
| `rust-runtime/src/server/mod.rs` | server 入口、router 装配、服务生命周期 |
| `rust-runtime/src/server/runtime.rs` | server 共享核心：`AppState`、managed runtimes、DTO、通用 helper |
| `rust-runtime/src/server/tasks.rs` | task / SSE 相关 handler |
| `rust-runtime/src/server/telegram.rs` | Telegram setup / webhook |
| `rust-runtime/src/server/config.rs` | 配置、profile、feature config |
| `rust-runtime/src/server/layouts.rs` | PC split-view active layout API 与持久化 |
| `rust-runtime/src/server/prompts.rs` | 提示词库鉴权 CRUD/排序、校验、锁与原子 JSON 持久化 |
| `rust-runtime/src/server/workspace.rs` | workspace / file system handler |
| `rust-runtime/src/server/version.rs` | 版本与更新检查 |
| `rust-runtime/src/server/session_ws.rs` | session / channel / websocket 入口；服务端心跳与关闭握手 |

### 共享逻辑

| 文件 | 作用 |
|---|---|
| `rust-runtime/src/runtime_config.rs` | 运行时配置解析 |
| `rust-runtime/src/path_utils.rs` | 路径与静态文件保护 |
| `rust-runtime/src/shell.rs` | shell 类型和命令规划 |
| `rust-runtime/src/project_defaults.rs` | 默认 shell / profile 持久化 |
| `rust-runtime/src/sanitize.rs` | 字符串与文件名清洗 |
| `rust-runtime/src/auth.rs` | JWT helper |
| `rust-runtime/src/codex_home.rs` | Codex runtime HOME 规整、导入、物化与共享状态单一事实源 |
| `rust-runtime/src/child_runtime_protocol.rs` | stdio / Unix socket 共用的 JSON-line codec、envelope 与 writer lifecycle |
| `rust-runtime/src/native_session_registry.rs` | native project/channel/process/metadata SQLite registry |
| `rust-runtime/src/native_session_cli.rs` | `nexus-native-session list/attach` |

### runtimes

| 文件 | 作用 |
|---|---|
| `rust-runtime/src/bin/nexus-session-runtime.rs` | project / channel / session / Codex 历史 request dispatch |
| `rust-runtime/src/bin/nexus_session_runtime/backend.rs` | catalog / lifecycle / cleanup capability port factory |
| `rust-runtime/src/bin/nexus_session_runtime/backend/*.rs` | tmux/native adapter、local fake contract tests 与进程清理内部实现 |
| `rust-runtime/src/bin/nexus-window-launch-runtime.rs` | 新建窗口和 shell 领域 dispatch；复用共享 wire protocol |
| `rust-runtime/src/bin/nexus-pty-runtime.rs` | PTY attach / output / broker 薄入口；默认 tmux，native 模式走 Rust PTY/supervisor |
| `rust-runtime/src/bin/nexus-task-runtime.rs` | task 领域 dispatch；复用共享 wire protocol |
| `rust-runtime/src/bin/nexus-codex-home.rs` | Codex 隔离 HOME CLI；委托共享 `codex_home` module |
| `rust-runtime/src/bin/nexus-setup.rs` | `.env` + systemd + tmux bootstrap |
| `rust-runtime/src/bin/nexus-native-pty-supervisor.rs` | native backend 的持久 PTY supervisor |
| `rust-runtime/src/bin/nexus-native-session.rs` | 宿主机终端 attach native session 的 CLI |

## 当前前端现实

当前仓库同时有前端源码层和编译产物：

| 路径 | 作用 |
|---|---|
| `frontend/index.html` | Vite 入口 |
| `frontend/src/*` | React / TS 源码 |
| `frontend/package.json` | 构建与依赖定义 |
| `frontend/vite.config.ts` | Vite 配置 |
| `frontend/dist/index.html` | 单页入口 |
| `frontend/dist/assets/*` | JS/CSS bundle |
| `public/icon.svg` | 图标 |
| `public/manifest.json` | PWA manifest |
| `public/sw.js` | Service worker |

运行时仍然只使用：

- `frontend/dist/*`
- `public/*`

前端主入口当前推荐阅读顺序：

1. `frontend/src/Terminal.tsx`
2. `frontend/src/terminal/TerminalModalStack.tsx`
3. `frontend/src/PromptLibrary.tsx`
4. `frontend/src/promptLibrary/api.ts`
5. `frontend/src/terminal/terminalConnection.ts`
6. `frontend/src/terminal/terminalApplicationScroll.ts`
7. `frontend/src/terminal/useTerminalRuntime.ts`
8. `frontend/src/terminal/useTerminalPaneRuntime.ts`
9. `frontend/src/terminal/useTerminalSessions.ts`
10. `frontend/src/terminal/useTerminalArtifacts.ts`
11. `frontend/src/terminal/DesktopSidebar.tsx`
12. `frontend/src/terminal/MobileSessionDrawer.tsx`

这样读能更快看清：

- `Terminal.tsx` 只负责顶层装配
- WebSocket URL / resize / reconnect / close policy 集中在 `terminalConnection.ts`
- Grok 全屏 TUI 的明确版本/终端标题识别和 SGR wheel 编码集中在 `terminalApplicationScroll.ts`；通用 synchronized-update 输出仍走 xterm scrollback
- runtime hooks 只装配 xterm、交互和连接状态 adapter
- session / window 状态下沉到 sessions hook
- scrollback / upload / 通知下沉到 artifacts hook
- 提示词库通过 `TerminalModalStack` 懒加载；编辑时阻止 xterm 输入，插入时复用当前 focused pane / mobile terminal 的 `sendToWs` 且不追加回车

## 最重要的调用链

### 打开首页

1. 浏览器请求 `/`
2. `nexus-server` 返回 `frontend/dist/index.html`
3. 浏览器继续加载 `frontend/dist/assets/*`
4. 页面通过 REST / WS 连接 Rust server

### 终端 attach

1. 浏览器建 WebSocket 到 `/ws`
2. `terminalConnection.ts` 负责连接、首帧 resize、retry 与 fatal close-code policy
3. `session_ws.rs` 默认每 10 秒发送 Ping，并处理浏览器 Close 握手
4. `nexus-server` 把请求转给 `nexus-pty-runtime`
5. PTY runtime attach 到目标 project/channel
6. tmux backend 下连接 `tmux session:window`；native backend 下连接 Rust PTY/supervisor
7. stdio child 与 supervisor socket 都使用 `child_runtime_protocol` 的 JSON-line contract
8. 浏览器和后端 PTY 双向 I/O；全屏 TUI 的滚轮或触摸滑动可由 `terminalApplicationScroll.ts` 编码回应用

### 新建 project / channel

1. 浏览器调 `/api/projects` 或 `/api/sessions`
2. `nexus-server` 协调 `nexus-session-runtime` / `nexus-window-launch-runtime`
3. session runtime 通过 catalog / lifecycle / cleanup capability port 调用 factory 选出的 adapter
4. 默认 factory 选择 tmux；仅 `NEXUS_SESSION_BACKEND=native` 时选择 native registry/process adapter
5. 浏览器刷新列表

### 管理并插入提示词

1. 桌面收起侧栏、桌面展开侧栏底部工具栏或移动端更多菜单打开提示词库
2. 浏览器通过鉴权 `/api/prompt-library` GET/POST/PUT/DELETE 管理全局提示词，并通过 `PUT /api/prompt-library/order` 携带期望基线、原子保存完整排序
3. `prompts.rs` 在同一锁内读取、校验、修改并原子替换 `data/prompts.json`；损坏文件拒绝所有写入
4. 点击“插入当前终端”时，桌面发送到 focused pane，移动端发送到当前终端；连接不可写时显示失败，不额外发送 `Enter`

## 验证入口

```bash
npm run check
```

如果改动启动链或安装器，再额外跑：

```bash
cargo build --manifest-path rust-runtime/Cargo.toml --release --bin nexus-server --bin nexus-task-runtime --bin nexus-pty-runtime --bin nexus-native-pty-supervisor --bin nexus-native-session --bin nexus-window-launch-runtime --bin nexus-session-runtime --bin nexus-codex-home --bin nexus-setup
```

## 别再踩的坑

- 不要把 `frontend/src/` 当线上入口，线上仍只服务 `frontend/dist/`
- 不要忽略 `scripts/nexus-paths.sh`；`start.sh` 和 `scripts/nexus-tmux-service.sh` 都会先经过它修正 agent CLI 路径
- 不要把 `pm2` 当成有效运维入口
- 不要把 `native` 写成默认生产路径；它仍是 opt-in/staging
- 不要把 `data/` 当通用业务数据库；native registry 是受限 session metadata
- 不要把“零 Node 仓库”的旧文档当当前事实
