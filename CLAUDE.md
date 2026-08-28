# CLAUDE.md — Nexus Development Standards

Project: **Nexus** — Rust 本地 AI agent 工作台，默认 tmux 后端，native PTY 后端 opt-in
Anchor: `docs/NORTH-STAR.md` — 修改任何文档前先对照锚点三原则

---

## Tech Stack

| Layer | Tech |
|---|---|
| Backend | Rust `nexus-server` + Rust child runtimes |
| Frontend | React / TypeScript source in `frontend/src/`; vendored static bundle in `frontend/dist/` |
| Auth | JWT (30d) + bcrypt password hash |
| Runtime | 宿主机（WSL2）直接运行，`start.sh` 默认拉起 Rust server |
| Config | `.env` 由 Rust `nexus-server` 读取 |
| Persist | `./data/`（toolbar config、session configs、tasks、uploads、native registry） |

## Architecture Constraints

- **多 PTY 架构**（F-11）：每个 project/channel 独立 PTY；默认映射到 `tmux session:window`，native 模式映射到 Rust PTY/supervisor
- Rust `nexus-server` 静态伺服 `frontend/dist/` + `public/`
- 默认稳定 session backend 是 `tmux`
- `native` backend 是 opt-in/staging；不要写成默认生产路径，必须保留 tmux 回退能力
- `data/native-sessions/session.db` 只服务 native session registry，不是通用业务数据库
- `WORKSPACE_ROOT` 指向宿主机工作区根目录，由 Rust server 直接访问
- 不要把 PM2 重新带回默认运行链；Node/npm 只用于前端开发、测试和构建，不是线上服务管理入口

## Key Files

```
rust-runtime/src/bin/
  nexus-server.rs          # 默认后端入口：HTTP + WS + runtimes + Telegram
  nexus-pty-runtime.rs     # tmux/native PTY attach
  nexus-native-pty-supervisor.rs
  nexus-native-session.rs
rust-runtime/tests/        # Rust integration tests for startup/setup/bundle paths
data/                      # 持久化数据（toolbar、tasks、configs）
public/
  sw.js                    # Service Worker（cache-first 静态资源）
  icon.svg                 # PWA 图标
frontend/src/              # React / TypeScript source
frontend/dist/             # vendored 前端静态资源
docs/
  NORTH-STAR.md            # 锚点文件（核心问题/用户/Out-of-Scope）
  PRD.md                   # 功能规格
  ROADMAP.md               # 迭代路线图
  ARCHITECTURE.md          # 架构现状
```

## Agent Workflow Rules

- **用 `/plan`**：涉及多文件改动、架构变更、新 API endpoint、PTY 行为变更
- **用 `/tdd`**：新增工具栏按键逻辑、认证流程、API endpoint
- **直接做**：单文件 UI 调整、样式修复、文档更新

## Definition of Done

- Implementation matches requirements — no speculative features
- `docs/NORTH-STAR.md` 三原则未被违反（对照确认）
- Manual verification：打开浏览器验证受影响的用户流
- Commit follows standard below

## Version Management

**Source of truth: git tag**（`git describe --tags --abbrev=0`）

发布流程：

```bash
git status
git commit -am "chore: prepare release X.Y.Z"
git tag vX.Y.Z
git push && git push --tags
```

不要在代码、静态资源或文档里手工维护第二份版本号。

## Git Commit Standard

```
type(scope): imperative subject ≤ 72 chars

Body (optional, any language): explain why, not what.
Bug fixes: explain root cause.

Co-Authored-By: Claude <noreply@anthropic.com>
```

Types: `feat` `fix` `docs` `refactor` `test` `chore` `style`

Rules: English subject, imperative mood, no trailing period, blank line before body, **Co-Authored-By trailer required**.

## Code Standards

### General
- Implement only what the current task requires
- No speculative features, no opportunistic cleanup
- One logical change per commit

### Frontend
- 当前仓库同时保留 `frontend/src/` 和 `frontend/dist/`
- 改 `frontend/src/` 后必须重建 `frontend/dist/`
- 线上 Rust server 仍只伺服 `frontend/dist/` + `public/`
- 任何前端 bundle 变更都要同步更新运行文档和验证记录

### Security
- Secrets via env vars only — never hardcoded
- `.env` must not be committed (verify `.gitignore`)
- CORS: production must list explicit origins, no wildcards

## Agentic Behavior

- **Minimal footprint**: use only permissions needed
- **Prefer reversible actions**: confirm before destructive ops
- **Pause and ask** when scope exceeds request, destructive side-effect discovered, or intent is unclear
- **No opportunistic work**: no unrequested refactoring

## Documentation Map

| Change type | Update |
|---|---|
| New feature / interface | `README.md` + `docs/PRD.md` |
| Roadmap / scope change | `docs/ROADMAP.md` |
| Architecture change | `docs/ARCHITECTURE.md` |
| Process / convention | `CLAUDE.md` (this file) |
| Env var added | `.env.example` + `docs/QUICKSTART.md` + `docs/DEPLOYMENT-RUNBOOK.md` |
| Bug fix | commit body (root cause) |
