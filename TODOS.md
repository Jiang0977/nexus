# TODOS

最后更新：2026-09-03

## Open

- 通用 TUI 终端滚动能力与模式快照（P1，L）
  - What：把当前 `terminalApplicationScroll.ts` 的 Grok 标题识别升级为通用终端输入路由；在活跃浏览器中优先使用 xterm 公开的 mouse tracking / buffer 状态，并在 PTY broker 按会话增量跟踪 DEC 模式（至少 `47/1047/1049`、`1000/1002/1003`、`1006`、`1007`），为新连接和刷新提供版本化 `terminalState` 快照。
  - Why：应用名称/标题关键词会误伤普通 scrollback，也无法自动覆盖 Claude Code、Pi 等后续 TUI；当前新连接只重放最近输出，可能遗失早先的模式启用序列。
  - Pros：标准 mouse tracking 的 TUI 无需单独适配；非标准 TUI 只需声明通用 capability/profile，不再修改滚动代码；刷新、重连和 split pane 的状态一致。
  - Cons：需要增量 VT 解析和 WebSocket 协议兼容层；不能简单以 alternate screen 判定应用内滚动，否则会再次破坏 Codex 等场景的终端历史。
  - Context：输入路由优先级为标准终端模式 → Nexus 私有 capability/launch profile（`auto | scrollback | application-sgr`）→ 窗格级临时手动切换。`CSI ? 2026` 只是同步渲染状态，不得作为 TUI 身份或滚动能力证据；Grok 标题识别仅可作为可移除的 legacy fallback。
  - Ready when：先固定普通 shell scrollback、Codex、Grok、标准 mouse-tracking TUI 的行为基线；实现后覆盖 Claude Code/Pi fixture、TUI 进出、页面刷新、WebSocket 重连、split pane、PC 滚轮、移动触摸及 `Ctrl+wheel` 缩放，且删除应用名称特判后 `npm run test:browser`、`npm run build:frontend`、Rust/Node 定向测试全部通过。

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
