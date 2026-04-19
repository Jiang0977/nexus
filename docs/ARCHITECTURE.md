# Nexus Architecture

最后更新：2026-04-19

目标：给维护者一个当前真实可运行的结构图，不保留已经删除的 Node/npm/PM2 叙事。

## 当前运行形态

```text
Browser / PWA
  ↕ WebSocket / REST
Rust server (nexus-server)
  ↕ Rust child runtimes
tmux session:window
  ↕ shell / claude / codex
```

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
  -> 必要时补构建缺失的 Rust release binaries
  -> 启动 rust-runtime/target/release/nexus-server
```

### 安装器路径

```text
./setup.sh
  -> cargo run --bin nexus-setup --release
  -> 写入 systemd user units
  -> 启动 nexus-tmux.service
  -> 启动 nexus.service
```

### 关键约束

- `start.sh` 不会重建前端静态资源
- Rust 代码改动后要先显式 `cargo build --release`
- 前端代码改动后要在 `frontend/` 下显式构建
- `frontend/dist/` 缺失时服务直接失败

## Rust 模块边界

### 入口与装配

| 文件 | 作用 |
|---|---|
| `rust-runtime/src/bin/nexus-server.rs` | HTTP / WS 路由、runtime 装配、静态资源伺服 |
| `rust-runtime/src/lib.rs` | 共享模块出口 |

### 共享逻辑

| 文件 | 作用 |
|---|---|
| `rust-runtime/src/runtime_config.rs` | `.env`、可执行路径、数据目录解析 |
| `rust-runtime/src/path_utils.rs` | 路径规整、静态文件保护、递归复制/删除 |
| `rust-runtime/src/shell.rs` | shell 类型与命令规划 |
| `rust-runtime/src/project_defaults.rs` | 默认 shell / profile 持久化 |
| `rust-runtime/src/sanitize.rs` | 文件名、窗口名、用户输入清洗 |
| `rust-runtime/src/auth.rs` | JWT 校验 |

### Child runtimes

| 文件 | 作用 |
|---|---|
| `rust-runtime/src/bin/nexus-session-runtime.rs` | projects / channels / sessions / Codex 历史 |
| `rust-runtime/src/bin/nexus-window-launch-runtime.rs` | 新建窗口和 shell 启动 |
| `rust-runtime/src/bin/nexus-pty-runtime.rs` | PTY attach / output / broker |
| `rust-runtime/src/bin/nexus-task-runtime.rs` | 任务执行协议 |
| `rust-runtime/src/bin/nexus-codex-home.rs` | Codex 隔离 home 物化 |
| `rust-runtime/src/bin/nexus-setup.rs` | `.env` + systemd user units + tmux bootstrap |

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

## 数据落点

默认数据目录：`data/`

| 路径 | 内容 |
|---|---|
| `data/tasks.json` | 异步任务历史 |
| `data/toolbar-config.json` | 工具栏配置 |
| `data/project-shell-defaults.json` | 项目默认 shell / profile |
| `data/configs/` | Claude profile |
| `data/codex-configs/` | Codex profile |
| `data/uploads/` | 上传文件 |
| `data/codex-runtime/` | Codex runtime 辅助数据 |

事实源说明：

- tmux 是交互会话事实源
- `~/.codex` 是共享 Codex 历史事实源
- `data/` 主要保存配置和任务历史，不是业务数据库

## 运维现实

默认守护方式是 `systemd`，不是 PM2。

相关文件：

| 文件 | 说明 |
|---|---|
| `start.sh` | 前台启动入口 |
| `setup.sh` | 安装器入口 |
| `scripts/nexus-tmux-service.sh` | tmux 守护脚本 |
| `deploy/systemd/nexus.service` | systemd 服务样例 |
| `deploy/systemd/nexus-tmux.service` | tmux 服务样例 |

## 验证面

当前权威验证路径：

```bash
cargo test --manifest-path rust-runtime/Cargo.toml
```

重点覆盖：

- `nexus-setup` 不再依赖 Node/PM2
- `start.sh` 对 vendored frontend bundle 的行为
- `frontend/dist/` 资源完整性 smoke

## 不要再做的事

- 不要把 PM2 重新带回默认运行链
- 不要把前端源码误当成运行时入口，线上仍靠 `frontend/dist/`
- 不要把过时文档里的 `npm run setup` / `pm2 start` 当成有效指令
