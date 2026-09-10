# 2026-09-10 本机生产部署验收

> Historical environment-specific evidence. Personal paths, project names and addresses have been anonymized; examples are not executable deployment targets.

结论：实现提交 `b90bde379f7b010cb211e24d53e002f743d7b945` 已推送 main，并于 2026-09-10 02:58 CST 部署到本机 `/home/demo/.local/lib/nexus`，重启 nexus 后通过真实生产入口验收。范围为现有单用户、自托管、默认 tmux 产品；native 仍为 opt-in/staging。下文分别保留开发、隔离验收和部署证据，不扩大为物理手机、真实 AI 推理或容量认证。

## 实现与迭代

- 修复 native fallback PTY 在再次 attach 时被误判为过期而重建，导致历史丢失的缺陷。区分“注册通道不存在”与“数据库异常”；后者返回错误并保留已有 PTY。注册通道出现时仍替换 fallback，不回退既有生命周期修复。
- 删除 Grok 标题特判。标准 xterm 鼠标模式优先；非标准 TUI 可临时选择“应用滚动 (SGR)”。选择仅属于当前视图/通道，同目标重连保留，切换通道或刷新重置，不触发额外 WebSocket。退出非标准 TUI 后需手动恢复自动。
- 移动端滚动与复制控件放到内容外，避免遮住终端首行；Codex profile 下拉框补充可访问名称。按 React 生命周期审查规则，事件监听器读取稳定 ref，模式选择不进入连接 effect 的重建依赖。
- 更新有已知漏洞的依赖：bcrypt 6、ws 8.21.3、DOMPurify 3.4.15、PostCSS 8.5.28、Vite 6.4.3；保留 React 18 / xterm 6。Rust jsonwebtoken 10.3.0 使用 aws-lc 后端，定向更新 anyhow、rand 和相关锁文件。
- JWT 仍只接受 HS256、有有效 exp 的令牌；启用可选 nbf 校验。独立 Node HMAC 生成的旧格式令牌可通过真实 release HTTP 鉴权，错误签名、过期、缺少 exp、未来或错误类型 nbf 被拒绝。无密钥轮换或数据迁移。
- DOMPurify 更新后通过真实文件预览验证 Markdown 标题、表格、代码、中文及编辑原文保留，同时拒绝 script、事件属性、javascript 链接及 iframe 内容。

依赖变更依据：[DOMPurify 官方发布](https://github.com/cure53/DOMPurify/releases)、[JWT 官方安全公告](https://github.com/Keats/jsonwebtoken/security/advisories/GHSA-h395-gr6q-cpjc)、[Vite 6 官方迁移指南](https://v6.vite.dev/guide/migration)。Vite 采用最小必要大版本升级；未引入新的产品功能依赖。

## 测试结果

| 检查 | 结果 |
| --- | --- |
| 初始基线 | Rust 107 通过；Node 200/203，3 项 native 失败 |
| native/依赖第一轮完整回归 | Rust 110；Node 203/203 通过 |
| 滚动/UI 迭代 | 发现 5 项旧测试定位假设失效；改为精确 profile 名称和实际 xterm 视口测量，未删除行为断言 |
| 最终 `npm run check` 的测试阶段 | Rust 110/110；Node 207/207，其中浏览器 43/43；无跳过 |
| 前端 typecheck/build | 通过；Vite 6 构建正常 |
| `cargo fmt --check` / clippy 全目标全特性 `-D warnings` | 通过 |
| `cargo build --release --bins` | 通过，包含 server、runtimes、Codex HOME、setup |
| 新目录再次构建并 `diff -qr` 对比 `frontend/dist` | 完全一致 |
| 根目录及前端完整 npm audit | 两者均 0 个已知漏洞 |
| Cargo.lock 中 172 个 registry crate 的 OSV 扫描 | 0 个已知公告命中 |

开发阶段 `npm run check` 整体退出码为 1：最后 `check:frontend-dist` 按 Git 工作树状态检查，尚未提交的重新生成 bundle 被标记；独立构建已证明源文件与 bundle 同步。用户授权提交后再次执行完整 `npm run check`，Rust 110、Node 207、前端构建和无漂移门禁全部通过，整体退出码 **0**。门禁逻辑未被修改或绕过。

## 隔离环境真实 release 验收

使用独立 loopback 端口、临时数据/工作目录、独立 tmux socket 与无用户 profile 的 Chromium。使用当前 checkout 的 release 二进制和真实登录页；只有浏览器布局存储被隔离拦截，终端、WebSocket、上传及文件接口为真实路径。没有操作生产服务、用户通道或 AI provider。

- 12 项浏览器检查通过：served assets 与 checkout 一致；桌面双窗格完整重绘；刷新后屏幕与应用 PID 保留；强制结束一个 tmux client 后独立重连；保存光标后的继续输出；resize；移动端刷新、TUI 退出后的真实历史触摸；31 秒空闲无重连；真实 bash 历史滚轮；真实登录上传路径恰好发送一次；布局不变且无浏览器错误。
- 额外完成 Unicode/空格文件名的真实文件创建、读写、删除，以及独立 JWT 兼容/拒绝测试。
- 60 次真实 WebSocket 握手，3 并发、20 批次，混合正常关闭与异常断开：最终 0 遗留 client、0 遗留 grouped session，应用 PID 保留。该轮本机 p95 58.72 ms、最大 65.79 ms；这是小规模回归数据，不是容量承诺。
- 桌面和移动截图人工检查通过：新增控件不覆盖首行，TUI 完整帧及底部标记可见。测试会话、独立 server 和 tmux server 均已结束。

## 未覆盖与上线边界

- 私有 capability/launch profile、native 完整屏幕状态恢复继续留在 TODO，不能用本轮 PTY 生命周期修复冒充完成。
- Claude Code/Pi 为协议 fixture，不是实际 AI CLI 推理验收；没有消耗官方 Grok/Codex 等套餐。移动端使用 Chromium 触摸模拟，不是物理手机/Safari 验收。
- 未做长时间 soak、大并发容量测试或多用户安全认证；依赖扫描零命中不等于不存在漏洞。
- 已完成下述默认 tmux 部署。现场 native supervisor 仍有 7 个子进程，因此保留其原进程；新 native 二进制已安装但旧 supervisor 没有重新加载，不能声称既有 native 通道已应用本轮修复。未停止既有 tmux 应用进程。

## 真实生产入口验收

用户明确授权本机后续生产级验收后，按“提交 → 完整检查 → 推送 → 备份 → 部署重启 → 实际入口验收”串行执行。

- `npm run deploy:service -- --frontend` 成功；`nexus.service` PID 从 `1537384` 变为 `2550508`，保持 active，验收结束时 `NRestarts=0`。
- 7 个安装 runtime 二进制及 16 个前端文件逐一校验一致，`/proc/2550508/exe` 哈希等于当前 server 构建；首页和公开引用的 assets 与 checkout 一致。
- `http://127.0.0.1:59000/api/health` 为 200；未登录 `/api/version` 为 401，登录后可访问。发布前获取且仅保存在测试进程内存的真实 JWT，在升级重启后仍被接受。
- 在 `http://127.0.0.1:59000` 重跑上述 12 项真实浏览器检查，全部通过，包含实际登录上传一次性路径发送、桌面分屏、移动触摸、刷新和异常重连；截图复核通过。仅布局持久化在浏览器中隔离，认证、PTY、WS、上传和 served assets 使用实际安装服务。
- 另建专用 shell 通道进行 60 次握手、3 并发、正常关闭/异常断开混合测试：测试所属 client/group 最终均为 0，应用 PID 不变；本机 p95 42.85 ms、最大 45.00 ms。测试通道已清理，其他会话保留。
- 从部署前一分钟至验收结束的 nexus journal 中，error 级及以上记录为 0，Rust panic/fatal runtime 命中为 0；这不是长时间运行保证。
- 未触发回滚。额外保留旧安装二进制和前端备份于 `/tmp/nexus-release-acceptance.eUBiEq/rollback`（约 28 MB，不含密钥配置）。

部署证据目录 `/tmp/nexus-release-acceptance.eUBiEq`：`check.log`、`deploy.log`、`install-parity.json`、`token-compat.log`、`live.log`、`live-results.json`、`churn-results.json` 及桌面/移动截图。以上为本机临时证据，本文保留关键结果。

## 本机原始证据

目录：`/tmp/nexus-production-acceptance-20260910.s1NTR5`（临时目录，非长期归档）。

- `baseline-check.log`、`iteration1-check.log`、`final-check.log`、`iteration3-check.log`：基线及每轮完整测试。
- `native-db-error-test.log`、`auth-red.log`、`auth-green.log`、`scroll-red.log`、`scroll-lifecycle-final.log`：定向红绿验证。
- `final-release.log`、`final-clippy.log`、`repro-build.log`、`repro-diff.log`：构建和一致性。
- `root-audit-final.json`、`frontend-audit-final.json`、`rust-audit-updated.json`：依赖检查。
- `final-live.log`、`isolated-UIcnSl/live-results.json`、`isolated-UIcnSl/churn-results.json`、`isolated-UIcnSl/desktop-tui.png`、`isolated-UIcnSl/mobile-tui.png`：真实验收结果。
