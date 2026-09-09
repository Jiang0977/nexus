# TODOS

最后更新：2026-09-10

## Open

- 通用 TUI 终端滚动能力与模式快照（P1，L）
  - 已批准范围：先完成默认 tmux 的真实重绘恢复，native 完整状态引擎另行推进；任务拆分与兼容边界见 [tmux 恢复设计](docs/designs/tmux-terminal-redraw.md)。tmux 主线已本地实现，真实 tmux 验收由红灯转为通过。
  - 当前进度：代码已于 2026-09-10 部署；经用户单独授权，生产后端已从 native 切换为 tmux 并重启 nexus。独立端口与生产主入口均已通过真实 tmux 验收，见 [部署记录](docs/verification/tmux-deployment-2026-09-10.md)。已接入 xterm 6、公开 buffer 滚动观测、移动端单一手势处理器、文本/二进制输入分流、PTY 增量 UTF-8 解码及连接错误 UI；tmux 每连接独立 client、真实重绘握手、重连有序重置、丢包重连及清理已实现。Grok legacy 标题分支、native 完整恢复与 capability/profile 路由仍未完成，本项保持 Open。
  - What：把当前 `terminalApplicationScroll.ts` 的 Grok 标题识别升级为通用终端输入路由；活跃浏览器优先使用 xterm 公开 mouse tracking / buffer 状态。tmux 新连接由 tmux 自身恢复模式和屏幕，不再重复建设 broker DEC 模式解析器；native 后续需单独验证完整状态引擎，不能仅重放 DEC 标志或 ANSI 尾片段。
  - Why：应用名称/标题关键词会误伤普通 scrollback，也无法自动覆盖 Claude Code、Pi 等后续 TUI；旧的最近输出重放会遗失早先的模式启用序列，现已在 tmux 路径移除，native 尚待处理。
  - Pros：标准 mouse tracking 的 TUI 无需单独适配；非标准 TUI 只需声明通用 capability/profile，不再修改滚动代码；刷新、重连和 split pane 的状态一致。
  - Cons：tmux 每个网页连接多一个 client PTY；底层 pane 尺寸仍遵循 tmux window-size 策略。native 状态引擎另有实现成本；不能简单以 alternate screen 判定应用内滚动，否则会再次破坏 Codex 等场景的终端历史。
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
