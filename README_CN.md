# Nexus

在电脑或手机浏览器里运行和管理你本机的 AI 编码助手。

[English](README.md) · [完整教程](docs/QUICKSTART.md) · [下载安装包](https://github.com/Jiang0977/nexus/releases) · [GPL-3.0-or-later](LICENSE.md)

Nexus 是单用户、自托管的编码工作台。打开一个项目，启动 Claude、Codex
或普通 shell，关闭浏览器后再回来，仍可接续原来的终端会话。电脑端支持多终端
分屏，手机端可以输入指令、上传文件和切换项目。

本项目基于 [Nexus4CC](https://github.com/librae8226/nexus4cc)，由 Jiang0977
独立维护修改版。感谢原作者 librae8226、faywong 和其他贡献者。本分支增加了
Rust 运行时、终端状态恢复、可选 native PTY 后端和工作区工具。
详见[版权说明](LICENSE.md)和[更新记录](CHANGELOG.md)。

<p>
  <img src="docs/images/desktop.png" alt="Nexus desktop terminal with a synthetic demo project" width="72%">
  <img src="docs/images/mobile.png" alt="Nexus mobile terminal with the same demo project" width="24%">
</p>

## 主要功能

- 把目录组织为项目，每个项目下可运行多个 agent 或 shell 频道。
- 电脑端支持单窗格、左右分屏、上下分屏、2×2 和 3×3 布局。
- 浏览、编辑、上传、下载、重命名、移动和复制工作区文件。
- 保存、搜索、拖动排序和插入提示词，插入时不会自动发送。
- 配置 Claude/Codex profile，浏览和恢复 Codex 历史会话。
- 深色/浅色主题，通过 HTTPS 安装为 PWA。

默认使用 **tmux**：浏览器断线或 Nexus 服务重启后可以重新连接原会话。
**native** Rust PTY 后端仍为可选实验路径。这两种模式都不保证电脑重启后
恢复原来运行中的进程；PWA 也不能在服务器离线时继续操作终端。

## 安装

当前支持 **Linux + systemd 用户服务**，包括已启用 systemd 的 WSL2。
预编译包支持 **Linux x86_64、glibc 2.39+**（Ubuntu 24.04 及以上）。
其他 Linux 环境可从源码构建。本次发行不支持 macOS 或原生 Windows 安装。

Ubuntu 先安装运行依赖：

```bash
sudo apt update
sudo apt install -y tmux zsh python3 curl git ca-certificates
```

从 [Releases](https://github.com/Jiang0977/nexus/releases) 下载二进制压缩包及
`SHA256SUMS`，在下载目录运行：

```bash
sha256sum --ignore-missing -c SHA256SUMS
mkdir -p "$HOME/.local/lib/nexus"
tar -xzf nexus-4.5.0-linux-x86_64.tar.gz -C "$HOME/.local/lib/nexus" --strip-components=1
cd "$HOME/.local/lib/nexus"
./setup.sh
```

保存安装器显示的随机密码，打开 **http://127.0.0.1:59000**。
安装器创建 `.env` 和三个用户服务：Nexus、tmux、native supervisor；使用
默认 tmux 后端时，native supervisor 保持空闲。安装完成后不要移动目录。

从源码安装需另装 Rust stable、C/C++ 编译工具链和 CMake：

```bash
git clone https://github.com/Jiang0977/nexus.git
cd nexus
./setup.sh
```

仓库包含前端构建产物，单纯运行不需要 Node。源码安装会编译全部 Rust
程序，耗时取决于机器。前台模式使用 `./setup.sh --configure-only`，然后
`bash start.sh`。首次登录、创建频道、配置 agent 和手机接入见[完整教程](docs/QUICKSTART.md)。

## 权限与安全

**登录后的终端拥有运行 Nexus 的系统账户权限。** `WORKSPACE_ROOT` 不是
shell 沙箱。Claude/Codex 启动器目前跳过权限确认，Codex 还跳过自身沙箱。
连接敏感项目之前，请阅读 [SECURITY.md](SECURITY.md)。

服务默认只监听本机回环地址。远程访问使用私有 VPN 或带身份验证的 HTTPS
反向代理，不要把服务直接暴露到公网。不要公开 `.env`、`data/`、终端历史或
profile 凭据。

## 开发与更新

开发需要 Node.js 22.13+（或更新的受支持 LTS）、npm、Rust stable 及前述运行依赖。

```bash
npm ci
npm --prefix frontend ci
npx playwright install --with-deps chromium
npm run check
```

生产服务使用 `frontend/dist/`；修改前端后执行 `npm run build:frontend`。
源码部署使用 `npm run deploy:service -- --frontend`，会自动识别用户级或
系统级服务。两者同时存在时明确设置 `NEXUS_SERVICE_SCOPE=user` 或 `system`。
更新前阅读[部署手册](docs/DEPLOYMENT-RUNBOOK.md)，其中包含备份、回滚和卸载步骤。

## 文档

| 文档 | 用途 |
|---|---|
| [中文教程](docs/QUICKSTART.md) / [English tutorial](docs/QUICKSTART_EN.md) | 从安装到第一个 agent 会话 |
| [部署手册](docs/DEPLOYMENT-RUNBOOK.md) | 更新、备份、回滚和卸载 |
| [架构](docs/ARCHITECTURE.md) / [源码导览](docs/code.md) | 运行结构与模块边界 |
| [当前路线图](docs/CURRENT-ROADMAP.md) | 当前边界与剩余工作 |
| [贡献指南](CONTRIBUTING.md) | 检查、问题反馈与 PR |
| [安全说明](SECURITY.md) | 权限边界和私密漏洞报告 |

## 许可证

本修改版按 **GPL-3.0-or-later** 发布，保留原作者版权与第三方声明。
详见 [LICENSE.md](LICENSE.md)、[COPYING](COPYING) 和 [THIRD_PARTY.md](THIRD_PARTY.md)。
