# Nexus 源码导览

最后更新：2026-04-19

目标：告诉维护者“现在该从哪里读”，不保留已经删除的 Node/frontend source 入口。

## 先知道三件事

1. 真实启动链是 `start.sh -> rust-runtime/target/release/nexus-server`
2. 浏览器 UI 来自 vendored `frontend/dist/`
3. tmux 是会话事实源，`data/` 只保存配置和任务历史

## 推荐阅读顺序

1. `start.sh`
2. `rust-runtime/src/lib.rs`
3. `rust-runtime/src/bin/nexus-server.rs`
4. `rust-runtime/src/bin/nexus-session-runtime.rs`
5. `rust-runtime/src/bin/nexus-window-launch-runtime.rs`
6. `rust-runtime/src/bin/nexus-pty-runtime.rs`
7. `rust-runtime/src/bin/nexus-task-runtime.rs`
8. `rust-runtime/tests/*.rs`

## 根目录里最重要的文件

| 路径 | 作用 |
|---|---|
| `start.sh` | 前台启动入口 |
| `setup.sh` | Rust 安装器入口 |
| `nexus-run-claude.sh` | Claude shell 启动脚本 |
| `nexus-run-codex.sh` | Codex shell 启动脚本 |
| `frontend/dist/` | vendored 前端静态资源 |
| `public/` | PWA 静态资源 |
| `rust-runtime/src/bin/*.rs` | 运行时与 child runtimes |
| `rust-runtime/tests/*.rs` | Rust integration tests |

## Rust 模块地图

### 入口

| 文件 | 作用 |
|---|---|
| `rust-runtime/src/bin/nexus-server.rs` | HTTP / WS / 静态资源 / runtime 装配 |
| `rust-runtime/src/lib.rs` | 共享 helper 出口 |

### 共享逻辑

| 文件 | 作用 |
|---|---|
| `rust-runtime/src/runtime_config.rs` | 运行时配置解析 |
| `rust-runtime/src/path_utils.rs` | 路径与静态文件保护 |
| `rust-runtime/src/shell.rs` | shell 类型和命令规划 |
| `rust-runtime/src/project_defaults.rs` | 默认 shell / profile 持久化 |
| `rust-runtime/src/sanitize.rs` | 字符串与文件名清洗 |
| `rust-runtime/src/auth.rs` | JWT helper |

### runtimes

| 文件 | 作用 |
|---|---|
| `rust-runtime/src/bin/nexus-session-runtime.rs` | project / channel / session / Codex 历史 |
| `rust-runtime/src/bin/nexus-window-launch-runtime.rs` | 新建窗口和 shell 启动 |
| `rust-runtime/src/bin/nexus-pty-runtime.rs` | PTY attach / output / broker |
| `rust-runtime/src/bin/nexus-task-runtime.rs` | task 执行协议 |
| `rust-runtime/src/bin/nexus-codex-home.rs` | Codex 隔离 home |
| `rust-runtime/src/bin/nexus-setup.rs` | `.env` + systemd + tmux bootstrap |

## 当前前端现实

当前仓库只有编译后的前端 bundle：

| 路径 | 作用 |
|---|---|
| `frontend/dist/index.html` | 单页入口 |
| `frontend/dist/assets/*` | JS/CSS bundle |
| `public/icon.svg` | 图标 |
| `public/manifest.json` | PWA manifest |
| `public/sw.js` | Service worker |

当前仓库没有：

- `frontend/src/`
- `package.json`
- `tests/*.test.js`
- 仓库内 Node toolchain

## 最重要的调用链

### 打开首页

1. 浏览器请求 `/`
2. `nexus-server` 返回 `frontend/dist/index.html`
3. 浏览器继续加载 `frontend/dist/assets/*`
4. 页面通过 REST / WS 连接 Rust server

### 终端 attach

1. 浏览器建 WebSocket 到 `/ws`
2. `nexus-server` 把请求转给 `nexus-pty-runtime`
3. PTY runtime attach 到目标 `tmux session:window`
4. 浏览器和 tmux 双向 I/O

### 新建 project / channel

1. 浏览器调 `/api/projects` 或 `/api/sessions`
2. `nexus-server` 协调 `nexus-session-runtime` / `nexus-window-launch-runtime`
3. child runtime 操作 tmux
4. 浏览器刷新列表

## 验证入口

```bash
cargo test --manifest-path rust-runtime/Cargo.toml
```

如果改动启动链或安装器，再额外跑：

```bash
cargo build --manifest-path rust-runtime/Cargo.toml --release --bin nexus-server --bin nexus-task-runtime --bin nexus-pty-runtime --bin nexus-window-launch-runtime --bin nexus-session-runtime --bin nexus-setup
```

## 别再踩的坑

- 不要再找 `frontend/src/`，它已经不在仓库里
- 不要把 `pm2` 或 `npm` 当成有效运维入口
- 不要把 `data/` 当数据库
- 不要把历史文档里的 Node 叙事当当前事实
