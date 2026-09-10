# tmux 终端刷新/重连恢复

历史状态：2026-09-10 早期 tmux 代码已部署；当时经用户单独授权切换为 tmux 并完成真实 tmux 验收，详见 [部署记录](../verification/tmux-deployment-2026-09-10.md)。下文保留该阶段的范围与证据。

后续 native 与显式 channel profile 的实现、恢复边界及验收入口以 [Native checkpoint 设计](native-terminal-checkpoint.md) 为准。本机部署已按用户后续选择改为 native；不能用这份历史 tmux 报告证明 native 验收通过。

## 已核实的问题与选择

旧 broker 按 `session:window` 共享一个 tmux client PTY，新连接注册后只重放最近 2000 字符，既可能缺少早先的模式设置，也存在注册与回放交错。旧前端重连还保留旧屏幕，不能保证恢复一致。

选择让每个浏览器连接拥有独立 tmux client PTY，仍通过 grouped session 链接原来的窗口。应用进程、保存光标、滚动区域等状态继续由 tmux 管理；新连接接收 tmux 自己的完整重绘，不使用 ANSI 尾片段或序列化插件冒充完整终端状态。

依据：[tmux 官方入门文档](https://github.com/tmux/tmux/wiki/Getting-Started)、[窗口共享实现](https://github.com/tmux/tmux/blob/master/server-fn.c)、[3.4 终端初始化实现](https://github.com/tmux/tmux/blob/3.4/tty.c)。本机隔离 socket、禁用用户配置的 tmux 3.4 探针已确认新 attach 输出包含指定屏幕内容、初始化模式和重绘；多客户端等价性已由下面的真实集成测试验证。

不修改全局 tmux 配置。每个 client 的 PTY 尺寸独立，底层共享 pane 的逻辑尺寸仍遵循 tmux 的窗口尺寸策略；不能承诺同一应用同时运行在两种逻辑尺寸下。当前默认 tmux server 的只读检查显示 mouse=on、window-size=latest。

## 可执行任务与边界

1. **broker 连接隔离**：tmux 使用无歧义的连接级内部 key，entry 另存窗口身份供状态查询；native 保持原 key。必须在启动 reader 前注册 client。tmux 不再做尾片段 replay，detach/error/close 只清理对应 PTY 和 grouped session，不终止原窗口及其他 client。
2. **查询和尺寸兼容**：窗口级 snapshot 聚合 client 数及最近活动，维持原参数。首次 attach 可带合法正整数行列；resize 不得截断溢出数字，也不得把无效 resize 控制 JSON 写入应用。尺寸仅作用于所属 PTY。
3. **重绘握手**：新浏览器请求 `terminalProtocol=2`；broker 返回 `replayPolicy=tmux-redraw` 后，server 在任何终端文本前发送版本 1 的二进制 JSON `terminal-state` 控制帧。文本输出始终按文本处理，不能把用户输出的 JSON 误判为控制消息。native/旧客户端保持旧行为。
4. **有序重置和丢包恢复**：浏览器收到有效控制帧时排队写入 RIS，保证先前已排队的旧输出在重置之前处理；失效 socket 的控制和回调必须被忽略。未知控制版本明确报错。广播 lag 关闭 1013 并清理连接，新连接重新获得真实重绘；禁止静默跳过字节。tmux client 自身退出也应触发针对该连接的重连，而非挂起或影响全局连接。
5. **输入路由**：真实 tmux 重绘恢复其协商的鼠标模式，优先由 xterm 编码标准鼠标输入，不凭标题、2026 或 alternate screen 推断应用身份。2026-09-10 后续迭代已移除 Grok legacy 分支，增加窗格级临时手动 SGR 选择和独立回归；私有 capability/launch profile 尚未实现。此后续改动已随 `b90bde3` 部署，见 [本机生产部署验收](../verification/production-readiness-2026-09-10.md)。

原生后端的完整状态引擎不在本轮；已有 UTF-8/二进制传输修正保留。三个既有 native 重挂接历史测试失败已在未改动 HEAD `134a586` 复现，不随本轮顺手修改。

## 验收

- 新增 `tests/tmuxTerminalRestore.test.js` 和 `tests/fixtures/tmux-tui-state.cjs`：隔离真实 tmux + 实际浏览器 xterm，比较新连接的全部屏幕行、颜色、光标及公开模式，检验断开后应用 PID 不变、保存光标续写、模式退出及聚合 client 数。
- 此测试已从缺少 `tmux-redraw` 的红灯转为通过：覆盖完整屏幕/模式、应用 PID 不变、保存光标续写、多尺寸 client、无效 resize、异常 client 退出、error 清理及 grouped session 回收。还验证 mouse=on 时真实浏览器滚轮进入 tmux copy mode 并滚到更早的普通历史行；不把 tmux 外层 alternate buffer 误当作源应用身份。
- `tests/nexusRustServerEntry.test.js` 验证二进制控制帧先于 attach 期间缓冲的输出、旧客户端兼容、几何校验、JSON 文本透传、单连接退出和 fatal 清理；在 attach 返回前注入超过 256 条输出，确定性验证 lag 关闭 1013 并清理连接。
- `tests/terminalConnection.test.js` 验证重新测量尺寸、重连 reset、失效 socket 隔离、未知/重复/过晚控制帧拒绝和旧服务器兼容。`tests/browserTerminalRegression.test.js` 保留移动触摸/桌面滚轮/Ctrl+wheel 基线，并补真实 Rust WebSocket + fixture 输出的桌面与移动端重连验收；fake runtime 用例不等同于真实 Codex/Claude/Pi 人工验收。
- 验证入口：定向 Node/Rust 测试、`npm run test:browser`、`npm run build:frontend`、Rust fmt/clippy。发布仍需单独授权。
- 开发阶段结果（2026-09-09）：Rust 107 项通过，frontend build/typecheck、fmt、clippy 通过；Node 203 项中 200 项通过（包含全部 40 项浏览器回归和真实 tmux 测试），仅余上述 3 项已确认的 native 基线失败。当时 `frontend/dist` 已重建但未提交，不能据此认定要求工作树干净的 `check:frontend-dist` 门禁通过。后续生产验收见部署记录；真实 Codex/Claude/Pi 会话验收仍未进行。

## 开发执行方式

worker 曾出现空白交付和 429，未接受其 tmux 主线补丁。用户随后明确停止 monk，并授权主代理直接开发；本轮主线由主代理实现，不再调用其他模型。此前 worker 空白 handoff 成功误报的技能修正保留，与 Nexus 实现分属不同仓库。
