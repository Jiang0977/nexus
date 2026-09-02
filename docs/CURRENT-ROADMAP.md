# CURRENT ROADMAP — Nexus

最后整理：2026-09-01

目的：给“当前到底还有哪些 TODO、下一步该做什么”一个短而硬的答案，避免继续被历史文档误导。

这份文档是执行层快照，不替代 [NORTH-STAR.md](NORTH-STAR.md)。

## 文档优先级

判断当前真实状态时，按以下优先级取信：

1. [NORTH-STAR.md](NORTH-STAR.md)
2. [TODOS.md](../TODOS.md)
3. 最新设计文档
   - [codex-history-sessions-tab.md](designs/codex-history-sessions-tab.md)
   - [session-backend-contract.md](designs/session-backend-contract.md)
   - [native-session-backend-cross-platform.md](designs/native-session-backend-cross-platform.md)
4. [ARCHITECTURE.md](ARCHITECTURE.md)
5. [README.md](../README.md) / [README_CN.md](../README_CN.md)

以下文档不作为 backlog 权威来源，但内容已基本对齐当前实现，可作为补充阅读：

- [ROADMAP.md](ROADMAP.md)
- [story.md](story.md)
- [code.md](code.md)

原因：它们的职责分别是优先级摘要、叙事介绍和源码导览，不应该反过来覆盖 `TODOS.md` 与设计文档。

## 当前 Open TODO

- P2：统一剩余 tmux command helper。当前重复点在 `nexus_session_runtime/tmux_backend.rs`、`nexus-window-launch-runtime.rs` 和 `server/runtime.rs`；范围与准入条件以 [TODOS.md](../TODOS.md) 为准。
- native session backend 已有 opt-in/staging 实现，但不算“默认生产化已完成”。如果要推进为默认 backend，需要重新建账，至少覆盖跨平台验证、生产 rollout、回滚和 NORTH-STAR 边界确认。

## 已完成，不再算 Open Backlog

- Node backend optimization 主线已完成并部署。
- `TS runtime entry` 已完成。
- Codex 历史 `kill switch` 已完成。
- Codex 历史 `detail API` 与最小 detail 视图已完成。
- Codex 历史浏览器级回归已完成。
- Codex 历史可访问性收口已完成。
- `nexus` 启动 `left-over process` 运维债已完成。
- `DESIGN.md` 已完成。
- Codex 历史功能与验证债都已闭环；证据见 [codex-history-browser-smoke-2026-04-21.md](verification/codex-history-browser-smoke-2026-04-21.md)。
- systemd residue 关闭证据见 [systemd-residue-smoke-2026-04-21.md](verification/systemd-residue-smoke-2026-04-21.md)。
- README / README_CN 已在 2026-05-20 删除旧视频演示和旧营销叙事，改为当前 Rust runtime + tmux/native backend 事实说明。
- session backend capability ports、共享 Codex HOME 物化、共享 child runtime protocol 与前端 terminal connection adapter 已完成，当前边界见 [ARCHITECTURE.md](ARCHITECTURE.md)。
- 2026-09-01 阶段收口（当前仓库源码与本地测试回归已闭环，本轮未执行 production deploy/restart）：
  - 旧外部 IM 接入从源码、配置、文档和测试中完整移除
  - secure installer credentials+loopback+0600、upload/workspace Bearer、login per-peer rate limit
  - PWA /sw.js registration
  - checkout/install-tree deploy sync+rollback helper

## 当前主开发方向

按当前仓库状态，没有未闭环的 P1 runtime backlog；只有一项 P2 tmux helper 清债。后续功能或回归应重新建账，不要把已闭环主线重新列为待办。

native backend 当前只应按 opt-in/staging 处理。它不是当前默认生产主线，也不应在 README 或部署文档里写成“tmux 已被替换”。

## 暂不建议当主线推进的事项

以下事项在历史文档里仍被提到，但不应直接拉成当前主线：

- 继续把 Node 后端优化当成大迁移主线
- 把 Codex 历史当成“待实现功能”
- 把 `left-over process` 继续当成当前阻塞主线
- 团队协作 / 多用户 / 共享终端
- 任务模板 / 插件系统 / 多种 webhook 扩张

原因：

- 前三项已经完成，继续写只会重复计账。
- 后两项和 [NORTH-STAR.md](NORTH-STAR.md) 的单用户边界不一致，至少不是当前承诺。

## 文档同步状态

### `ROADMAP.md`

- 只保留当前 open backlog、候选方向和权威来源，不再复制按会话记录的完成清单。

它现在可以当优先级摘要读，但具体 Done when 仍以 [TODOS.md](../TODOS.md) 为准。

### `story.md`

- 已对齐到单用户、自托管、GPL v3 + 商业授权和默认访问端口 `59000`。
- 它仍是叙事文，不是产品承诺或 backlog 入口。

### `code.md`

- 已同步为当前 Rust runtime、`server/` 模块和前端源码/产物双层结构的导览。
- 后续如果继续拆 `rust-runtime/src/server/` 或前端主入口，还要继续同步模块地图。

### `README.md` / `README_CN.md`

- 已重写为当前项目入口说明。
- 已删除旧视频 showcase、旧竞品比较表和“纯 tmux”单一路径叙事。
- 当前口径：`tmux` 是默认稳定 backend；`native` 是 opt-in/staging backend。

## 文档维护顺序

1. 先改 [TODOS.md](../TODOS.md) 和最新设计文档
2. 再同步 [ROADMAP.md](ROADMAP.md) 摘要
3. 最后补 [story.md](story.md) / [code.md](code.md) 这种叙事或导览文档

## 部署约束

任何涉及代码上线的后续工作，仍然必须遵守：

- 重启 `nexus` 服务后再验证
- 确认 `frontend/dist/index.html` 仍存在
- Rust 改动先 `cargo build --manifest-path rust-runtime/Cargo.toml --release --bin nexus-server --bin nexus-pty-runtime --bin nexus-native-pty-supervisor --bin nexus-native-session --bin nexus-window-launch-runtime --bin nexus-session-runtime --bin nexus-codex-home`
- 服务不可达就立即回滚

权威操作说明见 [DEPLOYMENT-RUNBOOK.md](DEPLOYMENT-RUNBOOK.md)。
