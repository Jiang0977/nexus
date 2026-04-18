# ARCHITECTURE — Nexus 架构现状

**Last Updated**: 2026-04-16  **Version**: v4.4.2  **锚点**: [NORTH-STAR.md](NORTH-STAR.md)

---

## 系统边界

Nexus 是一个单用户、自托管、tmux 驱动的 Claude Code 工作台。

它解决的是：

- 浏览器 / 手机 / Telegram 如何进入同一套 AI 工作现场
- 终端交互链和异步任务链如何并存
- 项目 / 频道 / Codex 历史如何围绕“当前工作区”组织

它明确不解决：

- 多用户 / 团队协作
- 替换 tmux
- 引入数据库
- 通用 Web SSH

---

## 系统概览

```text
Browser / PWA
  ↕ WebSocket /ws?token=<jwt>&session=<name>&window=<index>
  ↕ HTTPS /api/*

Nexus Server (Rust `nexus-server` runtime entry)
  ↕ Rust child runtimes
  ↕ local FS / Git / Telegram API

tmux session:window
  ↕ interactive shell / claude / codex

Optional:
- Telegram Bot -> /api/webhooks/telegram -> task runner
- shared ~/.codex -> Codex history discovery / resume
- runtime data dir (`data/` by default; overridable via `NEXUS_DATA_DIR`) -> profiles / toolbar / tasks / project defaults
```

这里有三份“事实源”：

- `tmux`
  - 会话、窗口、cwd、当前活跃窗口
- runtime data dir (`data/` by default；可用 `NEXUS_DATA_DIR` 改到独立目录)
  - 配置和任务历史
- 共享 `~/.codex`
  - Codex 历史会话来源

---

## 核心架构决策

### 1. tmux 是会话事实源

- 浏览器不会自己持久化终端状态
- 关闭页面后，tmux 和 Agent 继续运行
- 重新进入时，通过 tmux attach 恢复

### 2. 后端是“Rust 入口 + child runtimes + 共享 lib helper”

- `rust-runtime/src/bin/nexus-server.rs` 现在是默认 runtime entry
- `rust-runtime/src/lib.rs` 承载共享的 config / path / shell / defaults / sanitize helper
- tmux / task / pty / window launch 等较厚语义继续下沉到 Rust child runtimes
- 目前路由 handler 仍然主要集中在 `nexus-server.rs`，但纯逻辑已经开始从入口文件外移

### 3. 无数据库

- 当前持久化继续使用运行时数据目录里的 JSON 文件；默认是 `data/`，可用 `NEXUS_DATA_DIR` 改到独立目录
- 这样能保持部署简单，也符合单用户场景

### 4. 交互链与任务链分离

- 交互链：
  - 浏览器 ↔ WebSocket ↔ PTY broker ↔ tmux
- 任务链：
  - `/api/tasks` / Telegram ↔ task runner ↔ `claude -p`

### 5. 当前工作区优先

- Project = tmux session
- Channel = tmux window
- Codex 历史属于当前工作区内部能力，而不是全局一级导航

---

## 运行时组成

## 启动链

### 开发

```bash
npm run dev
npm --prefix frontend run dev
```

### 线上

```text
nexus.service
  -> bash start.sh
  -> rust-runtime/target/release/nexus-server
```

`start.sh` 的职责：

1. 确保 `.env` 存在
2. 缺依赖时执行 `npm install`
3. 缺 `frontend/dist` 时构建前端
4. 缺 Rust release binaries 时构建 `nexus-server` / child runtimes
5. 设置 `PORT` 默认值为 `59000`
6. 启动 Rust `nexus-server`

注意：

- `start.sh` 不会在每次重启时自动重建最新产物
- 前端源码改动后，部署前仍需手动跑 `npm --prefix frontend run build`
- 后端源码改动后，部署前仍需手动跑 `npm run build:rust-runtimes` 和 `npm run build:rust-server`

权威上线步骤见 [DEPLOYMENT-RUNBOOK.md](DEPLOYMENT-RUNBOOK.md)。

### Rust runtime entry 的职责

当前 `rust-runtime/src/bin/nexus-server.rs` 是运行时装配器，主要做这些事：

1. 读取 `.env` 与运行时路径
2. 初始化运行时数据目录（默认 `data/`，可被 `NEXUS_DATA_DIR` 覆盖）
3. 启动并管理 Rust child runtimes
4. 注册 HTTP / WebSocket 路由
5. 直接处理本地文件、版本、配置和 Telegram 这些薄服务
6. 执行 graceful shutdown

更厚的 tmux / task / PTY 语义优先继续留在对应 Rust runtime，而不是重新堆回入口。

---

## 后端模块分层

### 运行时 / 装配层

| 文件 | 作用 |
|---|---|
| `rust-runtime/src/bin/nexus-server.rs` | 默认运行时入口、路由注册、runtime 装配 |
| `rust-runtime/src/lib.rs` | 共享 helper 出口，供 `nexus-server` 和后续 runtime 共用 |

### 共享纯逻辑层

| 文件 | 作用 |
|---|---|
| `rust-runtime/src/runtime_config.rs` | `.env` / runtime executable / data dir / proxy vars 解析 |
| `rust-runtime/src/path_utils.rs` | path normalize、静态文件路径保护、递归 copy/remove 等通用路径逻辑 |
| `rust-runtime/src/shell.rs` | shell type、窗口命名、interactive shell command 规划 |
| `rust-runtime/src/project_defaults.rs` | project defaults 读写 |
| `rust-runtime/src/sanitize.rs` | 上传名、窗口名、Telegram 输入、字符串截断等 sanitize helper |
| `rust-runtime/src/auth.rs` | JWT 校验 helper |

### 会话 / 项目 / 窗口层

| 文件 | 作用 |
|---|---|
| `rust-runtime/src/bin/nexus-session-runtime.rs` | sessions、projects、channels、Codex 历史等主语义 |
| `rust-runtime/src/bin/nexus-window-launch-runtime.rs` | 新建项目 / 新建窗口时的 shell 启动和窗口命名 |

### PTY broker 层

| 文件 | 作用 |
|---|---|
| `rust-runtime/src/bin/nexus-pty-runtime.rs` | PTY attach / output / websocket broker 语义 |

### 任务 / Telegram / 上传层

| 文件 | 作用 |
|---|---|
| `rust-runtime/src/bin/nexus-task-runtime.rs` | task 执行协议与 child runtime |

### 脚本 / tooling 辅助层

| 文件 | 作用 |
|---|---|
| `rust-runtime/src/bin/nexus-codex-home.rs` | 物化隔离的 Codex home，合并共享 `.codex` 状态并写 runtime config/auth |
| `rust-runtime/src/bin/nexus-setup.rs` | 安装器；负责 `.env`、依赖安装、frontend build、PM2 和首个 tmux session |
| `nexus-run-codex.sh` | 计算 runtime HOME、按需构建 `nexus-codex-home` 并启动 Codex CLI |

---

## API 面

这里只列当前有用的 API 组，不重复展开每个细节字段。

### Auth

| Method | Path | 说明 |
|---|---|---|
| `POST` | `/api/auth/login` | 密码登录，返回 JWT |

### Sessions / Projects / Codex History

| Method | Path | 说明 |
|---|---|---|
| `POST` | `/api/windows` | 兼容入口：创建窗口（附 profile/cwd） |
| `GET` | `/api/sessions` | 列出指定 tmux session 的窗口 |
| `POST` | `/api/sessions` | 新建窗口 |
| `DELETE` | `/api/sessions/:id` | 关闭窗口 |
| `POST` | `/api/sessions/:id/attach` | 切换窗口 |
| `POST` | `/api/sessions/:id/rename` | 重命名窗口 |
| `GET` | `/api/sessions/:id/output` | 获取窗口输出与状态 |
| `GET` | `/api/sessions/:id/scrollback` | 获取 scrollback |
| `GET` | `/api/session-cwd` | 获取当前 pane 工作目录 |
| `GET` | `/api/tmux-sessions` | 列出 tmux sessions |
| `GET` | `/api/projects` | 列出 project-channel 树 |
| `POST` | `/api/projects` | 创建 project |
| `GET` | `/api/projects/:name/channels` | 列出 channel |
| `POST` | `/api/projects/:name/channels` | 创建 channel |
| `POST` | `/api/projects/:name/activate` | 激活 project |
| `POST` | `/api/projects/:name/rename` | 重命名 project |
| `DELETE` | `/api/projects/:name` | 删除 project |
| `GET` | `/api/codex-sessions` | 列出当前项目下的 Codex 历史 |
| `GET` | `/api/codex-sessions/:id/detail` | 获取最小 detail 白名单字段 |
| `POST` | `/api/codex-sessions/:id/resume` | 恢复历史会话 |
| `DELETE` | `/api/codex-sessions/:id` | 删除历史会话 |

### Workspace / Uploads

| Method | Path | 说明 |
|---|---|---|
| `GET` | `/api/browse` | 浏览工作区目录 |
| `GET` | `/api/workspace/files` | 列目录 |
| `POST` | `/api/workspace/mkdir` | 新建目录 |
| `POST` | `/api/workspace/files` | 新建文件 |
| `GET` | `/api/workspace/file` | 读文件 |
| `PUT` | `/api/workspace/file` | 写文件 |
| `DELETE` | `/api/workspace/entry` | 删除文件/目录 |
| `POST` | `/api/workspace/rename` | 重命名条目 |
| `POST` | `/api/workspace/copy` | 复制条目 |
| `POST` | `/api/workspace/move` | 移动条目 |
| `POST` | `/api/upload` | 上传到当前工作区语境 |
| `POST` | `/api/files/upload` | 上传到托管目录 |
| `GET` | `/api/files` | 列托管上传文件 |
| `DELETE` | `/api/files/:date/:filename` | 删除单个上传文件 |
| `DELETE` | `/api/files/all` | 清空托管上传文件 |

### Config / Version

| Method | Path | 说明 |
|---|---|---|
| `GET` | `/api/config` | 返回前端运行配置 |
| `GET` | `/api/configs` | Claude profile 列表 |
| `POST` | `/api/configs/:id` | 创建/更新 Claude profile |
| `POST` | `/api/configs/:id/sync-current` | 从当前 live 配置同步 |
| `DELETE` | `/api/configs/:id` | 删除 Claude profile |
| `GET` | `/api/codex-configs` | Codex profile 列表 |
| `POST` | `/api/codex-configs/import-global` | 导入 `~/.codex` |
| `POST` | `/api/codex-configs/:id/sync-current` | 同步当前 live Codex 配置 |
| `POST` | `/api/codex-configs/:id/validate` | 活体验证 Codex profile |
| `POST` | `/api/codex-configs/:id` | 创建/更新 Codex profile |
| `DELETE` | `/api/codex-configs/:id` | 删除 Codex profile |
| `GET` | `/api/cc-switch/providers` | 列 provider |
| `POST` | `/api/cc-switch/providers/:kind/:providerId/import` | 导入 provider 配置 |
| `GET` | `/api/project-defaults` | 读取项目默认 shell/profile |
| `GET` | `/api/toolbar-config` | 读取工具栏配置 |
| `POST` | `/api/toolbar-config` | 保存工具栏配置 |
| `GET` | `/api/version` | 当前版本 |
| `GET` | `/api/version/latest` | 最新版本检查 |

### Tasks / Telegram

| Method | Path | 说明 |
|---|---|---|
| `GET` | `/api/tasks` | 最近任务历史 |
| `POST` | `/api/tasks` | 创建异步任务，SSE 返回 |
| `DELETE` | `/api/tasks/:id` | 删除任务记录 |
| `POST` | `/api/webhooks/telegram` | Telegram webhook |
| `GET` | `/api/telegram/setup` | Telegram webhook setup |

### SPA fallback

| Method | Path | 说明 |
|---|---|---|
| `GET` | `*` | 所有非 API 路径返回 `frontend/dist/index.html` |

---

## PTY 与任务执行

## PTY broker

当前不是入口自己维护 PTY 状态，而是：

```text
nexus-server
  -> nexus-pty-runtime
```

核心行为：

- 每个 `session:windowIndex` 对应一个 PTY 连接键
- WebSocket 客户端 attach 到该键
- broker 负责 input / resize / output / close
- 多客户端场景下使用最小终端尺寸策略

## task runner

当前任务链是：

```text
nexus-server
  -> nexus-task-runtime
```

核心行为：

- 任务写入 `data/tasks.json`
- spawn `claude -p`
- Web 端通过 SSE 回流
- Telegram 通过消息编辑回流

---

## 前端架构

## 页面结构

```text
App.tsx
  -> LoginPage (inline)
  -> Terminal.tsx
     -> lazy overlays / panels
```

当前前端没有全局状态库，主要用：

- React state
- refs
- localStorage
- 轮询 + WebSocket

## Terminal.tsx 的角色

`Terminal.tsx` 仍然是前端主编排器，负责：

- xterm 初始化与 theme 应用
- WebSocket 生命周期
- 窗口列表轮询
- 窗口输出状态轮询
- 会话切换与窗口切换
- 移动端交互（触摸、浮动按钮、scrollback、drawer）
- overlay / modal 开关

### 当前主要面板

| 文件 | 说明 |
|---|---|
| `SessionManagerV2.tsx` | Project / Channel 双层会话管理 |
| `SessionManager.tsx` | 旧版配置/设置面板 |
| `CodexSessionsPanel.tsx` | Codex 历史列表与 resume |
| `WorkspaceBrowser.tsx` | 工作区浏览、编辑、复制、移动 |
| `FilePanel.tsx` | 托管上传文件面板 |
| `WorkspaceSelector.tsx` | 新建项目时选目录 |
| `NewWindowDialog.tsx` | 新建 channel / window |
| `GeneralSettings.tsx` | 通用设置 |
| `Toolbar.tsx` | 软键盘和快捷操作 |
| `TabBar.tsx` | 窗口标签 |

### 布局断点

| 条件 | 布局 |
|---|---|
| `>= 768px` | 可折叠 sidebar + terminal + embedded toolbar |
| `< 768px` | terminal + 浮动按钮 + 底部 toolbar + modal/drawer |

### 状态管理

前端当前持久化的主要是：

- `token`
- `theme`
- `font size`
- 当前窗口索引
- 侧边栏折叠态
- 首次引导状态

### 任务 UI 的当前现实

- 后端任务 API 仍然存在
- Telegram 任务流也存在
- 当前 `frontend/src/` 中没有独立的 `TaskPanel.tsx`
- 当前主界面更偏向：
  - 窗口状态点
  - 页面标题状态
  - 上传通知
  - 其他与终端直接相关的 affordance

如果未来恢复独立任务面板，应该先更新本文件和 `docs/code.md`。

---

## 数据落点

当前 `data/` 下至少有这些重要文件 / 目录：

```text
data/
├── toolbar-config.json
├── tasks.json
├── project-shell-defaults.json
├── configs/
├── codex-configs/
├── codex-runtime/
├── codex-validate/
└── uploads/
```

各自含义：

| 路径 | 内容 |
|---|---|
| `toolbar-config.json` | 工具栏布局 |
| `tasks.json` | 任务历史 |
| `project-shell-defaults.json` | 项目默认 shell / profile |
| `configs/` | Claude profile |
| `codex-configs/` | Codex profile |
| `codex-runtime/` | Codex runtime 辅助数据 |
| `codex-validate/` | Codex profile 验证用目录 |
| `uploads/` | 托管上传文件 |

但要注意：

- tmux 才是交互会话事实源
- `~/.codex` 才是共享 Codex 历史事实源

---

## 部署现实

当前线上不是 PM2 主控，而是 systemd：

```text
nexus.service
  -> bash start.sh
  -> rust-runtime/target/release/nexus-server
```

相关文件：

| 文件 | 说明 |
|---|---|
| `start.sh` | 启动脚本 |
| `docs/DEPLOYMENT-RUNBOOK.md` | 更新、重启、验证、回滚的单一事实源 |
| `scripts/nexus-tmux-service.sh` | tmux 相关辅助脚本 |

---

## 环境变量

这里区分“代码兜底值”和“当前实际默认”。

| 变量 | 代码兜底 / 示例默认 | 说明 |
|---|---|---|
| `JWT_SECRET` | 必填 | JWT 签名密钥 |
| `ACC_PASSWORD_HASH` | 必填 | 登录密码 hash |
| `TMUX_SESSION` | 代码兜底 `~`；`.env.example` 用 `main` | 默认 tmux session |
| `WORKSPACE_ROOT` | 代码兜底 `/workspace`；`.env.example` 用 `/home` | 工作区根目录 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `PORT` | 代码兜底 `3000`；`start.sh` / `.env.example` 默认 `59000` | 监听端口 |
| `NEXUS_DATA_DIR` | 默认 `<projectRoot>/data` | 运行时持久化目录；相对路径按项目根解析 |
| `CLAUDE_PROXY` | 空 | Claude 代理 |
| `TELEGRAM_BOT_TOKEN` | 空 | Telegram bot token |
| `TELEGRAM_WEBHOOK_SECRET` | 空 | Telegram webhook 校验 |
| `TELEGRAM_DEFAULT_SESSION` | 空 | Telegram 默认目标窗口名 |
| `GITHUB_REPO` | `librae8226/nexus4cc` | 版本检查仓库 |
| `NEXUS_CODEX_HISTORY_ENABLED` | `1` | Codex 历史开关 |

---

## 当前确认的技术债

这里只记录当前已明确存在、且值得继续跟踪的债。

| 位置 | 问题 |
|---|---|
| 后端运行时 | 默认入口、默认启动链和源码事实源都已切到 Rust `nexus-server` |
| 运维层 | `systemd` 重启时仍有 `left-over process` 告警，见 [CURRENT-ROADMAP.md](CURRENT-ROADMAP.md) |
| 前端任务 UX | 任务 API 仍在，但当前没有独立 `TaskPanel.tsx`，文档与产品口径需要继续收口 |

---

## 更新规则

出现这些变化时，必须更新本文件：

- 核心运行链变化
- 主要 API 组变化
- 前端主面板结构变化
- 持久化数据落点变化
- 部署方式或环境变量语义变化

如果只是实现细节变更，不要在这里堆过细代码说明；那是 [code.md](code.md) 和测试的责任。
