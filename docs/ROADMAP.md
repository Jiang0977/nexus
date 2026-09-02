# ROADMAP — Nexus

最后更新：2026-09-01

锚点：[NORTH-STAR.md](NORTH-STAR.md)

执行事实源：[TODOS.md](../TODOS.md)

详细状态：[CURRENT-ROADMAP.md](CURRENT-ROADMAP.md)

## 当前优先级

### P2：统一剩余 tmux command helper

当前重复点：

- `rust-runtime/src/bin/nexus_session_runtime/tmux_backend.rs`
- `rust-runtime/src/bin/nexus-window-launch-runtime.rs`
- `rust-runtime/src/server/runtime.rs`

目标是统一 command、capture、stderr 与进程失败语义，不改变默认 tmux backend、native opt-in 边界或公开 HTTP/WS 协议。准入条件和完成标准以 [TODOS.md](../TODOS.md) 为准。

## 候选方向

以下只是候选，不是已承诺 backlog；进入开发前必须重新写目标、边界和验证计划：

- native backend 生产化：真实 macOS / Windows / WSL2 验证、native browser smoke、registry migration/repair、灰度与回滚演练。
- 开源发布/生产演练：跨平台验证、真实部署演练、回滚演练和发布证据。

native 当前仍是 opt-in/staging。默认生产路径保持 tmux，详见 [native-session-backend-cross-platform.md](designs/native-session-backend-cross-platform.md)。

## 已完成能力去哪里查

- 当前架构与模块边界：[ARCHITECTURE.md](ARCHITECTURE.md)
- v1 产品验收范围：[PRD.md](PRD.md)
- 具体设计与验证：`docs/designs/`、`docs/verification/`
- 精确变更历史：Git commits / tags

本文件不再维护逐会话完成清单，也不复制 Git 历史。
