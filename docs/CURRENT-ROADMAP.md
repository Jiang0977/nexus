# CURRENT ROADMAP — Nexus

最后整理：2026-04-16

目的：给“当前到底还有哪些 TODO、下一步该做什么”一个短而硬的答案，避免继续被历史文档误导。

这份文档是执行层快照，不替代 [NORTH-STAR.md](NORTH-STAR.md)。

## 文档优先级

判断当前真实状态时，按以下优先级取信：

1. [NORTH-STAR.md](NORTH-STAR.md)
2. [TODOS.md](../TODOS.md)
3. 最新设计文档
   - [codex-history-sessions-tab.md](designs/codex-history-sessions-tab.md)
   - [node-backend-optimization.md](designs/node-backend-optimization.md)
4. [ARCHITECTURE.md](ARCHITECTURE.md)
5. [README.md](../README.md) / [README_CN.md](../README_CN.md)

以下文档只能当历史参考，不能直接当当前 backlog：

- [ROADMAP.md](ROADMAP.md)
- [story.md](story.md)
- [code.md](code.md)

原因：这些文档里有一部分内容已经落地但未迁出 backlog，或仍保留与锚点冲突的历史叙述。

## 当前 Open TODO

### P1. Codex 历史浏览器级回归

- What:
  - 用浏览器 smoke 覆盖桌面入口、移动入口、 `warning / empty / error / resume` 主路径。
- Why:
  - 当前主要证据还是单测、build、部署探活，缺真实 UI 行为留痕。
- Done when:
  - 桌面端可进入当前工作区内的 Codex 历史视图
  - 移动端 modal 入口可打开和返回
  - `warning / empty / error` 三种状态各有浏览器级验证记录
  - `resume` 主路径至少有一次真实 smoke
- Source:
  - [TODOS.md](../TODOS.md)
  - [codex-history-sessions-tab.md](designs/codex-history-sessions-tab.md)

### P1. Codex 历史可访问性收口

- What:
  - 给 `CodexSessionsPanel` 补齐键盘和读屏合同。
- Why:
  - 设计文档已定义 `Enter / Esc / focus / readable text`，但实现和验证还没完全闭环。
- Done when:
  - 关键交互有显式 keyboard path
  - `warning / error / row action` 有可读文本语义
  - 有最小自动化或浏览器验证证据
- Source:
  - [TODOS.md](../TODOS.md)
  - [codex-history-sessions-tab.md](designs/codex-history-sessions-tab.md)

### P2. `nexus` 启动 `left-over process` 运维债

- What:
  - 收口 `systemd` 重启时的 left-over process 告警，不破坏 tmux 持久化语义。
- Why:
  - 当前服务可用，但日志仍提示旧 cgroup 残留；这是运维债，不是功能阻塞。
- Done when:
  - 重启 `nexus` 后不再出现成串告警
  - tmux 持久化会话语义不回归
  - 相关 runbook 和任务文档同步更新
- Source:
  - [TODOS.md](../TODOS.md)
  - [node-backend-optimization.md](designs/node-backend-optimization.md)

## 已完成，不再算 Open Backlog

- Node backend optimization 主线已完成并部署。
- `TS runtime entry` 已完成。
- Codex 历史 `kill switch` 已完成。
- Codex 历史 `detail API` 与最小 detail 视图已完成。
- `DESIGN.md` 已完成。
- Codex 历史功能本体已实现并部署，剩下的是验证债，不是功能缺口。

## 当前主开发方向

按收益 / 风险比，下一阶段建议只做这四件事：

1. 补 Codex 历史浏览器级回归证据
2. 补 Codex 历史可访问性闭环
3. 处理 `left-over process` 运维债
4. 清理文档漂移，统一 backlog 口径

原因：

- 前两项是已上线能力的收口，最接近交付闭环。
- 第三项是当前唯一明确仍开的后端 / 运维债。
- 第四项不做，后续排期会持续被旧文档污染。

## 暂不建议当主线推进的事项

以下事项在历史文档里仍被提到，但不应直接拉成当前主线：

- 继续把 Node 后端优化当成大迁移主线
- 把 Codex 历史当成“待实现功能”
- 团队协作 / 多用户 / 共享终端
- 任务模板 / 插件系统 / 多种 webhook 扩张

原因：

- 前两项已经完成，继续写只会重复计账。
- 后两项和 [NORTH-STAR.md](NORTH-STAR.md) 的单用户边界不一致，至少不是当前承诺。

## 文档漂移清单

### `ROADMAP.md`

- 仍把 `Codex history sessions tab` 放在 v2 backlog。
- 仍把 `F-19 Project-Window hierarchy` 和 `F-20 Unified session manager` 放在 backlog。

但这些能力至少已部分落地，`README`、`PRD`、`ARCHITECTURE` 都已按“现状能力”在写。

### `story.md`

- 仍写“团队协作，共享会话（即将推出）”
- 仍写 MIT 许可证
- 仍写默认访问端口 `3000`

这些表述分别与：

- 单用户锚点
- 当前 GPL v3 + 商业授权
- 当前正式端口 `59000`

不一致。

### `code.md`

- 已经改写为当前 Rust runtime 入口和前端主路径的源码导览
- 后续如果继续拆 `rust-runtime/src/lib.rs` 或 runtime 边界，要同步更新模块地图

## 建议的文档清理顺序

1. 更新 [ROADMAP.md](ROADMAP.md)
   - 移出已完成项
   - 只保留真实还开的 backlog
2. 更新 [story.md](story.md)
   - 去掉团队协作 / MIT / `3000` 等错误信息
3. 继续维护 [code.md](code.md) 的模块地图，避免再次和真实结构脱节

## 部署约束

任何涉及代码上线的后续工作，仍然必须遵守：

- 重启 `nexus` 服务后再验证
- 前端改动先 `npm --prefix frontend run build`
- 后端改动先 `npm run build:rust-runtimes && npm run build:rust-server`
- 服务不可达就立即回滚

权威操作说明见 [DEPLOYMENT-RUNBOOK.md](DEPLOYMENT-RUNBOOK.md)。
