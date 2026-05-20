# Codex History Sessions Tab

Status: Implemented / deployed / verified
Date: 2026-04-15
Branch: main

Reviewed by:
- `/plan-eng-review` (2026-04-14)
- `/plan-design-review` (2026-04-14)

## Outcome

这项能力已经落地，不再是 `Ready for implementation`。

当前已交付：

- 按当前工作区筛选共享 `~/.codex` 历史会话
- 桌面端入口已放到“当前工作区内容区”的二级层级，而不是和工作区列表同级
- 移动端保留当前工作区下的 modal 路径
- 历史列表支持刷新、分页/“查看更多”、恢复、删除
- 部分结果和 attribution 不完整时显示非阻塞 warning
- 恢复路径具备前后端去重
- 新增 `kill switch`
  - 环境变量：`NEXUS_CODEX_HISTORY_ENABLED=0`
- 新增最小 detail 能力
  - `GET /api/codex-sessions/:id/detail`
  - 前端面板内联展开最小白名单字段

## Delivered Scope

### Product / UX

- 桌面端：
  - Codex 历史属于当前工作区内部的二级切换
  - 不再作为和工作区列表同级的全局一级 tab
- 移动端：
  - 仍通过当前工作区下的独立列表面板打开
  - 头部保留显式 `返回当前会话`

### Backend

- `GET /api/codex-sessions?project=<name>&limit=<n>&cursor=<offset>`
- `POST /api/codex-sessions/:id/resume`
- `DELETE /api/codex-sessions/:id`
- `GET /api/codex-sessions/:id/detail`
- 服务端只接受 `project` 作为工作区上下文输入

### Data / Safety

- 历史源只读取共享 `~/.codex` 历史，不读取 per-window runtime `.codex`
- 匹配规则：
  - 优先 repo root
  - repo 项目缺 session git 信息时回退 cwd / 子路径匹配
  - 非 repo 项目只匹配精确 cwd，避免父目录吞掉子项目历史
- detail 字段走白名单提取，只暴露：
  - `source`
  - `originator`
  - `cliVersion`
  - `modelProvider`
  - `startedAt`

## Validation

已完成的验证：

- `cargo test --manifest-path rust-runtime/Cargo.toml --test setup_systemd`
- `cargo test --manifest-path rust-runtime/Cargo.toml --test startup_paths`
- `cargo build --manifest-path rust-runtime/Cargo.toml --release --bin nexus-server`
- 2026-05-20 note：当前完整部署构建还应包含 child runtimes、native PTY binaries 和 `nexus-codex-home`；本条是当时该功能的最小验证记录。
- `npm --prefix frontend run build`
- 正式部署后服务可达验证通过
- 浏览器级 smoke 已完成，见 [codex-history-browser-smoke-2026-04-21.md](../verification/codex-history-browser-smoke-2026-04-21.md)
  - 桌面入口可打开当前工作区内的 Codex history 视图
  - `warning / empty / error` 主状态有真实浏览器证据
  - `resume` 真实 smoke 已创建新 tmux window
  - 移动端 modal 初始焦点落到 `Back to Session`
  - `Esc` 关闭后焦点返回 `Codex History` 触发器

## Closeout Status

这项能力原本剩余的两类补偿项已在 2026-04-21 收口：

- 浏览器级回归留痕
- 可访问性收口

因此 Codex history 不再有 feature-level open TODO。剩余 `systemd left-over process` 属于运行时运维债，不属于本设计文档的功能欠账。

## Not in Scope

- 独立 detail 页面
- 完整 metadata 暴露
- 持久化 projection 文件
- 前端假分页

## Rollback / Deploy

- 代码变更上线前仍需：
  - 构建前端
  - 构建后端
  - 重启 `nexus`
  - 验证服务可达
- 若历史能力导致误行为，可用 `NEXUS_CODEX_HISTORY_ENABLED=0` 先 fail-close，再按 runbook 回滚
