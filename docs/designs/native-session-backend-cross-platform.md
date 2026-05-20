# Native Session Backend Cross-Platform Plan

最后更新：2026-05-20

## 长期方向与当前边界

长期方向是评估并逐步演进出 Rust 原生 session backend，接管 tmux 目前在 Nexus 中承担的交互会话职责，并最终支持 Linux、macOS、Windows 和 WSL2。

当前真实状态：

- Phase 1 contract / tmux 边界收口已经不是唯一事实；代码里已经有 Phase 2 opt-in native path。
- 默认 backend 仍是 `tmux`。
- `NEXUS_SESSION_BACKEND=native` 已可启用 native project/channel/PTY 路径，但只允许作为 opt-in/staging 使用。
- `nexus-native-pty-supervisor`、`nexus-native-session`、`data/native-sessions/session.db`、native scrollback 和 `nexus-native-pty.service` 已存在。
- 本文中早期 “Approved Phase 1 Scope” 小节仍保留为历史决策记录；不要把其中“第一阶段不新增 `NEXUS_SESSION_BACKEND`”误读为当前仓库事实。

当前边界不是“替换 tmux 已完成”，而是：保留 tmux 默认稳定路径，同时让 native backend 在受控、可回滚的 opt-in 路径继续验证。

## CEO Review 决策

2026-05-12 的 `/plan-ceo-review` 结论：**先收缩 scope，不批准完整 native backend 主线直接开工。**

历史实现者注意：**PR1 / PR2 只执行 `Approved Phase 1 Scope`。** 本文后面的 `NativeBackend`、SQLite、cross-platform installer 等内容当时只记录长期方向。

2026-05-20 更新：仓库已经越过 Phase 1，进入了可 opt-in 的 Phase 2 native path。继续推进 native 时，以本文靠后的 production readiness checklist、当前代码和最新 runbook 为准，不要回到 Phase 1 的旧限制。

批准的第一阶段只做：

1. 冻结现有 tmux 行为 contract。
2. 抽出 capability-shaped backend 边界，不做巨型 `SessionBackend`。
3. 把 `nexus-session-runtime` 里的现有 tmux 行为收口到具体 `TmuxSessionBackend`。
4. 保持默认行为、部署路径、NORTH-STAR 语义不变。

长期方向仍保留：`NativeBackend`、跨平台 `PlatformAdapter`、SQLite registry、scrollback store、process supervisor 都作为后续可选路线设计，但不进入第一阶段实现范围。

历史 Phase 1 战略闸门（已过期，仅作当时决策记录）：

- 第一阶段完成前，不实现 `NativeBackend`。
- 第一阶段完成前，不改默认 backend。
- 第一阶段完成前，不新增 `NEXUS_SESSION_BACKEND` 配置项。
- 第一阶段完成前，不修改 `NORTH-STAR.md` 的“不替换 tmux”边界。
- 如果后续决定进入 native backend 主线，必须先显式更新 `NORTH-STAR.md` 和 `CLAUDE.md`，承认这是从 “tmux bridge” 到 “cross-platform agent supervisor” 的战略升级。

当前约束见本文顶部“当前真实状态”：`NEXUS_SESSION_BACKEND=native` 已存在，但只能作为 opt-in/staging；默认 backend 仍是 `tmux`。

长期核心目标：

- 保留现有浏览器协议：`/ws?session=<name>&window=<index>` 不先改。
- 保留现有 REST 语义：project 等价 session，channel 等价 window。
- 保留 tmux backend 作为可回滚路径，直到 native backend 通过完整验证。
- 新 backend 必须跨平台，不依赖 tmux、bash、zsh 或 systemd 作为核心运行条件。

非目标：

- 不重写前端终端 UI。
- 不实现完整 tmux 兼容层。
- 不支持把已经存在的外部 tmux session 无损迁移到 Windows。
- 不在第一版实现多人协同编辑或远程分布式 session。

## 当前事实

当前运行链：

```text
Browser / PWA
  <-> WebSocket / REST
Rust server (nexus-server)
  <-> Rust child runtimes
Session backend
  |-- tmux session:window       default / stable
  `-- native Rust PTY registry  opt-in / staging
  <-> shell / claude / codex
```

默认 tmux backend 现在承担的不是一个功能，而是一组生产语义：

- session/window 事实源
- 持久进程容器
- cwd/env 元数据
- active window / last channel
- window rename / delete / fallback shell
- scrollback capture
- Codex resume window metadata
- `nexus.service` 重启后 session 不丢

已有可复用基础：

- `nexus-pty-runtime` 已经使用 Rust `portable-pty` 做 PTY 读写。
- 前端已经按 `session + windowIndex` 连接，不需要第一阶段改 UI。
- Rust server 已经通过 child runtime 协议隔离了大量后端细节。
- `rusqlite` 已在依赖中，可直接作为 native session registry。

## 长期目标架构

```text
Browser / PWA
  <-> existing WS + REST contracts
nexus-server
  <-> session runtime protocol
Backend capability boundary
  |-- Tmux capabilities          existing behavior, rollback path
  `-- Future native capabilities new Rust session manager

NativeBackend
  |-- SessionRegistry      SQLite durable metadata
  |-- ProcessSupervisor    process lifecycle and restart bookkeeping
  |-- PtyHost              portable-pty / ConPTY / Unix PTY
  |-- ScrollbackStore      bounded durable output chunks
  |-- EventBus             fan-out output to multiple websocket clients
  |-- RuntimeHomeManager   Codex per-window HOME lifecycle
  `-- PlatformAdapter      shell, signals, paths, service integration
```

长期硬边界：所有调用方只知道 backend capabilities，不知道 tmux 或 native。

第一阶段不实现一个巨型 `SessionBackend` trait。先按能力拆分 contract：

```text
SessionCatalog      list projects/sessions and channels/windows
WindowLifecycle     create, rename, attach/select, delete
PtyAttach           attach websocket clients to session/window targets
ScrollbackProvider  return output snapshots
```

PR2 只抽 `nexus-session-runtime` 内部的 concrete backend：

```text
nexus-session-runtime
  -> TmuxSessionBackend
       - catalog-shaped methods
       - lifecycle-shaped methods
       - session-runtime-local tmux helper
```

`nexus-window-launch-runtime`、`nexus-pty-runtime` 和 server-side `capture-pane` fallback 暂不重构，只在 contract 文档和测试里锁住行为。

长期可能演进为一组小接口，而不是单个巨型 trait：

```rust
trait SessionCatalog {
    fn list_projects(&self) -> Result<Vec<Project>>;
    fn list_channels(&self, project: &str) -> Result<Vec<Channel>>;
}

trait WindowLifecycle {
    fn create_project(&self, input: CreateProject) -> Result<Project>;
    fn create_channel(&self, input: CreateChannel) -> Result<Channel>;
    fn rename_project(&self, old: &str, new: &str) -> Result<()>;
    fn rename_channel(&self, target: ChannelTarget, name: &str) -> Result<()>;
    fn delete_channel(&self, target: ChannelTarget) -> Result<DeleteResult>;
    fn delete_project(&self, name: &str) -> Result<DeleteResult>;
}

trait PtyAttach {
    fn attach(&self, target: ChannelTarget) -> Result<PtyHandle>;
    fn resize(&self, target: ChannelTarget, size: PtySize) -> Result<()>;
    fn write_input(&self, target: ChannelTarget, bytes: &[u8]) -> Result<()>;
}

trait ScrollbackProvider {
    fn snapshot(&self, target: ChannelTarget, lines: usize) -> Result<String>;
}
```

## 平台分层

### Tier 1

- Linux x86_64 / aarch64
- macOS arm64 / x86_64
- Windows 10 1809+ / Windows 11
- WSL2 按 Linux 路径处理

### OS 适配责任

| 能力 | Linux / WSL2 | macOS | Windows |
|---|---|---|---|
| PTY | Unix PTY via `portable-pty` | Unix PTY via `portable-pty` | ConPTY via `portable-pty` |
| 默认 shell | `$SHELL`, fallback `/bin/bash`, `/bin/sh` | `$SHELL`, fallback `/bin/zsh`, `/bin/sh` | `pwsh`, then `powershell.exe`, then `cmd.exe` |
| 进程树清理 | session/process group + signal | session/process group + signal | Job Object + terminate fallback |
| 服务管理 | systemd user/system | launchd LaunchAgent | Windows Service or foreground mode first |
| 路径 | `PathBuf`, UTF-8 tolerant display | `PathBuf`, UTF-8 tolerant display | `PathBuf`, no slash assumptions |
| 命令构造 | program + args first, shell string only at boundary | same | same |

关键原则：

- Native backend 内部禁止用 shell 字符串拼接表达结构化命令。
- shell profile 输出可以仍是字符串，但启动时必须先解析成 `{ program, args, env, cwd }`。
- 所有持久化路径用 `PathBuf`，API JSON 只在边界转字符串。
- Windows 不支持的 Unix signal 语义不能伪装成相同能力，必须通过 `PlatformAdapter` 显式降级。

## 长期数据模型

使用 SQLite，默认落点：

```text
data/native-sessions/session.db
data/native-sessions/scrollback/
data/codex-runtime/<native-window-id>/
```

核心表：

```text
projects
  id TEXT PRIMARY KEY
  name TEXT UNIQUE NOT NULL
  cwd TEXT NOT NULL
  active_channel_id TEXT
  created_at TEXT NOT NULL
  updated_at TEXT NOT NULL

channels
  id TEXT PRIMARY KEY
  project_id TEXT NOT NULL
  index INTEGER NOT NULL
  name TEXT NOT NULL
  cwd TEXT NOT NULL
  shell_type TEXT NOT NULL
  shell_profile TEXT
  status TEXT NOT NULL
  last_exit_code INTEGER
  created_at TEXT NOT NULL
  updated_at TEXT NOT NULL
  UNIQUE(project_id, index)

process_instances
  id TEXT PRIMARY KEY
  channel_id TEXT NOT NULL
  os_pid INTEGER
  platform_handle TEXT
  started_at TEXT NOT NULL
  ended_at TEXT
  exit_code INTEGER

channel_metadata
  channel_id TEXT NOT NULL
  key TEXT NOT NULL
  value TEXT NOT NULL
  PRIMARY KEY(channel_id, key)

scrollback_chunks
  channel_id TEXT NOT NULL
  seq INTEGER NOT NULL
  byte_start INTEGER NOT NULL
  byte_len INTEGER NOT NULL
  created_at TEXT NOT NULL
  PRIMARY KEY(channel_id, seq)
```

说明：

- `projects.name` 继续兼容当前 `tmux session name`。
- `channels.index` 继续兼容当前 `windowIndex`。
- `channel_metadata` 替代 tmux window options，例如 Codex resume session id。
- scrollback 用 chunk 文件或 SQLite blob 都可以；第一版建议 chunk 文件，避免 DB 被大输出打爆。

## 分阶段计划

### Approved Phase 1 Scope

本阶段是唯一已批准实现范围。

交付物：

```text
Existing behavior
  -> backend-agnostic contract tests
  -> docs/designs/session-backend-contract.md
  -> capability-shaped contract boundaries
  -> concrete TmuxSessionBackend inside nexus-session-runtime
  -> default backend remains tmux
```

不交付：

- 不新增 native process supervisor。
- 不新增 SQLite session registry。
- 不新增 native scrollback store。
- 不新增 Windows/macOS service installer。
- 不承诺跨平台原生运行。
- 不新增 `NEXUS_SESSION_BACKEND`。
- 不跨 runtime 统一 tmux command helper。

完成标准：

- 现有功能行为不变。
- tmux shell-out 被收口到明确模块。
- contract tests 能描述当前 project/channel/PTY/scrollback 关键行为。
- 后续 `NativeBackend` 可以按同一 contract 实现，而不需要改前端协议。

PR 拆分：

```text
PR1: Contract freeze
  allowed files: docs, tests, test helpers
  disallowed: production Rust source changes

PR2: Session runtime tmux extraction
  allowed focus: nexus-session-runtime only
  disallowed: native backend, env flag, window_launch/pty runtime rewrites
```

### Phase 1A / PR1: Contract freeze

目标：冻结现有行为，防止迁移时无意改协议。

工作：

- 为 session runtime 定义 backend-agnostic contract tests。
- 把现有 fake tmux tests 改造成 backend-agnostic 行为 contract。
- PR1 只跑当前 tmux-backed behavior；未来 `NativeBackend` 出现后再复用同一 contract。
- 列出必须保持的 HTTP/WS payload。
- 为当前 `tmux capture-pane` fallback 写明确测试。
- 每个 scenario family 都要覆盖 happy path 和 failure path。
- 新增一个 server-level WebSocket integration test，覆盖 public `/ws?session=&window=` contract。

验收：

- `TmuxBackend` 跑过 contract tests。
- 文档列出所有必须兼容的 API 字段。
- PR1 只修改 docs/tests/test helpers，不修改 production Rust source。

预计：3-5 天。

### Phase 1B / PR2: Backend boundary

目标：把 tmux 调用收拢到 `TmuxBackend`，先不改变行为。

工作：

- 新建 sibling module，例如 `rust-runtime/src/bin/nexus_session_runtime/tmux_backend.rs`。
- 从 `nexus-session-runtime` 抽出 concrete `TmuxSessionBackend`。
- 只在 `nexus-session-runtime` 内部收口 tmux command helper。
- `nexus-window-launch-runtime` 保持现状。
- `nexus-pty-runtime` 保持现状。
- 不增加 backend env flag。

验收：

- 默认行为完全不变。
- 所有现有测试通过。
- session runtime 内部 tmux helper 不再重复散落。
- fake tmux log 对关键流程有 call-count assertions，防止抽象后多跑 tmux command。

预计：1 周。

### Phase 2: Native MVP, foreground only

状态：长期路线，**不属于 Approved Phase 1 Scope**。

目标：Rust native backend 能创建一个 project/channel，并通过现有 WebSocket 实时交互。

Phase 2 的第一张实现票允许引入 opt-in selector：`NEXUS_SESSION_BACKEND=native`。默认值必须继续等价于 tmux；该 selector 只用于验证 native foreground PTY host，不代表 native backend 已可生产灰度。

工作：

- 实现 `SessionRegistry` 的 projects/channels 最小 schema。
- 实现 `PtyHost`：spawn shell/Codex/Claude 到 PTY。
- 实现 output fan-out、input write、resize、close。
- 实现内存级 recent output replay。
- 支持 Linux/macOS/Windows 三平台 shell discovery。

不做：

- 不承诺服务重启后恢复旧进程。
- 不做 tmux session import。
- 不做完整 scrollback。

验收：

- Linux/macOS/Windows 上可启动 native channel。
- 浏览器终端能输入、输出、resize。
- 多个浏览器连接同一 channel 时都能收到输出。

预计：1-2 周。

### Phase 3: Durable registry and supervisor

状态：长期路线，**不属于 Approved Phase 1 Scope**。

目标：native backend 成为真正 session manager，而不是临时 PTY demo。

工作：

- SQLite registry 写入 project/channel/process lifecycle。
- 进程退出后 channel 状态从 `running` 变为 `exited`。
- server/runtime 重启后：
  - registry 仍能列出 project/channel；
  - 已退出进程显示 exited；
  - 仍存活进程尝试 reconnect；
  - 无法 reconnect 的进程标记 orphaned/stale。
- 增加 orphan cleanup。
- 增加 Windows Job Object 和 Unix process group 清理。

验收：

- 重启 `nexus-server` 后列表不丢。
- channel 状态准确。
- 删除 project/channel 会清理子进程和 Codex runtime home。

预计：1-2 周。

### Phase 4: Scrollback parity

状态：长期路线，**不属于 Approved Phase 1 Scope**。

目标：替代 `tmux capture-pane` 对 Nexus 的产品语义。

工作：

- 每个 channel 输出写入有界 append-only chunk。
- API snapshot 从 `ScrollbackStore` 读取最近 N 行。
- 输出存储按字节上限和时间上限裁剪。
- 标记 alternate screen 输出策略：
  - 第一版只保证可见文本流；
  - 不承诺精确复原全屏 TUI 历史。
- 为中文宽字符、ANSI escape、长行、二进制噪音增加测试。

验收：

- scrollback API 不再需要 tmux。
- 大输出不会无限增长。
- browser reconnect 能收到合理 replay。

预计：1 周。

### Phase 5: Session management parity

状态：长期路线，**不属于 Approved Phase 1 Scope**。

目标：补齐当前 UI 依赖的 project/channel 行为。

工作：

- list projects / channels。
- active project / last channel。
- rename project / channel。
- delete project / channel。
- fallback shell：删除最后一个 channel 时可创建备用 shell。
- cwd/env/proxy vars 持久化。
- Codex resume metadata 从 tmux window option 迁到 `channel_metadata`。

验收：

- 现有 Session Manager UI 不需要知道 backend 类型。
- 当前 session management tests 对 native backend 有等价版本。

预计：1-2 周。

### Phase 6: Agent profile parity

状态：长期路线，**不属于 Approved Phase 1 Scope**。

目标：Claude/Codex profile channel 在 native backend 下行为一致。

工作：

- 将 `shell.rs` 的 shell plan 输出改为跨平台 `{ program, args, env, cwd }`。
- Codex runtime HOME 继续使用 `data/codex-runtime/<channel-id>`。
- Windows 下避免 bash wrapper 依赖；必要时生成跨平台 launcher binary 或直接 program+args。
- Codex history resume 创建 native channel，并写入 metadata。
- 删除 history session 时关闭关联 native channel。

验收：

- Codex profile channel 能看到正确 isolated HOME。
- Codex skills symlink/copy 策略在 Windows 上有替代实现。
- Claude/Codex launch 不依赖 `/bin/bash`。

预计：1 周。

### Phase 7: Cross-platform install and service

状态：长期路线，**不属于 Approved Phase 1 Scope**。

目标：安装、启动、重启、卸载在三类 OS 上有明确路径。

工作：

- `start.sh` 保留 Linux/macOS；增加 Windows `start.ps1` 或 Rust setup 子命令。
- `nexus-setup` 支持：
  - Linux: systemd user/system
  - macOS: launchd LaunchAgent
  - Windows: foreground mode first，后续 Windows Service
- 运行时路径、日志路径、data dir 统一由 Rust 解析。
- 文档更新 README / QUICKSTART。

验收：

- Linux/macOS/Windows 均能前台启动。
- Linux service 不再需要 `nexus-tmux.service` when native backend enabled。
- Windows native backend 不需要安装 tmux。

预计：1-2 周。

### Phase 8: Migration and rollout

状态：长期路线，**不属于 Approved Phase 1 Scope**。

目标：生产可灰度、可回滚。

工作：

- 未来 backend selection flag 默认保持 tmux。
- future `native` mode 只创建新 sessions。
- future `hybrid` mode 显示 tmux sessions + native sessions，但新建走 native。
- 提供一次性 `import-tmux-session --name <session>`，只导入 metadata，不承诺导入运行中进程。
- UI 上显示 backend badge 仅用于 debug，不做常驻产品概念。
- 部署 runbook 加 rollback：
  - 改回 future backend selection flag 的 tmux mode
  - 重启 `nexus`
  - native registry 保留不删

验收：

- 单项目可灰度 native。
- native 出问题不影响 tmux sessions。
- 回滚后服务可访问，旧 tmux 行为恢复。

预计：1 周。

## 生产级可部署目标分解

本节是从当前 Phase 2 MVP 走到 production-ready native backend 的执行清单。只有全部 P0 目标完成并通过验收后，才允许把 native backend 作为可部署生产模式推荐；在此之前 `NEXUS_SESSION_BACKEND=native` 只能用于 opt-in smoke / staging。

### 当前完成状态

已完成：

- Phase 1 contract freeze 和 `TmuxSessionBackend` extraction。
- `docs/designs/session-backend-contract.md`。
- `nexus-pty-runtime` opt-in native foreground PTY host。
- Native SQLite registry：
  - `native_projects`
  - `native_channels`
  - `process_instances`
  - project/channel create/list
  - project/channel rename、delete、activate
  - PTY attach 根据 registry 的 `cwd` / legacy `shell_cmd` 或 structured `launchPlan` 启动进程
  - structured launch plan 字段：`program`、`args`、`env`、`cwd`
  - server native mode 对 Codex/Claude profile-backed create/resume 请求发送 structured `launchPlan`
  - server native mode 对普通 shell create project/channel 请求发送 structured `launchPlan`
- Native process lifecycle：
  - spawn 后记录 `running`
  - child wait 后记录 `exited` / `exit_code`
  - attach 到 `exited/stale/orphaned` fail-closed
  - runtime 启动时将旧 `running` reconciliation 为 `stale` / `orphaned`
- Native scrollback：
  - PTY output 写入有界 per-channel 文件
  - cold `getOutputSnapshot` 可从 scrollback 恢复最近输出
  - server `/api/sessions/:window/scrollback` 在 native mode 下走 PTY runtime snapshot，不调用 `tmux capture-pane`
- Native Codex history metadata parity：
  - `channel_metadata` 保存 `@nexus_codex_resume_session_id`
  - `listCodexSessions/detail/resume/delete` 在 native mode 下通过 registry project cwd 和 metadata 工作
  - `deleteProjectCodexSession` 删除 session 文件和 index 后，关闭关联 native resume channel
  - 删除最后一个 resume channel 前创建 fallback shell，并清理对应 runtime home
- Node test 覆盖：
  - tmux 默认路径仍可用
  - native PTY attach/input/output/replay/fan-out/snapshot
  - native registry create/list/lifecycle parity + PTY registry launch
  - native process lifecycle、restart reconciliation、durable scrollback、structured launch plan
  - native Codex resume metadata 和 history delete channel cleanup
- Local production gate on Ubuntu host:
  - `npm test` 通过
  - `npm run check:frontend-dist` 通过
  - release binaries 构建通过
  - `nexus` service restart smoke 通过
  - HTTP `/` 可访问，`/api/version` 返回 auth-gated reachable 状态

未完成：

- Claude/Codex profile HOME isolation smoke 和完整 profile launcher parity。
- Windows/macOS real smoke。
- production rollout runbook 和 rollback drill。
- registry migration versioning / repair tooling。
- native browser smoke。
- Windows shell plan 真实平台验证。

### P0-A: Native lifecycle parity

目标：当前 Session Manager UI 依赖的 project/channel 生命周期在 native mode 下可用，不需要前端知道 backend 类型。

交付物：

- `renameProject`
  - registry 更新 project name；
  - 关联 channels 同步迁移；
  - 名字冲突返回稳定错误。
- `deleteProject`
  - 标记/终止所有 project channels 的进程；
  - 删除 registry project/channel rows；
  - 删除关联 Codex runtime home。
- `attachSessionWindow`
  - 更新 active channel / last channel；
  - 返回 `{ ok: true }`。
- `renameSessionWindow`
  - 更新 channel name；
  - 返回 `{ ok: true, name }`。
- `deleteSessionWindow`
  - 删除指定 channel；
  - 终止对应 process；
  - 清理 Codex runtime home；
  - 删除最后一个 channel 时创建 fallback shell，或返回明确不可删除错误；二选一必须文档化。
- `createResumeWindow`
  - 已有最小实现要补 metadata 写入；
  - 返回字段继续兼容 `windowId/index/name`。

验收：

- native mode 下现有 session management write route tests 有等价版本。
- 删除 project/channel 后不再能 attach 到已删除 channel。
- 删除 project/channel 后无残留 child process。
- 默认 tmux tests 仍绿。

### P0-B: Process lifecycle supervisor

目标：native backend 不只是 spawn PTY；必须知道每个 channel 当前 process 状态，并能可靠清理。

交付物：

- Registry 增加 process lifecycle schema：
  - `process_instances`
  - `status`: `starting | running | exited | stale | orphaned`
  - `os_pid`
  - `platform_handle`
  - `started_at`
  - `ended_at`
  - `exit_code`
  - `start_fingerprint`，例如 Unix start time / Windows creation time，可用于降低 pid reuse 误判。
- PTY spawn 成功后写入 running process instance。
- child wait 后写入 `exited` 和 `exit_code`。
- attach 到 exited/stale channel 时返回稳定错误，或按明确策略创建新 process；策略必须文档化。
- delete project/channel 时：
  - Unix: process group/session cleanup；
  - Windows: Job Object cleanup；
  - fallback terminate/kill；
  - 清理失败必须暴露 warning/error。

验收：

- child exits immediately test。
- delete while process is producing output test。
- shell command not found test。
- stale pid / reused pid test。
- native process cleanup smoke：删除后进程不存在。

### P0-C: Restart semantics

目标：`nexus.service` 或 child runtime 重启后，UI 不能丢 project/channel，也不能谎称 dead process 仍 running。

当前代码状态：

- `nexus-pty-runtime` 已有 `PtyHost` 边界，当前实现是 `InProcessPtyHost`。
- 这个边界只把 stdio broker 和 PTY 宿主解耦，尚未提供跨 runtime attach。
- 真正的 tmux-like restart/reattach 语义仍依赖后续长驻 native PTY supervisor。

交付物：

- session runtime 启动时能从 registry 列出 project/channel。
- PTY runtime 启动时执行 reconciliation：
  - registry 中 `running` 的 process 尝试校验；
  - 无法确认仍可控的标记 `stale` 或 `orphaned`；
  - 已退出的标记 `exited`。
- cold attach 策略：
  - 对 `exited/stale/orphaned` 返回稳定错误，或显式 restart；
  - 第一版建议 fail-closed，不自动重启，避免误启动 agent。
- service restart smoke：
  - 创建 native project/channel；
  - 写入输出；
  - 重启 `nexus`；
  - project/channel 列表仍存在；
  - process 状态准确；
  - 不出现假 running。

验收：

- `nexus.service` restart 后列表不丢。
- 已退出进程显示 exited。
- 不可 reconnect 的 running 进程显示 stale/orphaned。
- rollback 到 tmux 后 native registry 不影响 tmux sessions。

### P0-D: Native scrollback store

目标：替代 `tmux capture-pane` 在 Nexus 中承担的 snapshot/reconnect 产品语义。

交付物：

- `ScrollbackStore` schema / chunk 文件：
  - 每个 channel append-only output chunk；
  - seq / byte offset / created_at metadata；
  - per-channel byte cap；
  - TTL 或 max chunk count。
- PTY reader 写入 scrollback store，同时维持内存 recent replay。
- `/api/sessions/:window/scrollback` 在 native mode 下走 native store。
- cold snapshot：
  - PTY 未连接但 registry/channel 存在时，从 store 返回最近 N 行；
  - store 缺失时返回空 snapshot，不报 tmux error。
- ANSI / Unicode 策略：
  - 保留原始 output bytes 或 UTF-8 lossy text，必须固定；
  - 中文宽字符、ANSI escape、长行、invalid UTF-8、有界大输出测试。

验收：

- native mode 不调用 `tmux capture-pane`。
- 大输出不会无限增长。
- browser reconnect 能看到合理 replay。
- scrollback corruption 不影响 process cleanup。

### P0-E: Structured command plan

目标：native backend 内部不再靠 shell 字符串表达结构化命令；这是跨平台和安全边界。

交付物：

- Registry channel launch 字段从 `shell_cmd TEXT` 迁到 structured plan：
  - `program`
  - `args`
  - `env`
  - `cwd`
  - `shell_type`
  - `profile`
- `shell.rs` 输出 native launch plan。
- Unix 允许 shell wrapper 只作为最后边界，不允许业务逻辑拼接 shell 字符串。
- Windows 不依赖 `/bin/bash`、`zsh`、Unix symlink。
- proxy vars / HOME / PATH / agent env 明确持久化。

验收：

- cwd 缺失、program 不存在、args 包含空格、env 覆盖均有测试。
- Windows smoke 不需要 bash。
- Codex/Claude profile channel 能按 plan 启动。

### P0-F: Agent profile parity

目标：Claude/Codex profile channel 在 native backend 下不退化。

交付物：

- Codex runtime HOME：
  - 继续使用 `data/codex-runtime/<native-channel-id>`；
  - 删除 channel/project 时清理；
  - restart 后不会错误重建已运行 process 的 HOME。
- Codex resume metadata：
  - 从 tmux window option 迁到 `channel_metadata`；
  - `listCodexSessions/detail/resume/delete` native 等价。**当前代码已完成 session runtime 行为测试；仍需 browser smoke 验证。**
- Claude/Codex profile launcher：
  - 读取当前 profile；
  - materialize auth/config；
  - 正确注入 env；
  - Windows 文件复制/symlink 策略明确。
- history delete：
  - 删除历史 session 文件；
  - 关闭关联 native resume channel；**当前代码已完成。**
  - 清理 runtime home。**当前代码已覆盖 native resume channel runtime home。**

验收：

- 当前 Codex history tests 有 native 等价版本。
- `resume` 能创建 native channel 并可 attach。
- `delete` 能关闭关联 native channel。
- profile HOME isolation smoke 通过。

### P0-G: Cross-platform validation

目标：native backend 宣称跨平台前，必须有真实平台证据，不允许只靠 `cfg` 推测。

最小矩阵：

| 平台 | 必跑 |
|---|---|
| Ubuntu 24.04 | full node tests + cargo check/test + browser smoke + service restart |
| WSL2 | native attach/list/delete + path smoke |
| macOS latest | native PTY attach/input/output/resize + launchd/foreground smoke |
| Windows 11 | ConPTY attach/input/output/resize + process cleanup smoke |
| Windows 10 1809+ | ConPTY availability smoke |

验收证据：

- 每个平台一份 `docs/verification/native-backend-<platform>-<date>.md`。
- 记录 exact commit、OS version、commands、结果、失败与 workaround。

### P0-H: Deployment, rollout, rollback

目标：native mode 可部署、可灰度、可回滚，且失败不影响 tmux sessions。

交付物：

- README / QUICKSTART / DEPLOYMENT-RUNBOOK 更新：
  - native mode status；
  - enable command；
  - disable command；
  - data paths；
  - known limitations。
- Rollout modes：
  - `tmux` default；
  - `native` only for new sessions；
  - `hybrid` 是否支持必须明确；不支持就写不支持。
- rollback drill：
  - 改回 tmux；
  - restart `nexus`；
  - verify service reachable；
  - verify old tmux sessions unaffected；
  - native registry 保留不删。
- 部署脚本：
  - release build；
  - restart service；
  - healthcheck；
  - failure rollback。

验收：

- staging 上完成 native enable/disable drill。
- service 不可达时能回滚到前一版本。
- tmux sessions 在 native failed rollout 后仍可 attach。

### P1: Production hardening

P0 完成后再做：

- registry migration versioning。
- registry backup / repair tool。
- orphan cleanup CLI。
- metrics / logs：
  - process spawn duration；
  - bytes written to scrollback；
  - active native ptys；
  - failed cleanup count。
- debug-only backend badge。
- `import-tmux-session --name <session>` metadata-only import。
- load test：
  - 多 channel；
  - 大输出；
  - 多客户端；
  - repeated reconnect。

### 生产发布闸门

必须同时满足：

- P0-A 到 P0-H 全部完成。
- `npm run test:node` 通过。
- `cargo check --manifest-path rust-runtime/Cargo.toml` 通过。
- 如果 `cargo test --manifest-path rust-runtime/Cargo.toml` 仍有失败，必须有明确 issue、原因、owner 和“不阻塞 native deploy”的书面判断。
- Ubuntu service restart smoke 通过。
- native browser smoke 通过。
- rollback drill 通过。
- `docs/NORTH-STAR.md` 和相关战略文档已更新，承认 Nexus 从 tmux bridge 扩展为 cross-platform agent supervisor。

## 测试策略

### Contract tests

长期目标是同一组行为可跑多个 backend：

```text
Nexus behavior contract
  -> current tmux-backed implementation
  -> future native backend
```

第一阶段实际测试命名要按 Nexus 行为命名，不按 tmux 命令命名。tmux command assertions 只放在 tmux adapter tests。

覆盖：

- create project
- create channel
- list projects/channels
- attach + input + output
- resize
- reconnect replay
- rename
- delete
- fallback shell
- Codex resume metadata
- snapshot/scrollback

PR1 scenario families:

```text
discovery
  happy: sessions/windows listed
  failure: malformed output, command failure
  invariants:
    - internal nexus-pty-* sessions are hidden
    - list-sessions failure falls back to current session and WORKSPACE_ROOT
    - project list preserves current reverse ordering
lifecycle
  happy: create/rename/delete/attach
  failure: missing session/window, invalid last channel
  invariants:
    - channel list preserves current reverse ordering
    - cwd resolves as NEXUS_CWD -> pane_current_path -> WORKSPACE_ROOT
codex metadata
  happy: resume/delete maps session id to window metadata
  failure: missing project, missing associated window
  invariants:
    - project delete cleans associated Codex runtime dirs
    - window delete cleans associated Codex runtime dir
    - Codex history delete closes associated resume windows
websocket attach
  happy: auth + attach + output + resize + close
  failure: attach fails -> stable close/error behavior
scrollback snapshot
  happy: capture returns trimmed text shape
  failure: capture-pane failure surfaces same error shape
```

Fixture rule:

- 主 contract suite 使用 fake tmux。
- 保留一个 real tmux smoke，`tmux` 缺失时 skip。
- fake fixtures 按 scenario 拆分：discovery、lifecycle、codex metadata、delete fallback、scrollback/attach。

### Long-term platform matrix

| 平台 | 最小验证 |
|---|---|
| Ubuntu 24.04 | full test + browser smoke + service restart |
| macOS latest | native backend runtime tests + browser smoke + launchd smoke |
| Windows 11 | native backend runtime tests + browser smoke |
| Windows 10 1809+ | ConPTY availability smoke |
| WSL2 | Linux path smoke |

### Long-term native failure tests

- child exits immediately
- shell command not found
- cwd missing
- huge output
- invalid UTF-8 bytes
- browser disconnect during output
- two clients resize same channel
- delete while process is producing output
- server restart while channel is running
- corrupted SQLite registry
- stale pid / reused pid

## Rollback plan

Approved Phase 1 rollback:

- PR1 rollback：revert docs/tests/test helpers；无需服务配置变更。
- PR2 rollback：git revert / 回滚 artifact，重启 `nexus`，验证 HTTP 和 `/ws?session=&window=` 可达。
- 第一阶段不新增 `NEXUS_SESSION_BACKEND`，不能用 env flag 作为 rollback 机制。
- tmux-backed tests must stay green before deployment.
- 部署失败或服务不可达时按项目规则立即回滚代码并重启 `nexus`。

长期 native backend rollout 才允许引入 backend selection flag；该机制不属于 Approved Phase 1 Scope。

## 里程碑

| Milestone | 可交付结果 | 预计 |
|---|---|---:|
| M1 | backend contract + TmuxBackend no-op extraction | 1-2 周 |
| M2 | native foreground shell 可用 | 2-4 周 |
| M3 | native durable session manager | 4-6 周 |
| M4 | scrollback + session management parity | 6-8 周 |
| M5 | cross-platform setup + hybrid rollout | 8-10 周 |

## 主要风险

1. Windows 进程树清理和 Ctrl-C 语义不会等价于 Unix。
   - 应对：显式 PlatformAdapter；测试里接受平台差异，不伪装。
2. tmux scrollback 和 native text stream 不完全等价。
   - 应对：定义 Nexus 需要的是 reconnect/snapshot，不是完整 tmux pane emulator。
3. Codex/Claude wrapper 当前偏 Unix shell。
   - 应对：把 shell plan 改成结构化 command，不再拼 shell 字符串。
4. 重启恢复容易误判 stale pid。
   - 应对：记录 process start time / instance id；只做 best-effort reconnect。
5. 大输出可能打爆磁盘。
   - 应对：强制 per-channel byte cap 和 TTL。

## 推荐切入点

第一张票不要写 NativeBackend。先做：

1. 把当前 tmux 行为固化成 backend contract tests。
2. 新增 `docs/designs/session-backend-contract.md`，写清字段、排序、fallback、cleanup 和错误语义。
3. PR2 只抽 concrete `TmuxSessionBackend`，默认行为不变。
4. 用测试确认 session runtime 内部 tmux 调用被收口，且关键路径没有新增 tmux shell-out。

这一步成功后，后续 native backend 才有低风险落点。
