# TODOS

最后更新：2026-09-10

## Open

- 通用 TUI 终端滚动能力与模式快照（P1，L）
  - 已批准范围：先完成默认 tmux 的真实重绘恢复，native 完整状态引擎另行推进；任务拆分与兼容边界见 [tmux 恢复设计](docs/designs/tmux-terminal-redraw.md)。tmux 主线已本地实现，真实 tmux 验收由红灯转为通过。
  - 历史进度：早期 tmux 路径已部署并通过真实验收，见 [部署记录](docs/verification/tmux-deployment-2026-09-10.md)。下列 `b90bde3` 记录是此前阶段快照，不代表当前 native 实现状态。
  - 当前进度：native 完整 checkpoint、共享最小尺寸、Unicode 11 一致性、显式 channel scroll profile 已实现；真实 Chrome + PTY 对比、Rust 222 项（含 vendored avt 104 项）、Node 215 项通过。隔离 native 端到端验收通过，最终部署及本机 AI CLI 启动验收进行中。实现与限制见 [native checkpoint 设计](docs/designs/native-terminal-checkpoint.md)。
  - 后续迭代（`b90bde3` 已部署并重启 nexus）：已移除 Grok legacy 标题分支，提供每窗格“自动滚动 / 应用滚动 (SGR)”临时选择。标准模式优先、同目标重连保留、换通道/刷新重置；覆盖 Claude Code/Pi 协议 fixture、旧标题不误路由、分屏隔离。native 重连误杀 fallback PTY 的 3 项历史失败已修复，但不等于完成 native 状态恢复，既有 supervisor 未重启。Rust 110、Node 207（含浏览器 43）及提交后的完整门禁全部通过，真实入口的 12 项浏览器检查和 60 次握手通过，见 [本机生产部署验收](docs/verification/production-readiness-2026-09-10.md)。
  - What：活跃浏览器优先使用 xterm 公开 mouse tracking / buffer 状态。tmux 新连接由 tmux 恢复；native 使用有界完整状态 checkpoint，不再依赖最近 2000 字符尾片段。
  - Why：应用名称/标题关键词会误伤普通 scrollback；ANSI 尾片段不能恢复完整 TUI。两条后端均已移除这类恢复依赖。
  - Pros：标准 mouse tracking 的 TUI 无需单独适配；非标准 TUI 只需声明通用 capability/profile，不再修改滚动代码；刷新、重连和 split pane 的状态一致。
  - Cons：tmux 每个网页连接多一个 client PTY；底层 pane 尺寸仍遵循 tmux window-size 策略。native 状态引擎另有实现成本；不能简单以 alternate screen 判定应用内滚动，否则会再次破坏 Codex 等场景的终端历史。
  - Context：已实现标准终端模式 → 显式 channel profile → 窗格临时手动切换。`CSI ? 2026` 不作为身份或滚动能力证据。物理手机、AI 推理供应商可用性及非标准图形扩展不由协议 fixture 验收替代。
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
