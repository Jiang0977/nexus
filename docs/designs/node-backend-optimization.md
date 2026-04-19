# Node Backend Optimization

Status: Archived historical document
Original completion date: 2026-04-15
Archived after Rust runtime cutover: 2026-04-18

## Read This First

本文记录的是 2026-04-15 那条“先把旧 Node 后端整理干净”的阶段性成果。它不是当前运行时说明。

当前源码树的默认启动链已经切到 [`start.sh`](/home/demo/workspace/rust/nexus/start.sh) -> Rust `nexus-server`；旧 Node 后端入口、旧编译产物入口，以及对应的后端业务服务源码都已从当前分支删除。保留这份文档，只是为了说明当时为什么先做 Node 边界清理，再继续推进整体 Rust 化。

当前事实源见：

- [ARCHITECTURE.md](/home/demo/workspace/rust/nexus/docs/ARCHITECTURE.md)
- [DEPLOYMENT-RUNBOOK.md](/home/demo/workspace/rust/nexus/docs/DEPLOYMENT-RUNBOOK.md)
- [code.md](/home/demo/workspace/rust/nexus/docs/code.md)

## Historical Outcome

当时已经完成并验证的旧 Node 主线包括：

- runtime guards
- `PTY/tmux broker`
- backend typecheck foundation
- `task runner`
- `workspace service`
- `configs/profiles service`
- `telegram bridge`
- `session management service`
- `window launch service`
- `upload/files service`
- `version service`
- `broker sidecar PoC`
- `task runner sidecar`
- TS runtime entry

这条主线的历史意义只有两点：

- 把旧后端的高风险边界先拆干净，避免继续在一坨巨石里堆逻辑
- 给后续 Rust 运行时切换提供可比较的边界和验证面

## Historical Scope

当时锁定的目标：

- 给旧后端补最小稳定性护栏
- 把高风险边界从旧入口中拆出
- 建立后端类型检查和编译产物运行时入口
- 为未来 sidecar 或更强类型约束保留清晰接口

当时明确不做：

- 不在那一轮直接重写整个后端为 Rust
- 不替换 Express、WebSocket、`node-pty` 或 tmux
- 不改变既有前端 REST / WS / SSE 协议形状
- 不引入数据库，继续兼容 `data/*.json`

## Historical Validation

2026-04-15 结案时跑过的验证主要是：

- `node --test`
- `npm run typecheck:server`
- `npm run build:server`
- `npm --prefix frontend run build`

这些验证现在只代表“那次 Node 优化分支当时已收口”，不代表当前源码的现行部署方式。

## Residual Historical Debt

这条主线结案时还剩一项被降级的运维债：

- `systemd` 重启时仍会提示 left-over processes

它不再是“Node backend optimization”主线的一部分，也不该成为重新引入旧 Node 运行时的理由。
