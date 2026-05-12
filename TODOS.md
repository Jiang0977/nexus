# TODOS

最后更新：2026-05-02

## Open

- 统一 tmux command helper（P2，M）
  - What：在 Phase 1 contract/boundary 工作完成后，把 `nexus-session-runtime`、`nexus-window-launch-runtime`、`nexus-pty-runtime` 里重复的 tmux command helper 收口到共享实现。
  - Why：当前多个 runtime 各自实现 `run_tmux` / `run_tmux_capture` / session existence 检查，长期会造成 stderr 处理、stdin/null 行为和错误格式分叉。
  - Pros：减少重复；后续 native backend 或 tmux compatibility work 更容易审计；错误行为更一致。
  - Cons：会跨 runtime 触碰生产路径，不适合塞进 Phase 1 第一轮重构。
  - Context：`/plan-eng-review` 已决定 Phase 1 先只在 `nexus-session-runtime` 内部收口 helper，`window_launch` 和 `pty_broker` 保持现状；此 TODO 是后续清债入口。
  - Depends on：完成 session backend contract freeze 和 `TmuxSessionBackend` extraction。

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
- `/api/tasks` SSE 断连不再取消后台任务；已在 2026-05-02 通过 Rust server 任务回归验证闭环
- 任务运行期 `stdout/stderr` 改为有界滚动缓冲；已在 2026-05-02 通过 Rust 单测与 server 任务回归验证闭环
