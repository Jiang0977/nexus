# Node Backend Optimization

Status: In progress / runtime, broker, typecheck, task, workspace, config/profile, telegram, session management, window launch, upload/files, version/update-check, broker sidecar PoC, task runner sidecar completed
Date: 2026-04-15
Branch: master

Authored with:
- `/doc-coauthoring` (2026-04-15)

## Progress Update

截至 2026-04-15，以下阶段已经落地并验证：

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

当前 `server.js` 已明显收窄，broker 与 task runner 两条 sidecar IPC 合同也都已落地。下一步若继续推进，优先目标应转向 `TS runtime entry`，而不是继续在入口层做零散收口。

## Problem

当前 Node 后端的核心复杂度主要集中在 [`server.js`](/home/demo/workspace/typescript/nexus4cc/server.js)：

- 启动与关闭逻辑分散
- 缺少进程级异常与 server 监听错误兜底
- `PTY/tmux` 生命周期、WebSocket 协议处理、任务执行、文件系统操作、Telegram webhook 混在同一装配点
- 核心高风险边界缺少足够的行为级测试

这会带来三个直接问题：

1. 稳定性问题容易被隐式耦合放大
2. 后续继续加功能时，`server.js` 更容易退化成更深的 spaghetti
3. 如果未来要把核心 broker 或 task runner 换成 Rust sidecar，现在没有清晰替换边界

## Goals

- 为 Node 后端补齐最小稳定性护栏
- 把 `PTY/tmux broker` 从 `server.js` 中抽成可测试边界
- 建立后端类型检查基础，让未来迁移到更强类型约束更顺滑
- 用 characterization tests 固化高风险行为，降低重构回归
- 让 `server.js` 更接近薄装配层，而不是继续承担深业务逻辑

## Non-goals

- 本轮不重写整个后端为 Rust
- 本轮不重写整个服务端入口为 TypeScript 运行时
- 本轮不替换 Express、WebSocket 库、`node-pty` 或 tmux
- 本轮不改变现有前端 REST、WebSocket、SSE 协议形状
- 本轮不改前端主结构，除非后端收口需要最小配合
- 本轮不引入数据库，继续兼容 `data/*.json`

## Current Constraints

- 启动链当前依赖 [`start.sh`](/home/demo/workspace/typescript/nexus4cc/start.sh) 直接执行 `node server.js`
- 部署约束要求重启 `nexus` 服务，并在不可达时立即回滚
- 现有自动化测试以 Node 原生 `node:test` 为主
- 仓库已存在一些纯逻辑模块与单测，可作为拆分样板

## Chosen Shape

### 1. 先补护栏，再拆边界

第一阶段只做高 ROI 低争议项：

- `uncaughtException`
- `unhandledRejection`
- `server.on('error')`
- 更清晰的 process/signal wiring

目标是先把“服务挂掉但没人兜底”的问题堵上，再动结构。

### 2. `server.js` 改为薄装配层

后端目标分层：

```text
server.js
  ├── transport
  │     ├── express routes
  │     ├── ws wiring
  │     └── sse wiring
  ├── broker
  │     └── pty/tmux lifecycle
  ├── services
  │     ├── tasks
  │     ├── workspace
  │     ├── configs
  │     └── telegram bridge
  └── infra
        ├── env
        ├── child_process
        ├── fs
        └── shutdown/runtime guards
```

要求：

- route handler 只做鉴权、参数解析、调用 service、返回响应
- WebSocket 层只做协议解析和 broker 调用
- tmux / pty / process / fs 细节不再散落在 handler 里

### 3. 首先抽离 `PTY/tmux broker`

这是本轮最优先的结构边界，因为它同时满足：

- 运行时风险高
- 状态复杂
- 对未来 Rust sidecar 最有价值
- 当前逻辑在 `server.js` 中内聚度高，适合先收口

`PTY/tmux broker` 负责：

- session existence 检查
- window index 列举
- passive attach fallback
- PTY create / reuse / destroy
- client register / deregister
- resize 与 client size 跟踪
- recent output cache
- idle cleanup
- PTY exit 后的重建

建议内部接口：

```text
createPtyTmuxBroker(...)
  - ptyMap
  - ptyKey(session, windowIndex)
  - ensureWindowPty(session, windowIndex)
  - registerClient(key, client)
  - handleClientMessage(key, client, rawMessage)
  - handleClientClose(key, client)
  - getEntry(key)
```

说明：

- 本轮只先做 Node 本地实现
- 未来如果切 Rust，应优先替换这一层，而不是先改路由层

### 4. 后端类型约束先落“基础设施”，不强行重写入口

当前启动链直接跑 `server.js`，如果立刻把整个入口切成 TS 运行时，会把结构重构和构建/启动改造绑定成一个大风险 diff。

本轮选择：

- 先增加后端 TS / typecheck 基础设施
- 先让新抽出的高价值模块进入更强约束
- 保留现有 JS 入口与启动路径

优先级：

1. 先让新增边界变清楚
2. 再让类型约束跟上
3. 最后才考虑是否把入口也切到 TS 编译产物

如果实际运行时改造过于牵一发而动全身，本轮最低保底方案是：

- 建立 `tsconfig.server.json`
- 增加后端 `typecheck` 脚本
- 新模块使用清晰类型约束或 JSDoc 边界

### 5. 其他服务按替换价值排序继续抽离

`PTY/tmux broker` 之后的推荐顺序：

1. `task runner`
2. `workspace/files`
3. `configs/profiles`
4. `telegram bridge`
5. `session/project/codex-session`
6. `window launch + upload/files`

排序依据：

- 未来是否值得独立替换
- 当前是否直接加剧 `server.js` 耦合
- 是否容易通过公共接口补 characterization tests

## Implementation Plan

### Phase 0: 基线与 RED 测试

目标：先锁住行为，再动刀。

执行项：

- 跑当前 Node 测试基线
- 为以下行为补失败测试：
  - 进程级异常处理 wiring
  - server error wiring
  - `PTY/tmux broker` fallback
  - recent output cache
  - resize 不误写入终端
  - client close 后的 idle cleanup
  - PTY exit 后重建

完成标准：

- 新增测试先失败，失败原因直接对应目标行为
- 现有测试继续全绿

### Phase 1: 稳定性护栏

目标：补最小但刚性的运行时保护。

执行项：

- 把 signal wiring 收口到独立 runtime / lifecycle 模块
- 新增：
  - `uncaughtException`
  - `unhandledRejection`
  - `server.on('error')`
- 保持现有 `createGracefulShutdown` 行为兼容

完成标准：

- 新 wiring 测试通过
- 关闭路径不回归
- 启动失败时能显式退出

### Phase 2: `PTY/tmux broker` 抽离

目标：让 WS 层不再直接操纵 PTY 内部细节。

执行项：

- 抽出 broker 模块
- 把以下逻辑从 `server.js` 移走：
  - `ptyKey`
  - session/window existence 与 listing
  - `ensureWindowPty`
  - onData fan-out
  - resize / client size tracking
  - idle cleanup
  - exit 后重建
- `server.js` 保留：
  - JWT 校验
  - query 参数解析
  - `ws.on('message'/'close'/'error')` 与 broker 对接

完成标准：

- WebSocket 行为对前端无感
- 新 broker 测试覆盖核心路径
- `server.js` 的 PTY 逻辑体积明显收缩

### Phase 3: 后端类型检查基础

目标：不给未来类型化迁移埋坑。

执行项：

- 增加后端 `tsconfig` / `typecheck` 脚本
- 优先让新增 broker / runtime 模块接受更强类型约束
- 根据实际风险决定：
  - 仅做 typecheck 基础
  - 或让新增模块进入 TS 编译产物

完成标准：

- 有明确的后端类型检查入口
- 新抽出的高价值边界不再完全裸奔
- 不破坏 `npm start` 与 `start.sh`

### Phase 4: 后续拆分 backlog

目标：把改造从“一次性大手术”变成连续小 PR。

执行项：

- `task runner` 抽离
- `workspace/files` 抽离
- `configs/profiles` 抽离
- `telegram bridge` 抽离
- `session/project/codex-session` 抽离
- `window launch + upload/files` 抽离

完成标准：

- route handlers 继续变薄
- 每个子域有更清晰的 ownership 和测试面

## Test Plan

### 必补的 characterization tests

- `runtime guards`
  - signal handler 触发 shutdown
  - shutdown reject 时退出码为 1
  - `uncaughtException` 触发退出
  - `unhandledRejection` 触发退出
  - `server.on('error')` 触发退出

- `PTY/tmux broker`
  - session 不存在 -> `session_missing`
  - window 不存在 -> fallback 到现有第一个窗口
  - attach 复用已有 PTY
  - recent output 在新 client 连接时回放
  - resize JSON 不写入终端输入流
  - 非 resize 消息仍会写入 PTY
  - client close 后重算剩余尺寸
  - idle cleanup 触发 PTY kill
  - PTY exit 后，若窗口仍存在则尝试重建

### 回归验收

- 登录
- WebSocket 终端连接
- 窗口切换
- scrollback
- 任务创建与完成
- 服务优雅关闭

## Rollout / PR Breakdown

建议按小 PR 推进，而不是一次性大重构：

1. `runtime guards + tests`
2. `PTY/tmux broker extraction + tests`
3. `backend typecheck foundation`
4. `task runner extraction`
5. `workspace/config/telegram follow-ups`
6. `session/project/codex-session follow-ups`
7. `window launch + upload/files follow-ups`
8. `version/update-check extraction`
9. `broker sidecar PoC`
10. `task runner sidecar`
11. `TS runtime entry decision`

要求：

- 每个 PR 都能独立上线与回滚
- 不在同一 PR 同时做结构性大迁移和行为改写
- 每个 PR 合并前都跑相关测试

## Risks

- **风险：** 入口与构建链一起改，导致部署脚本断裂  
  **应对：** 本轮优先保留现有 JS 入口与 `start.sh`

- **风险：** broker 抽离时改变了前端依赖的 WS 时序  
  **应对：** 先补 behavior tests，再做最小替换

- **风险：** broker / task runner 两条 sidecar 合同都已落地后，如果不继续收紧 Node 入口运行时，类型约束仍然只覆盖模块级，启动链依旧是 JS 单点  
  **应对：** 下一轮优先评估 `TS runtime entry`，而不是回到零散 route 抽离

## TODO Checklist

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
- [ ] 视运行时收益决定是否把 Node 入口也切到 TS 编译产物
