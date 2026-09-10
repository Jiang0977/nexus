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
| Runtime | Linux 宿主机（含 WSL2）直接运行，`start.sh` 默认拉起 Rust server |
| Config | `.env` 由 Rust `nexus-server` 读取 |
| Persist | `./data/`（toolbar config、session configs、prompts、uploads、native registry） |

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
  nexus-server.rs          # 默认后端入口：HTTP + WS + runtimes
  nexus-pty-runtime.rs     # tmux/native PTY attach
  nexus-native-pty-supervisor.rs
  nexus-native-session.rs
rust-runtime/tests/        # Rust integration tests for startup/setup/bundle paths
data/                      # 持久化数据（toolbar、prompts、configs）
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

- 以 AGENTS.md 和当前用户授权为准；复杂或高风险改动先给简短计划。
- 行为修复使用针对性复现/回归；普通文档修改不引入额外测试框架。
- 验证与提交遵循 CONTRIBUTING.md；发布遵循 docs/RELEASING.md。

## Definition of Done

- Implementation matches requirements — no speculative features
- `docs/NORTH-STAR.md` 三原则未被违反（对照确认）
- Manual verification：打开浏览器验证受影响的用户流
- Commit follows standard below

## Version Management

发布步骤以 `docs/RELEASING.md` 为准。源码 checkout 通过 Git tag/status 报告版本；
无 `.git` 的发行包通过生成的 `VERSION` 文件报告版本。打包前同步 root/frontend
package.json 与 lockfile 版本，然后从经过检查的干净提交构建二进制及对应源码。
不要用 `git commit -am` 遗漏新文件，也不要无差别推送所有历史标签。

## Git Commit Standard

```
type(scope): imperative subject ≤ 72 chars

Body (optional, any language): explain why, not what.
Bug fixes: explain root cause.

```

Types: `feat` `fix` `docs` `refactor` `test` `chore` `style`

Rules: English subject, imperative mood, no trailing period, blank line before body, only add co-author trailers when they accurately describe the contribution.

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
