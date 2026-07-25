# Native Session Backend Cross-Platform Plan

最后更新：2026-07-25

## 状态与边界

Nexus 已有可运行的 Rust native session backend，但它仍是 **opt-in/staging**：

- 默认稳定 backend：`tmux`
- opt-in backend：`NEXUS_SESSION_BACKEND=native`
- 前端和公开 HTTP/WS 协议不感知 backend 类型
- native 失败时必须保留 tmux 回退路径
- 未完成本文“生产升级闸门”前，不得把 native 写成默认生产路径

当前产品 contract 见 [session-backend-contract.md](session-backend-contract.md)，运行结构见 [ARCHITECTURE.md](../ARCHITECTURE.md)。

历史 Phase 1–8 计划和完成过程由 Git 记录；本文只保留当前状态与尚未完成的决策。

## 当前架构

```text
Browser / PWA
  <-> existing REST + /ws?session=<project>&window=<index>
nexus-server
  <-> JSON-line child runtime protocol
Session capabilities
  |-- tmux adapters            default / stable
  `-- native adapters          opt-in / staging
        |-- SQLite registry
        |-- long-running PTY supervisor
        |-- bounded scrollback
        `-- structured launch plan
```

### 已落地边界

| 边界 | 当前实现 |
|---|---|
| Session catalog | `backend/catalog.rs` 的窄 capability port，tmux/native adapter 共用 contract |
| Lifecycle | `backend/lifecycle.rs` 的 create/rename/attach/delete contract |
| Cleanup | `backend/cleanup.rs` 的 Codex metadata、channel/project cleanup contract |
| PTY transport | `pty_runtime.rs` 选择 tmux attach 或 native supervisor |
| Wire protocol | `child_runtime_protocol.rs` 同时服务 stdio child runtime 与 Unix supervisor socket |
| Codex HOME | `codex_home.rs` 是配置导入、trust/auth、共享状态链接与物化的单一事实源 |
| Browser connection | `frontend/src/terminal/terminalConnection.ts` 集中 URL、resize、retry、close 与 cleanup policy |

这些边界刻意保持窄小，不引入一个同时承担 catalog、lifecycle、PTY、scrollback 与平台适配的巨型 `SessionBackend`。

## 已实现能力

### Project / channel

- native project/channel create、list、rename、activate、delete
- numeric `windowIndex` 与 `session + window` 公开心智模型保持不变
- 删除最后一个相关 channel 时的 fallback shell
- channel metadata，包括 Codex resume session id
- 删除 project/channel 时清理关联 Codex runtime HOME

### Process / PTY

- `portable-pty` 启动和双向 I/O
- `nexus-native-pty-supervisor` 长驻持有 PTY
- 多 client output fan-out
- input、resize、disconnect/reconnect
- process instance 状态与退出码记录
- runtime 启动时 reconciliation；无法确认的进程标记 stale/orphaned
- cold reattach 与稳定的不可 attach 状态语义

### Registry / scrollback

- SQLite 保存 native project、channel、process 和 metadata
- 每 channel 有界 scrollback
- reconnect replay 与 cold snapshot
- native snapshot 不依赖 `tmux capture-pane`
- 数据默认落在 `data/native-sessions/`

### Agent profile

- structured launch plan：`program`、`args`、`env`、`cwd`
- server 为普通 shell、Claude/Codex profile 和 resume 请求生成 native launch plan
- Codex runtime id 不依赖 tmux window id
- Codex history list/detail/resume/delete 的 native metadata path

## 仍未完成的生产条件

### 1. 真实跨平台验证

当前仓库没有以下平台的 native verification record：

| 平台 | 必须补的证据 |
|---|---|
| Ubuntu / WSL2 | native enable/disable、attach/list/delete、service restart、browser smoke |
| macOS | PTY input/output/resize、process cleanup、foreground/launchd 路径 |
| Windows 11 | ConPTY input/output/resize、Job/process cleanup、PowerShell/CMD launch |
| Windows 10 1809+ | ConPTY availability 与最小 attach |

每个平台应新增 `docs/verification/native-backend-<platform>-<date>.md`，记录 commit、OS、命令、结果和限制。仅有 `cfg` 分支或 Linux 单测不能证明跨平台可用。

### 2. Native 浏览器与 profile E2E

必须在 `NEXUS_SESSION_BACKEND=native` 下通过真实认证页面验证：

- 创建 project/channel
- 终端 input/output/resize/reconnect
- 上传路径发送到 WebSocket
- Claude/Codex profile 启动
- Codex 隔离 HOME 与共享 skills
- Codex history resume/delete
- 删除 channel/project 后进程与 runtime HOME 无残留

现有 binary/contract tests 不能替代这组真实浏览器证据。

### 3. Registry 演进与修复

生产推荐前需要：

- 显式 schema version / migration policy
- 升级失败的 fail-closed 行为
- registry backup 与 repair/inspect 工具
- corrupted registry / scrollback 的恢复测试
- stale/orphaned process 的可审计 cleanup 入口

### 4. 灰度与回滚演练

需要完成一次有记录的 staging drill：

1. 确认 tmux sessions 可 attach。
2. 启用 native，只创建新的 native sessions。
3. 验证 native service restart 与浏览器路径。
4. 改回 tmux 并重启 `nexus`。
5. 验证旧 tmux sessions 未受影响。
6. 保留 native registry，不做破坏性清理。

当前不支持的 `hybrid` 行为不得在 UI 或文档中暗示可用。

### 5. 可观测性

生产 hardening 至少需要：

- active native PTY 数量
- spawn duration / failure
- scrollback bytes 与裁剪
- process cleanup failure
- reconciliation 的 stale/orphaned 计数

日志与指标不能包含 terminal 内容、token、cookie 或 profile secret。

## 平台适配规则

| 能力 | Linux / WSL2 | macOS | Windows |
|---|---|---|---|
| PTY | Unix PTY | Unix PTY | ConPTY |
| 默认 shell | `$SHELL`，再 `/bin/bash` / `/bin/sh` | `$SHELL`，再 `/bin/zsh` / `/bin/sh` | `pwsh`，再 `powershell.exe` / `cmd.exe` |
| 进程清理 | process group / signal | process group / signal | Job Object / terminate fallback |
| 服务 | systemd 或 foreground | launchd 或 foreground | foreground，后续 Windows Service |
| 路径 | `PathBuf` | `PathBuf` | `PathBuf`，禁止 slash 假设 |

硬规则：

- 结构化命令始终使用 program + args + env + cwd。
- shell string 只允许出现在最终 shell 边界。
- Windows 不支持的 signal / symlink 语义必须显式降级，不能伪装等价。
- API JSON 只在边界把 `PathBuf` 转为字符串。

## 当前测试证据

| 范围 | 证据 |
|---|---|
| backend capability contract | `backend/{catalog,lifecycle,cleanup}.rs` local fake tests |
| tmux/native session lifecycle | `tests/sessionManagementRustRuntimeBinary.test.js` |
| native PTY/supervisor/replay/reconciliation | `tests/ptyBrokerRustRuntimeBinary.test.js`、`tests/nativePtySupervisorBinary.test.js` |
| server native routes / snapshot | `tests/nexusRustServerEntry.test.js` |
| Codex HOME | `rust-runtime/src/codex_home.rs` tests、`tests/codexHomeRustBinary.test.js` |
| profile launcher | `tests/codexProfileLauncher.test.js`、`tests/claudeProfileLauncher.test.js` |
| browser terminal policy | `tests/browserTerminalRegression.test.js`、`frontend/src/terminal/terminalConnection.test.ts` |

仓库级入口：

```bash
npm run check
cargo fmt --manifest-path rust-runtime/Cargo.toml --check
cargo clippy --manifest-path rust-runtime/Cargo.toml --all-targets --all-features -- -D warnings
```

## 生产升级闸门

只有同时满足以下条件，才可以提案把 native 从 staging 提升为生产可选项；改成默认 backend 还需要单独决策：

- 本文五类未完成条件全部关闭
- Linux、WSL2、macOS、Windows 真实验证记录齐全
- native browser/profile E2E 通过
- registry migration、backup、repair 与 corruption test 通过
- staging enable/disable/rollback drill 通过
- tmux 默认路径与回退验证通过
- `npm run check`、Rust fmt/clippy 通过
- README、QUICKSTART、DEPLOYMENT-RUNBOOK 与 NORTH-STAR 同步更新

## 回滚

native staging 出现问题时：

1. 将 `NEXUS_SESSION_BACKEND` 或 `data/session-backend.json` 改回 `tmux`。
2. 重启 `nexus`，不要为了回滚默认重启 `nexus-tmux.service`。
3. 验证 `/api/version` 返回 200 或 401，首页返回 200。
4. 新建 channel 验证 tmux attach。
5. 保留 `data/native-sessions/` 供诊断，不直接删除 registry 或 scrollback。

如果代码部署导致服务不可达，按 [DEPLOYMENT-RUNBOOK.md](../DEPLOYMENT-RUNBOOK.md) 回滚已部署版本。
