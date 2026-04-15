# TODOS

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
