# Native 终端专项最终验收：2026-09-10

结论：本机单用户、自托管、用户指定 native 部署的终端改造已通过约定验收。实现提交 `58cb569`，发布时 HEAD `5426d01`；2026-09-10 09:36 CST 部署到 `/home/demo/.local/lib/nexus`，重启 nexus 和 native supervisor。指定入口 `https://nexus.example.com:8443/` 的真实验收通过。此结论不代表所有项目 TODO、物理手机、AI 推理供应商或任意终端扩展均已认证。

## 实现与缺陷闭环

- Native 从 ANSI 尾片段重放改为有界完整状态 checkpoint，覆盖主/备用屏幕、保存光标、属性、滚动区、输入模式与未完成控制序列；输出、快照和订阅有序。
- 多视图共享最小逻辑尺寸，所有视图按同一尺寸恢复；浏览器串行写入并限制积压，旧协议和非法状态失败关闭。断开不误杀底层应用，EOF 在输出排空后通知。
- 显式 channel scroll profile 持久生效，优先级为标准鼠标协议、配置 profile、临时手动选择；无 Grok/应用标题特判。
- avt 0.18.0 最小兼容分支与浏览器共享官方 Unicode 11 宽度表。跨引擎和随机测试发现并修复组合字符续写、RGB 参数、宽字符插入及 DCH 换行标记差异。保留上游测试、许可证、回归种子及补丁说明。
- 修复大视口共享小终端网格时的黑色空白区；浅色/深色浏览器回归通过。
- 发布前按 code-review-expert 检查协议、资源边界、并发顺序和回滚兼容性，由主会话审核；未使用独立模型评审。Native attach 失败会撤销尺寸请求。验收脚本以新建项目的真实路径和名称唯一性确认清理范围，兼容长路径名称截断。

## 自动化与隔离验收

- `npm run check`：退出 0，Rust **222/222**（项目 118 + vendored avt 104）、Node **215/215**，前端 typecheck/build 与提交后的 dist 一致性通过。日志 `/tmp/nexus-final-check.log`。
- Rust fmt、all-targets/all-features clippy `-D warnings` 通过；release server/runtime 构建通过。额外 `PROPTEST_CASES=4096` 的 vendor 测试通过，日志 `/tmp/nexus-avt-4096.log`。
- 真实 Chrome/xterm 与 release native PTY 对照检查：完整大于 2000 字符的 TUI、主/备用屏幕、保存光标续写、部分 CSI、真彩色、组合字符、宽字符插入属性、共享 resize、断开重挂、EOF。真实 tmux 回归仍通过。
- 浏览器回归包含标准与显式 SGR 滚动、普通历史、桌面/移动触摸、分屏隔离、刷新/异常重连、Ctrl+wheel、浅/深主题和未知协议拒绝。
- `npm run smoke:native -- --cli-smoke`：隔离环境 **12 项通过**，真实 registry-backed shell + 独立 supervisor/server + Chrome；nexus server 重启后 PTY PID 保持不变。证据 `/tmp/nexus-native-acceptance-XyikM2`。
- npm root/frontend 扫描零已知漏洞；OSV 查询 Cargo.lock 176 个 registry 包及 avt 0.18.0 零命中。未安装 cargo-audit，未将 OSV 结果冒称 cargo-audit。扫描不证明不存在漏洞。

## 部署与真实 HTTPS 验收

- `npm run deploy:service -- --frontend --restart-native-pty` 成功。旧 supervisor 已明确重启，不能再把磁盘新文件误认为运行中旧进程已刷新。
- nexus PID **1576561**，native supervisor PID **1576523**；均 active、`NRestarts=0`。两者 `/proc/<pid>/exe` 与安装/仓库构建哈希一致。7 个安装二进制、16 个安装及 HTTPS 实际返回的前端文件逐一一致；证据 `/tmp/nexus-native-install-parity.json`。
- HTTPS `/api/health` 为 200；未登录 `/api/version` 为 401；真实登录后的配置明确返回 `sessionBackend=native`、`configuredSessionBackend=native`。
- `npm run smoke:native -- --live --cli-smoke` **11 项通过**：认证、旧 native 协议拒绝、桌面双窗格与移动视口、刷新保留计数与 PID、WS 重连、60 次握手、无浏览器异常、真实登录/CSV 上传/路径单次发送、Codex 与 Grok 启动画面及重连。
- 60 次握手分 20 批、每批 3 并发，PTY PID **1584009** 不变；本次 p95 **19.24 ms**，最大 **21.27 ms**。这是本机短时恢复测量，不是容量或 SLA 保证。
- 桌面/移动截图已复核，中文与 emoji 网格对齐、首尾标记可见、空白区随主题；Grok 1.0.25 显示真实主界面，Codex 0.154.0 覆盖启动/目录信任画面。未接受信任提示或发送 AI 请求，未修改 API 配置。
- 测试结束后：所属 native 项目剩余 0，测试 PID 已退出，临时上传已删除。只清理本轮创建的项目/文件，不删除已有用户项目。
- 发布至验收结束，两个服务 error 级 journal 及 panic/fatal 检索无命中。未触发回滚。旧二进制与前端备份保留 `/tmp/nexus-native-final-rollback.wEAeJV`，不含密钥配置。

真实验收证据：`/tmp/nexus-native-acceptance-29CGA0/{result.json,churn.json,login-upload.log,desktop.png,mobile.png,codex-startup.png,grok-startup.png}`；部署日志 `/tmp/nexus-native-final-deploy.log`、真实入口结果 `/tmp/nexus-native-live-final2.log`。这些是本机临时证据，关键结果已写入本文。

## 明确边界

- Native 在全项目仍是显式选择，不改为所有用户的默认后端。本机已按用户要求使用 native。
- checkpoint 历史 200 行、最大 500×200 网格、4 KiB 控制前缀及 8 MiB 快照；超限拒绝恢复，需新建通道，不静默截断。共享小屏尺寸造成桌面留白是预期行为。
- nexus server 重启不等于 supervisor/系统重启；后两者中断应用，未实现主机崩溃后的持久进程恢复。
- 移动覆盖为 Chrome 触摸/视口模拟，不是物理手机或 Safari。Codex/Grok 是实际程序启动与恢复，不是模型推理、额度或工具执行验收；Claude Code/Pi 仍为协议 fixture。
- sixel、kitty 图像、OSC 8 链接元数据等扩展不在已认证快照能力内；未做长时间 soak、多用户隔离或大规模容量验收。详见 [设计与运行限制](../designs/native-terminal-checkpoint.md)。
