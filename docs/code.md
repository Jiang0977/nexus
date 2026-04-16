# Nexus4CC 源码导览

最后更新：2026-04-16

目标：给维护者一个可信、可落地的源码入口，而不是一篇历史感很重的长文。

如果你只想知道当前项目状态，先读这些文件：

1. [NORTH-STAR.md](NORTH-STAR.md)
2. [CURRENT-ROADMAP.md](CURRENT-ROADMAP.md)
3. [ARCHITECTURE.md](ARCHITECTURE.md)
4. [DEPLOYMENT-RUNBOOK.md](DEPLOYMENT-RUNBOOK.md)

这份文档回答的是另一件事：代码现在是怎么组织的，应该从哪里下手读。

## 先知道三件事

- 这是单用户、自托管、tmux 驱动的 Claude Code 工作台，不是多用户协作平台。
- 运行时的真实入口是 `start.sh -> node dist-server/server.js`，但源码事实以根目录下的 `.js` / `frontend/src/*.tsx` 为准，不看 `dist-server/`。
- tmux 是会话事实源，`data/*.json` 只保存配置和任务历史，不存在数据库。

## 读代码顺序

推荐按这个顺序建立心智模型：

1. `server.js`
   看运行时装配、依赖关系、路由注册和启动链。
2. `frontend/src/Terminal.tsx`
   看主页面如何组织终端、弹层、轮询、WebSocket 和移动端交互。
3. 服务模块
   先读 `sessionManagementService.js`、`windowLaunchService.js`、`ptyTmuxBroker.js`、`taskRunner.js`。
4. 与用户最相关的前端面板
   `SessionManagerV2.tsx`、`CodexSessionsPanel.tsx`、`WorkspaceBrowser.tsx`、`Toolbar.tsx`。
5. 测试
   对照 `tests/*.test.js` 看每个边界的预期行为。

## 运行时形态

```text
Browser / PWA
  ↕ WebSocket /ws?token=...
  ↕ REST /api/*
Node server (server.js)
  ↕ service modules
  ↕ pty broker
tmux session:window
  ↕ shell / claude / codex

Optional:
- Telegram webhook -> task runner
- shared ~/.codex -> Codex history
- data/*.json -> configs / toolbar / tasks / uploads metadata
```

项目里有两条主要执行链：

- 交互链：
  浏览器终端通过 WebSocket 接到 `tmux session:window`。
- 异步链：
  `/api/tasks` 或 Telegram webhook 调用 task runner，跑 `claude -p`，结果经 SSE 或 Telegram 回流。

## 仓库结构

### 根目录

这些文件最重要：

| 路径 | 作用 |
|---|---|
| `server.js` | 后端运行时装配和 HTTP / WS 入口 |
| `start.sh` | 线上启动链；systemd 调它 |
| `nexus-run-claude.sh` | 交互式 Claude 启动脚本 |
| `nexus-run-codex.sh` | Codex 相关启动脚本 |
| `package.json` | 后端脚本与依赖 |
| `tsconfig.server*.json` | 后端类型检查与编译配置 |
| `tests/*.test.js` | 后端模块和配置边界测试 |

### 不要把这些当源码事实源

| 路径 | 原因 |
|---|---|
| `dist-server/` | 编译产物，运行时使用，但不应该手改 |
| `docs/story.md` | 面向外部叙事，不是工程事实源 |
| `docs/ROADMAP.md` | 是 backlog 视图，不是代码组织说明 |

## 后端模块地图

后端已经从“全塞进 `server.js`”收口成“入口 + 一组服务模块”。

### 入口与运行时护栏

| 文件 | 作用 |
|---|---|
| `server.js` | 读取 `.env`、创建服务对象、注册 API / WS、启动 HTTP server |
| `runtimePaths.js` | 统一项目根目录、`data/`、`.env` 等运行时路径 |
| `runtimeGuards.js` | 运行时保护和安全退出护栏 |
| `gracefulShutdown.js` | 进程退出时的清理逻辑 |
| `serverConfig.js` | 生成前端要读的服务端配置 |
| `systemConfig.js` | 系统级配置解析 |

### tmux / 会话 / 窗口

| 文件 | 作用 |
|---|---|
| `sessionManagementService.js` | 项目、频道、Codex 历史、窗口 attach / rename / delete 的主服务 |
| `windowLaunchService.js` | 新建窗口 / 新建项目时的 shell 启动和窗口命名 |
| `shellLaunch.js` | 生成交互式 shell 命令、代理变量和 shell 启动细节 |
| `projectDefaults.js` | 按项目路径记住默认 shell / profile |
| `tmuxSessionPolicy.js` | tmux session 相关策略 |
| `ptyBrokerController.js` | 选择 local / sidecar broker 模式 |
| `ptyTmuxBroker.js` | 真正的 PTY + tmux 桥接实现 |
| `ptyBrokerLocalBackend.js` | 本地 broker 后端 |
| `ptyBrokerSidecarClient.js` | sidecar broker 客户端 |
| `ptyBrokerSidecarProcess.js` | sidecar broker 进程管理 |

### 任务 / Telegram / 文件

| 文件 | 作用 |
|---|---|
| `taskRunner.js` | 任务存储和 `claude -p` 执行抽象 |
| `taskRunnerSse.js` | SSE 流式输出 |
| `taskRunnerController.js` | task runner 模式选择 |
| `taskRunnerLocalBackend.js` | 本地 task runner |
| `taskRunnerSidecarClient.js` | sidecar task runner 客户端 |
| `taskRunnerSidecarProcess.js` | sidecar task runner 进程管理 |
| `telegramBridgeService.js` | Telegram webhook、文件处理、任务回传 |
| `uploadFilesService.js` | 工作区上传与 `data/uploads` 管理 |
| `workspaceService.js` | 工作区浏览、读写、复制、移动、删除 |

### 配置 / 版本 / Codex 历史

| 文件 | 作用 |
|---|---|
| `configProfilesService.js` | Claude / Codex profile、toolbar config、项目默认配置 |
| `versionService.js` | 当前版本与最新版本检查 |
| `codexSessions.js` | 扫描共享 `~/.codex` 历史会话 |
| `codexSessionWindows.js` | Codex resume 窗口标记和清理 |
| `codexConfig.js` | Codex 配置支持 |
| `ccSwitchConfig.js` | provider 配置导入相关支持 |

## 前端模块地图

前端没有状态库，主逻辑集中在 `Terminal.tsx`，其他面板大多是 lazy loaded。

### 页面与入口

| 文件 | 作用 |
|---|---|
| `frontend/src/main.tsx` | React 入口 |
| `frontend/src/App.tsx` | 登录页和主终端页切换 |
| `frontend/src/Terminal.tsx` | 主工作区；终端、轮询、WS、弹层、移动端交互都在这里编排 |

### 终端与导航

| 文件 | 作用 |
|---|---|
| `frontend/src/Toolbar.tsx` | 软键盘、可配置按键、上传和设置入口 |
| `frontend/src/TabBar.tsx` | 窗口标签和移动端会话切换 |
| `frontend/src/windowStatus.ts` | 共享的窗口状态推断 |
| `frontend/src/GhostShield.tsx` | 防误触覆盖层 |
| `frontend/src/SessionFAB.tsx` | 移动端浮动操作按钮 |
| `frontend/src/DraggableFab.tsx` | 可拖拽 FAB |

### 项目 / 历史 / 文件

| 文件 | 作用 |
|---|---|
| `frontend/src/SessionManagerV2.tsx` | Project / Channel 双层会话管理 |
| `frontend/src/SessionManager.tsx` | 旧版设置 / config 管理面板 |
| `frontend/src/CodexSessionsPanel.tsx` | 当前工作区内的 Codex 历史列表、detail、resume、delete |
| `frontend/src/WorkspaceBrowser.tsx` | 工作区浏览和文件编辑 |
| `frontend/src/FilePanel.tsx` | 上传文件面板 |
| `frontend/src/WorkspaceSelector.tsx` | 目录选择器 |
| `frontend/src/NewWindowDialog.tsx` | 新建窗口对话框 |
| `frontend/src/GeneralSettings.tsx` | 通用设置 |

### 前端辅助模块

| 文件 | 作用 |
|---|---|
| `frontend/src/featureFlags.js` | 前端 feature flags |
| `frontend/src/sessionBootstrap.js` | 初始 session 选择 |
| `frontend/src/shellType.js` | shell 类型定义 |
| `frontend/src/shellProfiles.ts` | shell profile 相关类型 / 数据 |
| `frontend/src/toolbarDefaults.ts` | 工具栏默认键位 |
| `frontend/src/i18n/index.ts` | i18n 初始化 |
| `frontend/src/locales/*` | 文案翻译 |

## 最重要的 5 条调用链

### 1. 打开终端

1. 登录后进入 `App.tsx`
2. `Terminal.tsx` 拉取窗口列表
3. `Terminal.tsx` 建 WebSocket 到 `/ws`
4. 后端经 `ptyBrokerController.js -> ptyTmuxBroker.js` attach 到目标 `tmux session:window`
5. 浏览器和 tmux 开始双向 I/O

### 2. 新建 Project / Channel

1. 前端在 `SessionManagerV2.tsx` 或 `Terminal.tsx` 发请求
2. 后端由 `sessionManagementService.js` 和 `windowLaunchService.js` 处理
3. tmux session / window 创建完成
4. 前端刷新列表并切换到新上下文

### 3. 异步任务

1. 前端或 Telegram 调 `/api/tasks`
2. `taskRunner.js` 记录任务到 `data/tasks.json`
3. 后端 spawn `claude -p`
4. 输出通过 `taskRunnerSse.js` 推给前端，或经 `telegramBridgeService.js` 回传

### 4. Codex 历史

1. `Terminal.tsx` 打开 `CodexSessionsPanel.tsx`
2. 面板请求 `/api/codex-sessions`
3. `sessionManagementService.js` 调 `codexSessions.js`
4. 服务端按当前项目过滤共享 `~/.codex` 历史
5. resume / delete / detail 仍回到 `sessionManagementService.js`

### 5. 工作区文件操作

1. `WorkspaceBrowser.tsx` 调 `/api/workspace/*`
2. `workspaceService.js` 做路径解析、越界保护、文件操作
3. 结果回前端，必要时刷新目录或编辑器内容

## 数据落点

当前持久化主要在 `data/`：

| 路径 | 内容 |
|---|---|
| `data/tasks.json` | 异步任务历史 |
| `data/toolbar-config.json` | 工具栏布局 |
| `data/project-shell-defaults.json` | 项目默认 shell / profile |
| `data/configs/` | Claude profile |
| `data/codex-configs/` | Codex profile |
| `data/uploads/` | 上传文件 |

真正的会话状态不在这里，而在 tmux 和共享 `~/.codex`。

## 构建、测试、部署

### 本地开发

```bash
npm run dev
npm --prefix frontend run dev
```

### 后端类型检查与构建

```bash
npm run typecheck:server
npm run build:server
```

### 前端构建

```bash
npm --prefix frontend run build
```

### 测试

```bash
node --test
```

如果只改某个服务模块，优先跑对应的 `tests/<module>.test.js`。

### 部署

上线规则不要在这里重新发明，直接按 [DEPLOYMENT-RUNBOOK.md](DEPLOYMENT-RUNBOOK.md) 执行。

关键约束只有 4 条：

- 前端改动先构建前端
- 后端改动先构建后端
- 上线后必须重启 `nexus`
- 服务不可达立即回滚

## 不要在这里踩坑

- 不要手改 `dist-server/`
- 不要把 tmux 当缓存层；它是会话事实源
- 不要引入数据库来解决当前问题
- 不要按多用户 / 团队协作方向扩 scope，这和锚点冲突
- 不要把 `story.md` 里的营销文案当工程需求

## 什么时候更新这份文档

发生这些变化时，应同步更新本文件：

- 新增或删除一个核心服务模块
- `Terminal.tsx` 的主面板结构明显变化
- 构建 / 启动 / 部署链路变化
- 数据落点从 `data/` / tmux / `~/.codex` 发生迁移

如果只是改 API 细节或某个面板行为，优先更新：

- [ARCHITECTURE.md](ARCHITECTURE.md)
- [CURRENT-ROADMAP.md](CURRENT-ROADMAP.md)
- 对应设计文档或测试
