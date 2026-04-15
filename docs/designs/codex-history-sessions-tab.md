# Codex History Sessions Tab

Status: Reviewed / Ready for implementation
Date: 2026-04-14
Branch: master

Reviewed by:
- /plan-eng-review (2026-04-14)
- /plan-design-review (2026-04-14)

## Problem

当前 Nexus 能管理运行中的 tmux project/channel，也会把共享 `.codex` 历史带进每个窗口运行时，但用户还不能在“当前工作区”里直接看到相关的 Codex 历史会话，更不能从 UI 一键继续旧会话。

目标是新增一个“Codex 历史会话”入口：

- 按当前 project 的工作区上下文筛出相关历史会话
- 展示最近 N 条会话
- 允许从 UI 继续某条历史会话
- 在 journal 缺失、坏文件、部分结果等降级场景下，仍然可解释、可观测

## Non-goals

- 不替换现有 tmux project/channel 模型
- 不把历史会话混入当前 tmux channel 列表
- 不把完整 session metadata 审计信息全部暴露给前端
- 本版不做 kill switch
- 本版不做独立 detail 视图

## Chosen Shape

### Product / UX

- 桌面端和移动端都提供一等入口
- 桌面端入口放在 sidebar 顶部 / 当前 project header 同级，作为一级切换
- 移动端入口放在当前工作区下方的 tab 区域
- 桌面端历史面板在 sidebar 区域内做同层切换，不额外叠 modal/drawer
- 历史会话面板是独立 `CodexSessionsPanel`
- 面板按需刷新，不做持续轮询
- 恢复成功后自动切换到新开的 channel
- 双击或重复点击恢复时，前端禁用按钮，后端做短时间去重

### Design Language Alignment

- 历史面板底层视觉语汇复用现有 Nexus 面板体系：
  - `nexus-*` CSS vars
  - 现有面板边框 / 圆角 / 背景层级
  - 现有按钮主次级关系
  - 现有 warning / error 颜色语义
- 新能力的辨识度通过以下方式建立，而不是另起一套子系统：
  - 更清楚的作用域标题
  - memory rows 结构
  - warning 与范围说明的组合层级

### Responsive & Accessibility

- 桌面端：
  - 历史面板在 sidebar 区域内同层切换
  - 终端主区不被历史列表覆盖
- 移动端：
  - 历史入口位于当前工作区下方的 tab 区域
  - 打开后使用适合小屏的列表面板，不要求复制桌面 sidebar 布局
  - 面板头部提供显式 `返回当前会话` 动作
  - 系统返回仅作为辅助路径，不作为唯一返回方式
- touch target：
  - 历史列表项和 `继续` 按钮最小触控高度 44px
- keyboard：
  - history rows 可获得焦点
  - `Enter` 触发继续
  - `Esc` 返回当前会话视图
- screen reader：
  - warning / error 区域要有可读的文本，不只靠颜色
  - 列表项需要可读的标题、时间、归属和动作名称

### Information Architecture

历史面板打开后的信息层级固定为：

1. 作用域标题
   - `Codex 历史会话 · <当前 project 名>`
2. 范围说明
   - 当前 repo root 或 cwd 匹配范围
   - 若为 partial-result 或 attribution unavailable，warning 在这一层出现
3. 主动作
   - 刷新
   - 查看更多
4. 主列表
   - 最近 N 条历史会话
   - 每条最小字段 + 继续动作

```text
Codex 历史会话 · <Project Name>
<scope summary>                           <warning if partial/unknown>

[刷新] [查看更多]

--------------------------------------
row 1  title / updatedAt / attribution
row 2  title / updatedAt / attribution
row 3  title / updatedAt / attribution
```

主列表视觉语义应定义为 **memory rows**，不是普通后台表格：

- 每条历史是紧凑的“工作记忆条目”
- 视觉优先级：
  1. 标题 / 会话名最强
  2. 更新时间与 attribution 次级
  3. 继续动作嵌入条目右侧或尾部
- 不使用重卡片、厚阴影、大面积装饰
- 不把它做成数据表或审计台

“查看更多”必须保持同一语气：

- 作为列表底部的轻量延伸动作存在
- 继续在同一面板内展开或追加
- 不切换到独立页面
- 不使用传统重分页控件
- 追加后的条目仍保持同一套 memory rows 视觉语言

### Interaction States

| Feature | Loading | Empty | Error | Success | Partial |
|---|---|---|---|---|---|
| 历史会话列表 | 顶部 skeleton + 列表占位行；保留面板骨架，避免整屏跳变 | 温和空状态：`当前 project 还没有 Codex 历史会话`；副文案解释按当前 repo/cwd 匹配；主按钮 `开始新的 Codex 会话`；次按钮 `刷新` | 阻塞错误态，仅在列表完全不可用时出现；给 `重试` | 正常列表 | 顶部 warning，列表仍可用 |
| attribution 状态 | `--` 占位 | N/A | N/A | 正常 attribution 标签 | `unknown` 标签 + warning |
| resume 按钮 | loading / disabled | N/A | toast | 成功后自动切换 | duplicate 时显示已有恢复结果 |

warning 采用顶部非阻塞 banner：

- 颜色语义：琥珀色 / warning，而不是错误红
- 位置：标题与范围说明下方，列表上方
- 文案风格：一句话说清“结果不是完整或不是 fully attributed”
- 次动作：
  - `刷新`
  - `了解原因`（可选 tooltip / inline help，不要求首发 detail view）
- 列表继续可见，继续动作不被阻塞
- warning 区域只使用次级动作，不使用主按钮等级

列表完全失败时：

- 保留头部与作用域说明，避免用户失去上下文
- 仅列表区域替换为阻塞错误态
- 错误态内容：
  - 标题：`当前无法加载 Codex 历史会话`
  - 副文案：一句话解释“这次读取失败，不代表没有历史”
  - 主按钮：`重试`
  - 次按钮：`返回当前会话`
- error 区域使用主按钮 + 次按钮的明确等级差异

恢复动作在交互上必须提前给轻量预期提示：

- 按钮或辅助文案需明确表达：
  - `继续后会打开并切换到新会话`
- 不弹确认框
- 目标是减少“突然跳走”的惊吓感，而不是增加摩擦
- 点击后按钮进入 loading，短暂显示 `正在打开…`
- 成功后直接切换，不额外弹成功 toast

### User Journey

```text
STEP | USER DOES             | USER FEELS       | PLAN RESPONSE
-----|-----------------------|------------------|------------------------------
1    | 打开历史入口          | 想确认这是哪儿   | 头部明确 project 作用域
2    | 浏览历史列表          | 想快速找到旧会话 | 最近 N 条 + 清晰最小字段
3    | 看到 warning          | 想知道还能不能用 | 非阻塞 warning，列表仍可用
4    | 点击继续              | 预期马上接着聊   | 按钮提前说明会打开并切换
5    | 恢复成功              | 想无缝进入新会话 | 自动切换到新 channel
6    | 恢复失败              | 想知道发生了什么 | toast 或失败现场可见，不静默
```

首次使用者与熟练用户的路径差异：

- 首次使用者：
  - 在面板头部或空状态附近看到轻量辅助说明：
    - 历史会话按当前 repo root / cwd 匹配
  - 在 warning 场景下，该说明更明显
- 熟练用户：
  - 常态下该说明弱化显示，不抢主列表层级
  - 不增加确认框或教学弹窗

### Backend

- 新增独立 `codexSessions` 模块
- `server.js` 仅保留薄路由和副作用编排
- 新 API 仅接受 `project`
- 服务端统一通过共享 helper 解析 project context

建议 API：

```text
GET  /api/codex-sessions?project=<name>
POST /api/codex-sessions/:id/resume
```

### History Source

- 历史列表只读取共享 `~/.codex` 历史源
- 不读取 per-window runtime `.codex`
- 工作区匹配规则：
  - 优先 repo root
  - 缺 git 信息时回退到精确 cwd / 子路径匹配

### Attribution

- Node 内长期独立实现 attribution 规则
- 标题规则尽量镜像 `cc-attribution`
- parity tests 必须持续约束 Node 输出不要漂离固定契约

## Data Flow

```text
Terminal.tsx / mobile entry
  |
  +--> CodexSessionsPanel
          |
          +--> GET /api/codex-sessions?project=<name>
                  |
                  +--> resolveProjectContext(projectName)
                  +--> scan shared ~/.codex sessions
                  +--> parse title / cwd / git / timestamps
                  +--> attribute sessions
                  +--> match to workspace
                  +--> recent N + warning flags

continue session
  |
  +--> POST /api/codex-sessions/:id/resume
          |
          +--> preflight(revalidate project membership)
          +--> short-window dedupe(project + sessionId)
          +--> tmux new-window
          +--> nexus-run-codex.sh
          +--> codex resume <session-id>
```

## Error Handling

- journal 缺失或损坏：
  - 列表继续可用
  - attribution 标为 `unknown`
  - 顶部 warning
- 单个 session 文件损坏：
  - quarantine 该文件
  - 返回 partial results
  - 顶部 warning + 结构化日志
- resume preflight 失败：
  - 不创建 tmux window
  - 直接给 UI 错误
- runtime resume 失败：
  - 失败现场可见
  - 有日志和计数

## Performance

- 历史结果短 TTL 缓存
- `resolveProjectContext(projectName)` 同级短 TTL 缓存
- 默认只返回最近 N 条
- “查看更多”通过后端分页/游标支持

## Security

- API 只接受 `project`
- 列表只返回最小字段：
  - `id`
  - `title`
  - `startedAt`
  - `updatedAt`
  - `attribution`
  - `matchReason`
  - `warning flags`
- resume 接口可接受 raw `sessionId`，但服务端必须重新校验归属

## Testing

测试金字塔至少包含：

1. 纯函数单元测试
   - 扫描
   - 标题
   - 归属
   - 工作区匹配
   - quarantine
2. fixture parity tests
   - 固定输入
   - 固定预期
   - 不允许用 Node 当前输出反推快照
3. API / 集成测试
   - preflight 失败不创建窗口
   - 成功恢复后自动切换
   - 重复点击只开一个窗口
4. 浏览器 smoke
   - 桌面入口
   - 移动入口
   - warning 展示

降级路径必须单独测试：

- partial-result
- attribution-unknown
- quarantine

## Deployment

- 本版无 kill switch
- 任何代码变更上线前：
  - 构建前端
  - 重启 `nexus`
  - 验证服务可达
- 若历史会话能力上线后导致服务不可用或行为误导：
  - 按现有 runbook 做整包回滚

## Risks

### Accepted Risks

- 长期双实现：Rust + Node attribution 规则并存
- 本版无 kill switch
- runtime resume 失败时，用户可能自动切换到失败现场

### Mitigations

- parity tests
- 结构化日志 + 基础指标
- UI warning 明示降级状态
- 前后端去重与 preflight

## NOT in scope

- detail 视图 / detail API
- kill switch
- 持久化 projection 文件
- 前端假分页
- 完整 metadata 暴露
