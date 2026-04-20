# Codex History Browser Smoke

日期：2026-04-21

## Context

- 服务地址：`http://127.0.0.1:59000`
- 服务状态：system-level `nexus.service`
- 浏览器驱动：Chrome DevTools MCP
- 视口：
  - desktop 默认视口
  - mobile `390x844`，`deviceScaleFactor=3`
- 验证原则：优先用真实工作区态，不用伪造夹具

## Result

| Case | Setup | Evidence | Result |
|------|-------|----------|--------|
| desktop entry | 点击桌面端 `Codex History` 入口 | 不再触发 React 426；进入当前工作区的 Codex history 视图 | Pass |
| warning state | 真实项目 `home-demo-workspace-financial` | 面板出现 `Some history entries only matched by working directory, so attribution is incomplete.`，容器具备 `role=\"status\" aria-live=\"polite\"` | Pass |
| empty state | 真实空项目 `home-demo-workspace-tmp-nexus-empty-20260421-0014` | 面板出现 `This project has no Codex history yet` 和匹配规则说明 | Pass |
| error state | 浏览器侧 monkeypatch `/api/codex-sessions` 返回 `404` | 面板出现 `Codex history is unavailable right now`，容器具备 `role=\"alert\" aria-live=\"assertive\"` | Pass |
| resume smoke | `home-demo-workspace-financial` 历史列表第一条 `Continue` | UI 进入 loading；后端 `tmux list-windows -t home-demo-workspace-financial | wc -l` 从 `1` 变 `2` | Pass |
| mobile modal open | 点击移动端 `Codex History` 浮动入口 | 出现 `dialog \"Codex History · home-demo-workspace-financial\"`，初始焦点在 `Back to Session` | Pass |
| mobile modal close / focus return | 同一条路径按 `Esc` 关闭 modal | `document.activeElement === window.__codexHistoryTrigger`；快照里 `Codex History` 触发器为 focused | Pass |

## Notes

- 移动端 focus return 最初失败的根因不是浏览器驱动噪音，而是组件在 modal 挂载后才读取 `document.activeElement`。触摸路径下该值可能已经退回 `body`。
- 修复后改为在 `Terminal` 打开 modal 前显式记录触发元素，再由 `CodexSessionsPanel` 关闭时恢复焦点。
- 本文档只覆盖 Codex history feature closeout；`nexus.service` 的 `left-over process` 运维债另算。
