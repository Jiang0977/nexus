# Multi-Workspace Split View

Status: Implemented
Date: 2026-05-04
Branch: codex/multi-workspace-split-view

Current note (2026-05-20): this design was implemented against the default tmux backend. The UI contract remains `session + windowIndex`; native backend is now opt-in/staging and should preserve that public contract.

Task context:
- `.context/tasks/multi-workspace-split-view-plan/`
- UI design: `../../.context/tasks/multi-workspace-split-view-plan/ui-design-split-view-sidebar-actual.png`

## Goal

PC 端支持多工作区、多 channel 同屏查看和操作。用户可以把左侧现有工作区树里的 `窗口` channel 拖到右侧 pane 中，右侧按 single / vertical / horizontal / 2x2 / 3x3 布局显示多个实时终端。

这次实现按 B+ 交付：先做 split-view 工作台，但用 C 的边界设计数据模型和持久化，避免后续 Agent Control Plane 返工。

## Locked Decisions

| Decision | Choice | Meaning |
|---|---|---|
| Layout persistence | 1B | 第一版就用后端 API + `data/workspace-layouts.json` 保存 active layout。 |
| Layout modes | 2A | 第一版支持 `single` / `vertical` / `horizontal` / `grid-2x2` / `grid-3x3`。 |
| Pane assignment | 3B | 从左侧现有 channel 行拖拽到右侧 pane。 |
| Mobile | 4A | 移动端保持当前单 pane 流程，不做 split view。 |

## Non-Goals

- 不重做左侧侧边栏。`工作区` header、项目树、`窗口 / 历史会话` tabs、`+ 新建工作区`、快捷键区和底部工具栏都保持现状。
- 第一版不替换 tmux；session/window 由当时的默认 tmux backend 负责。当前 native backend 已有 opt-in/staging 路径，但不能破坏本设计依赖的 `session + windowIndex` UI contract。
- 不做多用户、权限体系或团队共享。
- 不做完整 C 版 Agent Control Plane：多命名布局、全局 command center、CPU/MEM 仪表盘、完整快捷键系统都不在第一版。
- 不做移动端多 pane。

## Existing Leverage

当前 Rust PTY runtime 已经用 `session:windowIndex` 作为 key，并支持同一个 PTY entry 多个 client：

```text
Browser WebSocket
  -> /ws?session=<session>&window=<index>
  -> nexus-server
  -> nexus-pty-runtime
  -> tmux session:window
```

所以第一版不要重写后端 PTY。主要变化是前端把“全局唯一 terminal runtime”拆成“每个 pane 一个 runtime”，并补一个后端 layout 持久化 API。

## UX Shape

左侧保持当前真实结构：

```text
工作区
  -> nexus                         1
     .../rust/nexus
  -> home-jiang-workspace-skill... 1
     .../skill/skills
  v  home-jiang-workspace-java...  3
     .../java/taobaoWeb
       窗口 | 历史会话
       # cc-switch-deepseek-1
       # cc-switch-deepseek
       # channel
  -> home-jiang-workspace-financial 1
     .../workspace/financial

+ 新建工作区
快捷键...
底部工具栏...
```

右侧新增 split workspace：

```text
Layout toolbar
  [Single] [V Split] [H Split] [2x2] [3x3] [布局已保存]

SplitWorkspaceView
  Pane 1: live terminal
  Pane 2: live terminal
  Pane 3: stale/error
  Pane 4: empty drop target

Status strip
  已连接 2/4 panes | WS 2 | PTY ready | 布局已保存 | Up ...
```

拖拽规则：
- drag source：展开项目 `窗口` tab 下的 channel row。
- drop target：右侧 pane body 或 empty pane。
- drop 后：pane target 替换为 `{ session, windowIndex }`，立即连接对应 WebSocket。
- 同一个 channel 被拖到多个 pane 时第一版允许重复显示；后端已支持多 client，UI 不做隐式去重。

## Data Model

前端和后端共用同一份稳定 schema。第一版只保存 active layout，后续可以扩展为多命名 layout。

```ts
type LayoutMode =
  | 'single'
  | 'vertical'
  | 'horizontal'
  | 'grid-2x2'
  | 'grid-3x3'

type PaneTarget = {
  session: string
  windowIndex: number
}

type PaneState = {
  id: string
  target: PaneTarget | null
}

type WorkspaceLayout = {
  version: 1
  mode: LayoutMode
  focusedPaneId: string
  panes: PaneState[]
  updatedAt: string
}
```

Persisted file:

```text
data/workspace-layouts.json
```

Initial JSON shape:

```json
{
  "version": 1,
  "activeLayout": {
    "version": 1,
    "mode": "grid-2x2",
    "focusedPaneId": "pane-1",
    "panes": [
      { "id": "pane-1", "target": { "session": "nexus", "windowIndex": 0 } },
      { "id": "pane-2", "target": null }
    ],
    "updatedAt": "2026-05-04T00:00:00Z"
  }
}
```

Validation rules:
- `mode` 必须是白名单。
- pane 数量最多 9。
- pane id 必须非空且唯一。
- `target.session` 必须非空。
- `target.windowIndex` 必须是非负整数。
- 读到坏 JSON 或不合法 layout 时 fail-open：返回默认 single layout，不阻塞终端。

## Backend API

New endpoints:

```text
GET /api/workspace-layouts/active
PUT /api/workspace-layouts/active
```

Both require the existing JWT auth.

`GET` behavior:
- layout 文件存在且合法：返回 active layout。
- 文件不存在：返回默认 layout。
- 文件损坏或非法：记录 warning，返回默认 layout。

`PUT` behavior:
- 校验 payload。
- 原子写入：先写临时文件，再 rename。
- 写入失败：返回 non-2xx，前端显示非阻塞 unsaved 状态。

Suggested Rust placement:

```text
rust-runtime/src/server/layouts.rs
rust-runtime/src/server/mod.rs
rust-runtime/src/server/runtime.rs
```

`AppState` 增加 `workspace_layouts_file: Arc<PathBuf>`，路径落在现有 `data/` 体系内。

## Frontend Components

New files:

```text
frontend/src/terminal/splitLayoutTypes.ts
frontend/src/terminal/splitLayoutApi.ts
frontend/src/terminal/useWorkspaceLayout.ts
frontend/src/terminal/useTerminalPaneRuntime.ts
frontend/src/terminal/TerminalPane.tsx
frontend/src/terminal/PaneHeader.tsx
frontend/src/terminal/SplitWorkspaceView.tsx
frontend/src/terminal/PaneDropTarget.tsx
```

Existing files to touch:

```text
frontend/src/Terminal.tsx
frontend/src/terminal/useTerminalRuntime.ts
frontend/src/terminal/useTerminalSessions.ts
frontend/src/terminal/DesktopSidebar.tsx
frontend/src/locales/zh-CN/translation.json
frontend/src/locales/en/translation.json
```

Implementation direction:
- `useTerminalPaneRuntime` owns one `XTerm`, one `WebSocket`, one resize observer, one reconnect loop.
- `TerminalPane` renders per-pane terminal, connecting/error/stale/empty states.
- `SplitWorkspaceView` maps layout mode to CSS grid/flex tracks.
- `DesktopSidebar` only adds drag metadata to existing channel rows; it must not change the sidebar information architecture.
- Existing mobile runtime path remains single-pane.

## Error And Degraded States

| Failure | Behavior |
|---|---|
| Layout GET fails | Show default single layout; right-side indicator says layout not loaded. |
| Layout PUT fails | Keep in-memory layout; show unsaved indicator; do not disconnect panes. |
| Layout file corrupted | Server logs warning; returns default layout. |
| Target session missing | Affected pane becomes `stale`; user sees `窗口不存在` with `替换` / `移除`. |
| Target window missing | Same as target session missing. |
| One WebSocket fails | Only that pane reconnects/errors; other panes continue. |
| 3x3 too small | Panes stay fixed-size grid; terminal font/controls must not overlap. |
| Drag invalid payload | Drop ignored; pane unchanged; optional warning in pane. |

## Testing Plan

Backend:
- Unit/integration test valid layout read/write.
- Invalid `mode`, too many panes, negative `windowIndex`, empty `session`.
- Missing layout file returns default layout.
- Corrupt layout file returns default layout and does not panic.
- Atomic write path does not leave partial JSON on failure where testable.

Frontend:
- Single-pane behavior still works.
- Switch layout modes: single, vertical, horizontal, 2x2, 3x3.
- Drag existing sidebar channel into empty pane.
- Drag channel over occupied pane replaces target.
- 2 panes connect to different `session/windowIndex`.
- 3x3 renders 9 pane shells without text/control overlap.
- Stale target renders per-pane error and does not clear whole workspace.
- Layout save failure keeps current in-memory layout and marks unsaved.

Browser smoke:
- Open desktop width.
- Expand existing project in sidebar.
- Drag `# channel` into pane.
- Confirm pane connects to expected tmux window.
- Refresh page.
- Confirm backend-saved layout restores.

Required commands:

```bash
npm --prefix frontend run build
npm run check
cargo test --manifest-path rust-runtime/Cargo.toml
```

## Rollout And Rollback

Deploy sequence:

```text
1. Build frontend.
2. Build Rust binaries.
3. Restart nexus service.
4. Verify service is reachable.
5. Smoke split view on desktop.
```

Rollback:
- If service is unreachable after restart, rollback deployed code immediately.
- If only split layout is broken but terminal still works, remove or ignore `data/workspace-layouts.json` and fall back to default single layout.
- A future kill switch can be added if split view becomes risky, but first implementation should fail-open without requiring one.

## Future C Path

This design intentionally leaves room for:

- Multiple named layouts.
- Workspace overview batch API.
- Full pane registry with richer lifecycle.
- Command palette replacement for drag-only assignment.
- Keyboard focus model (`Ctrl+1..9`, maximize/restore).
- Runtime health dashboard.

None of those are required for first ship.
