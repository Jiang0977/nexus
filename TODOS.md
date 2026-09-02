# TODOS

最后更新：2026-09-01

## Open

- 统一 tmux command helper（P2，M）
  - What：把 `nexus_session_runtime/tmux_backend.rs`、`nexus-window-launch-runtime.rs` 和 `server/runtime.rs` 中剩余的 tmux command / capture helper 收口到共享实现。
  - Why：当前三个生产路径仍各自执行 tmux，长期会造成 stderr、stdin/null、timeout 和错误格式分叉。
  - Pros：减少重复；后续 native backend 或 tmux compatibility work 更容易审计；错误行为更一致。
  - Cons：会跨 session、window launch 与 server snapshot 三条生产路径，必须逐切片锁定错误语义。
  - Context：session backend capability boundary 已完成；这项工作只统一 tmux transport helper，不改变默认 backend 或公开协议。
  - Ready when：为 command、capture、stderr 为空和进程失败建立共享 contract test 后再迁移调用点。

## Closed

以下主线已完成并已验证/部署，不再算 open TODO：

- Node backend optimization 主线
- `TS runtime entry`
- Codex 历史 `kill switch`
- Codex 历史 `detail API` 与最小 detail 视图
- Codex 历史浏览器级回归
- Codex 历史可访问性收口
- `nexus` 启动 `left-over process` 运维债
- `DESIGN.md`
- session backend capability ports、Codex HOME 物化、child runtime JSON-line protocol 和浏览器 terminal connection policy 已在 2026-07-25 完成架构收口
- 2026-09-01 阶段收口（注：以下为当前仓库实现与本地回归验证闭环，不代表已部署）：
  - 旧外部 IM 接入从源码、配置、文档和测试中完整移除
  - secure installer credentials+loopback+0600、upload/workspace Bearer、login per-peer rate limit
  - PWA /sw.js registration
  - checkout/install-tree deploy sync+rollback helper
