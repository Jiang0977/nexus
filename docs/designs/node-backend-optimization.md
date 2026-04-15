# Node Backend Optimization

Status: Completed / deployed
Date: 2026-04-15
Branch: master

Authored with:
- `/doc-coauthoring` (2026-04-15)

## Outcome

这条优化主线已经完成并上线。目标不是“把 Node 彻底重写掉”，而是把最容易继续烂掉的边界先拆清楚，让后续维护、测试和未来 sidecar 替换有明确落点。

已完成并验证的阶段：

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
- `TS runtime entry`

当前结果：

- 启动链已切到 [`start.sh`](/home/jiang/workspace/typescript/nexus4cc/start.sh) -> `node dist-server/server.js`
- `server.js` 已明显收窄，broker 与 task runner 均有清晰替换边界
- Node 后端优化主线已收口，不再把它当作 open backlog 主项

## Goals

- 给 Node 后端补齐最小稳定性护栏
- 把高风险边界从 `server.js` 中拆出
- 建立后端类型检查和编译产物运行时入口
- 为未来 sidecar 或更强类型约束保留清晰接口

## Non-goals

- 不重写整个后端为 Rust
- 不替换 Express、WebSocket、`node-pty` 或 tmux
- 不改变既有前端 REST / WS / SSE 协议形状
- 不引入数据库，继续兼容 `data/*.json`

## Validation

本轮主线的最终验证已经完成：

- `node --test` 覆盖 runtime entry、Codex 历史、feature flag、detail API 等关键回归
- `npm run typecheck:server`
- `npm run build:server`
- `npm --prefix frontend run build`
- `node --check server.js`
- `PORT=59001 HOST=127.0.0.1 node dist-server/server.js` 预演返回 `200 OK`
- 正式部署后 `nexus.service` 运行于 `node dist-server/server.js`
- `http://127.0.0.1:59000` 探活返回 `200 OK`

部署与重启约束见 [DEPLOYMENT-RUNBOOK.md](/home/jiang/workspace/typescript/nexus4cc/docs/DEPLOYMENT-RUNBOOK.md)。

## Remaining Debt

这条主线完成后，还剩一个相关但不阻塞上线的运维债：

- `systemd` 重启时仍会提示 left-over processes

这项已从“Node backend optimization 主线”降级为独立 TODO，不再阻塞当前后端结构主线的结案。

## Checklist

### Immediate
- [x] 为 runtime guards 补测试
- [x] 为 `PTY/tmux broker` 补测试
- [x] 抽离 runtime / lifecycle wiring
- [x] 抽离 `PTY/tmux broker`
- [x] 为后端增加 typecheck 基础设施

### Next
- [x] 抽离 `task runner`
- [x] 抽离 `workspace/files`
- [x] 抽离 `configs/profiles`
- [x] 抽离 `telegram bridge`
- [x] 抽离 `session/project/codex-session` 管理路由
- [x] 抽离 `window launch` 与 `upload/files` 管理路由
- [x] 抽离 `version/update-check` 路由
- [x] 落地 `broker sidecar PoC`
- [x] 落地 `task runner sidecar`

### Later
- [x] 把 Node 入口切到 TS 编译产物运行时
