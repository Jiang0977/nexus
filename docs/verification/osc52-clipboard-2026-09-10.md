# OSC 52 浏览器剪贴板验收（2026-09-10）

## 实现

- 桌面分屏、单终端/移动视图共用 `terminalOsc52.ts`，通过 xterm 公共 OSC handler 接收应用复制请求，严格解码 Base64/UTF-8，保留中文、emoji、组合字符、空白和换行。上限 128 KiB；支持剪贴板/默认选择，不将 X11 PRIMARY 或 cut buffer 单独映射到浏览器剪贴板。
- 仅允许写入，不响应 `?` 读取请求，不向 PTY 回传剪贴板内容；忽略清空、非法与超限请求。浏览器前台焦点、窗格焦点、五秒内可信用户操作共同满足时自动写入，每次操作最多一次。其他情况提供窗格内“点击复制”；通知不会展示复制内容，30 秒过期。
- 权限 Promise 不阻塞终端解析/输出；断线重连、换通道、销毁会清理提示，迟到的旧 Promise 不会复活旧 UI。权限拒绝时不报告成功。
- native 将 OSC 52 视为瞬时副作用，不再缓存其正文，也不让长复制触发普通控制前缀的 4 KiB 恢复上限。半条复制时重挂接恢复一个无效 Base64 前缀，仅消费后续尾部、不执行复制；完成后的复制从不进入 checkpoint。覆盖 ESC/BEL/ST 分片、C1 OSC/ST 和前导零编号。
- 环境回归测试曾把 ANSI checkpoint 的 REP 当成普通文字，存在依赖进程退出时序的误报；改为验证该 PTY 子进程写出的限定环境变量，保留输出到达断言。渲染语义仍由真实 Chrome 测试负责，没有放宽环境值断言。

## 开发验证

- 长 OSC 52 导致恢复失败：先得到失败回归，再修复并通过。
- 单元覆盖非法 Base64、非法 UTF-8、读取/清空请求、非剪贴板选择、尺寸上限、中文/emoji/组合字符和空白。
- 桌面/移动浏览器回归：真实浏览器剪贴板写入；模拟权限拒绝后用户点击重试；普通输出不中断；无读取或 OSC 回传；非焦点窗格不自动写；重连清理提示及延迟 Promise 隔离。
- 隔离真实 native 验收 **14 项通过**，目录 `/tmp/nexus-native-acceptance-fEz2Oy`。复制超过 4 KiB 的文本，只有当前分屏触发一次浏览器写入；刷新/重连不会覆盖哨兵剪贴板值。
- 实际 Grok 1.0.25 `/session-info` 点击 Session ID 后，精确校验浏览器 `navigator.clipboard.writeText` 收到该 ID，并验证读回值。此断言排除了“只写入 Ubuntu 的 OS 剪贴板”的假阳性。没有提交推理任务。
- `npm test`：Rust **224 项通过**（含 vendored avt），Node **219 项通过**（含 **47 项浏览器回归**），无失败或跳过。最终日志 `/tmp/nexus-osc52-final-tests2.log`。
- `npm run build:frontend`、`cargo fmt --manifest-path rust-runtime/Cargo.toml --check`、`cargo clippy --manifest-path rust-runtime/Cargo.toml --all-targets --all-features -- -D warnings` 均通过。发布脚本重新构建了 release 运行时和前端。
- 发布验收时改动尚未提交，因此未用要求 `frontend/dist` 已提交的 `npm run check` 宣称全绿；实际完成其测试和构建检查，并另外核验线上产物哈希。

## 部署结果

- `npm run deploy:service -- --frontend --restart-native-pty` 成功。2026-09-10 **15:55:15 CST** 重启 `nexus.service`（PID **398533**）和 `nexus-native-pty.service`（PID **398498**），均 active，`NRestarts=0`；健康检查 `/api/version` 返回预期的未认证 **401**。
- 从 `https://nexus.example.com:8443/` 回读 **16 个前端文件**，与仓库构建、安装树哈希一致；**7 个 release 二进制**一致，两个服务实际加载的 `/proc/PID/exe` 也与新安装二进制一致。认证后确认配置与实际 backend 都是 `native`。证据 `/tmp/nexus-osc52-install-parity.json`。
- `npm run smoke:native -- --live --clipboard-smoke --cli-smoke` **13 项通过**，证据目录 `/tmp/nexus-native-acceptance-ytC7gI`，日志 `/tmp/nexus-osc52-live.log`。包含真实 HTTPS 登录/上传、桌面分屏/移动显示、刷新/断线恢复、60 次握手、旧协议拒绝、长文本浏览器复制及不重复复制、Codex/Grok 启动与重连、实际 Grok 点击字段到浏览器剪贴板。页面错误为零；无模型推理请求。
- Grok 实测同时校验浏览器 `writeText` 调用和读回内容，且只有焦点窗格自动写入一次；截图 `grok-osc52-copy.png` 已人工查看。测试通过 `GROK_COPY_FILE` 将 Grok 文件备份限定在验收目录，不修改 Grok API 或用户配置。
- 验收结束后临时项目残留 **0**、测试 PTY 进程已退出、临时上传已删除；两个服务仍 active、无自动重启，发布后 error 级日志 **0**。再次核验 7 个二进制、16 个线上文件和实际加载进程一致。
- 回滚备份 `/tmp/nexus-osc52-rollback.0g7BV7` 仅含旧二进制和前端产物，不含密钥配置；本次未触发回滚。

## 使用边界

浏览器需要 HTTPS/安全上下文及剪贴板写权限。焦点不在该终端、移动输入焦点位于终端外或浏览器拒绝自动写入时，点击提示中的“点击复制”。Grok 自己的文件备份/未确认投递提示并不等于浏览器写入失败，以 Nexus 的写入结果和目标电脑实际粘贴结果为准。

浏览器验收使用本机隔离 Chrome，不替代用户远端物理 Windows/macOS 浏览器的最终粘贴验证。普通 Shift 拖选 + Ctrl+C 路径保持不变。

设计、协议依据和复验命令见 [Native checkpoint / OSC 52](../designs/native-terminal-checkpoint.md#osc-52-clipboard-writes)。
