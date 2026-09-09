# tmux 优化部署与现场验收（2026-09-10）

## 结果与边界

代码已部署到 `/home/demo/.local/lib/nexus`。首次部署时现场确认生产配置为 native，因此先保留原配置、完成独立端口验收。用户随后明确授权切换：现已将 `data/session-backend.json` 改为 tmux，并于 `2026-09-10 00:59:44 CST` 再次重启 `nexus.service`。鉴权后的主入口 `/api/config` 确认 `sessionBackend=tmux`、`configuredSessionBackend=tmux`；主入口 tmux 重绘已启用并完成验收。

已安装版本先在本机独立端口 `127.0.0.1:59001` 完成验收，切换后又在生产主入口 `127.0.0.1:59000` 完整复验通过。使用真实 Chrome、实际安装的前后端和系统 tmux，不使用 fake PTY/broker。移动端为 Chrome 移动视口与 CDP 触摸仿真，不是实体手机或 Tailscale 链路验收。未调用任何模型/provider。

## 部署证据

- 入口：`npm run deploy:service -- --frontend`，明确指定安装树与 `nexus` restart helper；构建、同步、重启和健康检查成功。
- 部署前定向回归：终端连接、输入、公开 buffer 指标及真实 tmux 测试共 15 项通过。
- `nexus.service` 在 `2026-09-10 00:42:39 CST` 重启，PID 从 `3436305` 变为 `1403137`。
- 后端切换后再次重启，当前 PID 为 `1537384`；运行中二进制 SHA-256 与下述部署产物一致。
- `nexus-tmux.service` PID 保持 `4642`；`nexus-native-pty.service` PID 保持 `3436274`，未重启已有 native supervisor。
- 七个 release binaries 与 checkout 逐文件 `cmp` 一致；安装树 `frontend/dist` 与 checkout 无差异。
- `/proc/1403137/exe` 指向安装树 `nexus-server`；运行中 server 与构建产物 SHA-256 均为 `057448905ab74279bc0d440b1282d52d38b8a97f06eef3bb61d94125cba47926`。
- 主入口首页 HTTP 200，`/api/version` 未鉴权 HTTP 401；返回的 index、JS/CSS 资源与 checkout 哈希一致。

## tmux 现场专项

以下先在独立端口通过，随后在生产主入口完整复验通过：

1. 桌面双窗完整 TUI 重绘，两窗屏幕内容一致；二进制 v1 `terminal-state` 先于文本输出。
2. 页面刷新后屏幕恢复、应用 PID 不变。
3. 强制 detach 一个 tmux client 后自动重连，另一窗仍连接；原应用未重启。
4. 重连后保存光标续写在两窗正确显示；调整桌面尺寸仍显示完整帧。
5. 移动视口刷新；退出 TUI 后真实触摸拖动使 tmux 历史行向前移动。
6. WebSocket 空闲 31 秒不发生重连。
7. 真实 bash 历史可由桌面滚轮滚动。
8. `npm run smoke:login-upload` 完成真实登录、上传，路径只发送一次。
9. 无浏览器 page error；测试使用浏览器内临时布局，不修改用户保存的分屏布局。

临时 tmux session、探测 native 配置时生成的两个临时 shell、独立端口服务均已结束；测试 scrollback 已移入证据目录，不删除用户会话。

## 回滚与剩余事项

- 部署前安装树 binaries/dist、工作树 patch、未跟踪文件与现场日志保存在 `/tmp/nexus-tmux-deploy-20260910.lkyigh/`；`installed-before.tar.gz` 为旧安装版本备份。该路径为临时目录，应在需要长期保存时另行归档。
- 同目录 `live-results.json`、`live-smoke.log`、`login-upload.log`、`desktop-tui.png` 和 `mobile-tui.png` 为现场证据；`live-smoke.mjs` 是仅操作临时终端的验收脚本。
- `production/` 子目录保存主入口验收结果（12 项检查全部通过）、截图、重启日志，以及切换前的 `session-backend.before.json`。如需恢复 native，可恢复该配置后仅重启 nexus；无需重启 native supervisor。
- 生产切换已获单独授权。网页当前展示 tmux 项目/会话；既有 native 会话没有迁移到 tmux，native supervisor 始终保持原 PID 运行。
- native 完整恢复、native supervisor 新二进制的运行态切换、真实 Codex/Claude/Pi 会话及实体手机网络验收不在本次通过结论内。
