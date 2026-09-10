# 从安装到第一个 agent 会话

[English](QUICKSTART_EN.md) · [返回首页](../README_CN.md)

## 1. 准备环境

推荐 Ubuntu 24.04+，使用普通用户安装。WSL2 必须先启用 systemd。
macOS、原生 Windows、Alpine/musl 不在预编译包支持范围内。

```bash
sudo apt update
sudo apt install -y tmux zsh python3 curl git ca-certificates
uname -m
getconf GNU_LIBC_VERSION
systemctl --user show-environment >/dev/null
```

二进制包要求输出包含 `x86_64`，glibc 版本至少 2.39。最后一个命令应成功，
它检查实际用户服务管理器是否可用；只有 `systemctl --version` 成功还不够。

如果 WSL2 没有启用 systemd，按 [Microsoft 指南](https://learn.microsoft.com/windows/wsl/systemd)
启用并重启 WSL。暂时不能启用时，可用后文的前台模式。

Claude/Codex CLI 可在 Nexus 安装后另行安装和登录。Nexus 不包含模型订阅或 API
额度，也不会替你安装这些 CLI。先确保宿主机终端中对应的 `claude --version`
或 `codex --version` 可用。

## 2. 安装二进制包（推荐）

从 [Releases](https://github.com/Jiang0977/nexus/releases) 下载：

- `nexus-4.5.0-linux-x86_64.tar.gz`
- `SHA256SUMS`

在下载目录执行。只在校验通过后继续；这组命令用于全新安装，升级见部署手册。

```bash
sha256sum --ignore-missing -c SHA256SUMS
mkdir -p "$HOME/.local/lib/nexus"
tar -xzf nexus-4.5.0-linux-x86_64.tar.gz -C "$HOME/.local/lib/nexus" --strip-components=1
cd "$HOME/.local/lib/nexus"
./setup.sh
```

不需要 Node、npm 或 Rust。安装器生成 `.env`，显示随机登录密码，并安装三个
`systemd --user` 服务。**保存显示的密码**：没有通用默认密码。不要把安装日志
或 `.env` 上传到 GitHub。安装目录是运行目录，服务会继续从这里读取程序。

如果安装中途失败，先保存已经显示的密码，再查看报错。重跑安装器会保留现有
自定义凭据；忘记密码可按第 7 节重置。

## 3. 或者从源码安装

先安装 Rust stable（[官方安装说明](https://www.rust-lang.org/tools/install)）及编译依赖：

```bash
sudo apt install -y build-essential cmake pkg-config
git clone https://github.com/Jiang0977/nexus.git
cd nexus
cargo --version
./setup.sh
```

安装脚本构建全部 Rust binaries，包括安装器和 native session CLI。首次编译
可能耗时较长。仓库包含 `frontend/dist/`，仅运行无需重新构建前端。

无 systemd 或只想前台运行时：

```bash
./setup.sh --configure-only
bash start.sh
```

`--configure-only` 生成安全凭据，不安装或启动服务。用 Ctrl+C 停止前台服务。
此模式不提供独立 systemd 守护的重启保证；native 模式还需要另行运行 supervisor。

## 4. 登录并创建第一个项目

1. 在安装机器打开 `http://127.0.0.1:59000`，输入安装器显示的密码。
2. 根据首次设置提示选择 agent 配置；暂时没有 CLI 时可稍后设置。
3. 检查安装目录 `.env` 中的 `WORKSPACE_ROOT`。建议改为自己的项目根目录，
   例如 `/home/demo/projects`；目录需要存在，并允许运行 Nexus 的账户访问。
4. 修改 `.env` 后执行 `systemctl --user restart nexus`。
5. 在项目列表点击新增项目，选择根目录下的一个项目目录。
6. 在项目中新建频道。先选择 Bash 等普通 shell，运行 `pwd` 验证工作目录。
7. 新建 Claude/Codex 频道；相应 CLI 必须已在宿主机安装并完成登录，或配置了
   可用的 provider profile。已有终端不会因为切换 profile 自动重新启动。

项目对应目录，频道对应该目录中的一个终端会话。关闭网页不会删除频道。
电脑端可在布局控件中选择分屏，然后为各窗格选择频道。提示词库插入只填写
当前终端，仍需要你按 Enter 发送。删除频道会结束相应运行进程。

## 5. Agent 登录与 Profile

优先先在宿主机终端完成 CLI 登录，并用简单指令验证能正常运行，再在 Nexus
创建对应频道。NVM/Volta 安装的 CLI 会由启动脚本尝试发现；仍找不到时检查
服务日志和 CLI 路径。

Profile 可在界面的 agent 设置中管理。持久化目录为：

- Claude：`data/configs/`
- Codex：`data/codex-configs/`

这些文件可能含 API key，不应提交或分享。不同供应商的模型名、API 地址和
认证字段应以供应商说明为准；不要把示例值当作有效凭据。Codex 历史来自对应
CLI 的本地会话记录；没有历史时面板为空属于正常情况。

**权限提醒：**终端以 Nexus 系统账户运行。Claude/Codex 启动器默认跳过权限
确认，Codex 也跳过自身沙箱。`WORKSPACE_ROOT` 仅限定工作区浏览等功能，不是
对 shell 命令的隔离。完整说明见 [SECURITY.md](../SECURITY.md)。

## 6. 从手机访问

手机的 `127.0.0.1` 指向手机自身。远程接入需要让手机访问运行 Nexus 的电脑。
推荐使用私有 Tailscale 网络：两端登录自己的 tailnet，确认电脑在线，然后按
[Tailscale Serve 文档](https://tailscale.com/kb/1242/tailscale-serve)将本机
`http://127.0.0.1:59000` 发布为 tailnet 内的 HTTPS 服务。不要启用面向公网的 Funnel。

复制 Serve 显示的 HTTPS 地址到手机浏览器，使用 Nexus 密码登录。Android 可在
浏览器菜单安装 PWA；iPhone 可从 Safari 分享菜单添加到主屏幕。电脑休眠或关机
时无法继续远程访问。PWA 不能替代服务器连接。

如果使用其他反向代理，配置 HTTPS、WebSocket 转发和额外的访问控制，并隐藏
访问日志中的 query token。不要仅因为使用了隧道就取消访问限制。

## 7. 密码、状态与故障排查

重置密码和 JWT（会使旧登录 token 失效）：

```bash
cd "$HOME/.local/lib/nexus"  # 源码安装改为实际仓库目录
./setup.sh --configure-only --reset-password
systemctl --user restart nexus
```

保存新密码；前台模式改为停止并重新运行 `bash start.sh`。

检查服务：

```bash
systemctl --user status nexus nexus-tmux nexus-native-pty --no-pager
journalctl --user -u nexus -n 50 --no-pager
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:59000/api/version
```

未登录请求 `/api/version` 返回 **401** 是正常的鉴权保护信号；首页应返回 200。

| 现象 | 处理 |
|---|---|
| `JWT_SECRET must be set` | 在安装目录执行 `./setup.sh --configure-only`，不要直接使用空示例配置 |
| `Failed to connect to bus` | 启用用户 systemd；或使用前台模式 |
| `GLIBC_x.y not found` | 使用受支持系统，或在当前机器从源码构建 |
| 找不到 `cargo` | 二进制包无需 cargo；源码安装需先安装 Rust 并加载其 PATH |
| 找不到 agent CLI | 先在宿主机验证 CLI；重启 Nexus/tmux 服务会影响已有会话，应先保存工作 |
| 前端修改没有生效 | 安装前端依赖并重建 `frontend/dist/`，再按部署手册更新 |
| 本地能访问，手机不能 | 检查电脑在线、VPN/代理状态，以及手机使用的是否为电脑的 HTTPS 地址 |

## 8. 开发与验证

需要 Node.js 22.13+、npm、Rust stable 和运行依赖：

```bash
npm ci
npm --prefix frontend ci
npx playwright install --with-deps chromium
npm run check
cargo fmt --manifest-path rust-runtime/Cargo.toml --check
cargo clippy --manifest-path rust-runtime/Cargo.toml --all-targets --all-features -- -D warnings
```

`npm run check` 包含 Rust/Node 测试、前端构建和已提交产物一致性检查。
前端有意修改后，先执行 `npm run build:frontend` 并将新产物纳入变更。

真实登录上传 smoke 需要本机 `.context/secrets/e2e.env`，内容为
`NEXUS_E2E_PASSWORD=<当前密码>`，权限设为 600。执行 `npm run smoke:login-upload`。
它会上传临时 CSV、验证终端 WebSocket 输入并清理上传；运行前选择可接受测试
输入的频道。可用 `NEXUS_E2E_BASE_URL`、`NEXUS_E2E_SESSION`、`NEXUS_E2E_WINDOW`
覆盖目标。不要将密码粘贴到公开 Issue。

## 9. 可选 native 后端

默认 tmux 是稳定路径。native 仍为 opt-in/staging，请先保存工作，并保留回退能力。
在设置中选择 Terminal Backend → native 并保存，再重启 Nexus。确认
`nexus-native-pty.service` 正常运行。显式 `.env` 中的 `NEXUS_SESSION_BACKEND`
优先于 UI 保存值，因此排查切换失败时也要检查该变量。

```bash
systemctl --user restart nexus
systemctl --user status nexus-native-pty --no-pager
nexus-native-session list
nexus-native-session attach <project> <channel-index>
```

将 `~/.local/bin` 加入 PATH 后可直接使用 CLI。回退时在设置选择 tmux，移除
冲突的 `.env` 覆盖并重启 Nexus；这不会把 native 会话转换为 tmux 会话。
不要在有重要 native 进程运行时重启 supervisor。

更新、备份、回滚和卸载见[部署手册](DEPLOYMENT-RUNBOOK.md)。
