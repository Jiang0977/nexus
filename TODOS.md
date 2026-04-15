# TODOS

## P1

### Execute Node Backend Optimization Plan

- What: 按 `docs/designs/node-backend-optimization.md` 推进 Node 后端优化，先补运行时护栏，再抽离 `PTY/tmux broker`，再建立后端类型检查基础。
- Why: 当前 `server.js` 集中了 PTY/tmux、WebSocket、任务、文件和 Telegram 等高风险边界，继续堆功能只会让维护成本和未来 Rust 迁移成本一起上涨。
- Pros: 降低线上脆弱性；给未来 Rust sidecar 留清晰替换位；把大单体拆成可测试子域。
- Cons: 这是一组连续小重构，不会立刻带来新用户功能；需要持续补行为测试。
- Context: 该项来自 2026-04-15 的 Node 优化实施计划。已完成 `runtime guards -> PTY/tmux broker -> backend typecheck -> task runner -> workspace -> configs/profiles -> telegram bridge -> session/project/codex-session -> window launch + upload/files -> version/update-check -> broker sidecar PoC -> task runner sidecar`。如果继续推进，下一步主线应收敛到 `TS runtime entry`。
- Depends on / blocked by: 依赖现有 API / WS 协议保持兼容；不要求先改前端主结构。

### Scope TS Runtime Entry

- What: 为 Node 后端入口补 `TS runtime entry` 路线，明确编译产物、启动脚本、systemd 部署方式、回滚边界和最小迁移顺序。
- Why: 现在 broker / task runner 两条 sidecar 合同都已落地，剩下最大的结构债是 `server.js` 入口仍游离在 typecheck 之外。
- Pros: 让类型约束从“新模块”推进到“启动链”；减少 JS/TS 双轨；后续继续抽边界时约束更硬。
- Cons: 会触碰构建与部署链；如果 rollout 设计 brain-dead，很容易把结构优化变成启动事故。
- Context: 该项是 2026-04-15 `task runner sidecar` 完成后的下一条主线候选。
- Depends on / blocked by: 依赖保持现有 `npm start` / `start.sh` / systemd 行为可回滚，不能在一轮里强绑大迁移和部署改造。

### Add Runtime Guard Coverage

- What: 为 `uncaughtException`、`unhandledRejection`、`server.on('error')`、signal/shutdown wiring 增加独立测试和最小实现收口。
- Why: 这是最小但最高 ROI 的稳定性补丁，能直接减少“服务挂掉没人兜底”的场景。
- Pros: 改动小、收益直接、验证边界清晰。
- Cons: 只解决第一层防线，不能代替后续结构拆分。
- Context: 当前优雅关闭只覆盖 signal + shutdown 路径，缺少更硬的进程级失败兜底。
- Depends on / blocked by: 可独立推进，不阻塞后续 broker 抽离。

### Extract PTY/Tmux Broker

- What: 把 `server.js` 尾部的 PTY/tmux 生命周期、fallback、resize、recent output、idle cleanup、exit 后重建逻辑抽到独立 broker 模块。
- Why: 这是后端最值得先拆的边界，也是未来最适合被 Rust sidecar 接管的部分。
- Pros: 直接降低 `server.js` 耦合；方便做 characterization tests；为 future sidecar 立合同。
- Cons: WebSocket 终端主路径风险高，测试不够时容易回归。
- Context: 该项是 Node 后端优化计划的核心阶段，要求前端对接协议保持不变。
- Depends on / blocked by: 最好先补 broker 行为测试，再做抽离。

### Add Backend Typecheck Foundation

- What: 为后端增加最小类型检查基础设施，让新抽离模块进入更强约束，但不强行把整个入口改成 TS 运行时。
- Why: 直接重写入口为 TS 容易把启动链、部署链和结构重构绑成一个高风险 diff；先有类型检查再逐步切运行时更稳。
- Pros: 给未来类型化和 Rust 替换铺路；不要求一次性改造所有后端模块。
- Cons: 首轮可能只拿到“类型检查基础”，而不是完整 TS 运行时。
- Context: 这是 Node 优化计划里的折中决策，优先级低于 runtime guards 和 broker 抽离。
- Depends on / blocked by: 依赖确认构建与启动链不被打碎。

## P2

### Add Kill Switch For Codex History Sessions

- What: 为 Codex 历史会话面板和相关 `/api/codex-sessions*` 能力补一个最小 kill switch。
- Why: 当前方案明确不带开关上线，一旦历史匹配或恢复逻辑出问题，只能整包回滚。
- Pros: 发布和回滚颗粒度更细，线上出问题时能只关新能力，不影响现有 tmux/terminal 主流程。
- Cons: 需要多一层配置读取、前后端显隐处理和测试覆盖。
- Context: 该项来自 2026-04-14 的 `/plan-eng-review`。当前已接受 `20B`，即本次实现不做 kill switch；因此必须把这个后续补偿项显式记录下来，避免只存在于聊天记录里。
- Depends on / blocked by: 依赖当前 Codex 历史会话功能先按已评审方案落地。

### Add History Detail View Or Detail API

- What: 为 Codex 历史会话补一个 detail 视图或 detail API，用于按需查看 repo/source/model/sandbox 等额外 metadata。
- Why: 当前首发范围只返回最小字段，保持列表轻量；但后续一旦需要解释某条历史为什么被匹配或为什么行为异常，需要一个明确的排障入口。
- Pros: 列表保持简洁，后续排障和解释能力更强。
- Cons: 需要新增接口或界面，并补敏感字段暴露边界和测试。
- Context: 该项来自 2026-04-14 的 `/plan-eng-review`。当前 design doc 已明确 detail 能力不在首发范围内，但它是一个合理的后续增强项，值得显式记录。
- Depends on / blocked by: 依赖当前最小字段历史列表先稳定上线。

### Add Lightweight DESIGN.md

- What: 补一个轻量 `DESIGN.md`，定义 Nexus 的面板语汇、状态语义、按钮等级和跨端入口原则。
- Why: 当前多次 plan review 都因为没有设计系统文档而停在 8/10 左右，后续 feature 还会重复讨论相同的设计对齐问题。
- Pros: 降低后续 UI feature 的设计分歧和 review 成本，设计一致性更稳。
- Cons: 需要额外抽象和整理现有 UI 语言，不是当前历史会话功能上线的阻塞项。
- Context: 该项来自 2026-04-14 的 `/plan-design-review`。本次历史会话 design plan 已尽量写清楚，但仍然只能依赖“复用现有语汇”的临时规则，而不是正式设计系统。
- Depends on / blocked by: 不阻塞当前历史会话功能，可独立推进。
