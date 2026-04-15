# TODOS

最后更新：2026-04-15

## Closed

以下主线已完成并已验证/部署，不再算 open TODO：

- Node backend optimization 主线
- `TS runtime entry`
- Codex 历史 `kill switch`
- Codex 历史 `detail API` 与最小 detail 视图
- `DESIGN.md`

## P1

### Codex 历史浏览器级回归

- What: 用浏览器 smoke 覆盖桌面入口、移动入口、warning/empty/error/resume 主路径。
- Why: 当前主要证据是单测、build 和部署探活，缺少真实 UI 行为留痕。
- Done when:
  - 桌面端能进入当前工作区内的 Codex 历史视图
  - 移动端 modal 入口可打开和返回
  - warning / empty / error 三种状态有浏览器级验证记录
  - resume 主路径至少有一次真实 smoke

### Codex 历史可访问性收口

- What: 为 `CodexSessionsPanel` 补齐键盘和读屏合同。
- Why: 设计文档已定义 `Enter` / `Esc` / focus / readable text 规则，但实现和验证还没完全收口。
- Done when:
  - 关键交互具备显式 keyboard path
  - warning / error / row action 具备可读文本语义
  - 有最小自动化或浏览器验证证据

## P2

### 清理 `nexus` 启动 `left-over process` 运维债

- What: 收口 `systemd` 重启时的 left-over process 告警，不破坏 tmux 持久化语义。
- Why: 当前服务可用，但日志仍提示旧 cgroup 残留；这是运维债，不是当前功能阻塞。
- Done when:
  - 重启 `nexus` 后不再出现成串 left-over process 告警
  - tmux 持久化会话语义不回归
  - 相关 runbook 和 task 文档同步更新
