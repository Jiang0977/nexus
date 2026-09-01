# Nexus

自托管的本地 AI 编码工作台：用桌面、手机或浏览器终端管理运行在自己机器上的 coding agent。

[![Rust](https://img.shields.io/badge/rust-stable-orange?style=flat-square)](https://www.rust-lang.org/)
[![License: GPL v3 / 商业授权](https://img.shields.io/badge/license-GPL%20v3%20%2F%20商业授权-blue?style=flat-square)](LICENSE.md)
[![GitHub stars](https://img.shields.io/github/stars/Jiang0977/nexus?style=flat-square)](https://github.com/Jiang0977/nexus/stargazers)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square)](CONTRIBUTING.md)

[English](README.md)

## 这是什么

Nexus 是单用户、自托管的本地 AI agent 控制台。它运行在你自己的机器上，通过 PWA / 浏览器 UI 暴露终端、项目、频道、任务和文件管理能力；浏览器关掉后，底层 agent session 仍然继续运行。

当前运行形态：

```text
Browser / PWA
  <-> Rust server (HTTP / WebSocket)
  <-> Rust child runtimes
  <-> session backend
      - tmux：默认稳定路径
      - native：opt-in Rust PTY 后端，仍在收敛
```

## 功能

- 基于 xterm.js 的浏览器终端：移动端触控、scrollback、上传、可配置工具栏。
- 项目与频道管理：项目对应目录，每个项目下有多个终端频道。
- PC split view：single / vertical / horizontal / 2x2 / 3x3 多 pane 终端。
- 异步任务执行：Web 面板创建、SSE stdout/stderr 流式输出、历史记录查看/复用/删除；关闭面板后后台任务继续运行。
- 文件浏览器：浏览、编辑、上传、重命名、移动、复制、删除工作区文件；文件查看与下载使用 `Authorization: Bearer` fetch 与 Blob URL，JWT 不放入 URL query。
- 提示词库：保存、编辑、搜索、复制提示词，并可在不自动提交的前提下插入当前终端。
- Codex / Claude profile 启动器，包含 Codex history / resume 流程。
- PWA、深色/浅色主题，页面启动时注册 `/sw.js` Service Worker。
- Rust 优先运行链：`nexus-server` 直接伺服 `frontend/dist/`。

## 终端后端

| 后端 | 状态 | 说明 |
|---|---|---|
| `tmux` | 默认 / 稳定 | 生产路径。通过 `nexus-tmux.service` 保持会话，浏览器关闭或 `nexus` 服务重启后仍可接续。 |
| `native` | opt-in / staging | Rust PTY 后端，包含 `nexus-native-pty-supervisor`、SQLite native session registry、有界 scrollback 和 `nexus-native-session` CLI attach。它还不是默认生产路径。 |

切换方式：

- UI：Settings -> Terminal Backend -> 保存 -> 重启 `nexus`。
- 配置：在 `.env` 设置 `NEXUS_SESSION_BACKEND=native`，或写入 `data/session-backend.json`。
- native 模式还需要 `nexus-native-pty.service` 正在运行。
- 终端 WebSocket 默认由服务端每 10 秒发送一次心跳；仅在运维确有需要时，才在 `.env` 中把 `NEXUS_WS_HEARTBEAT_MS` 设置为其他正数。

从另一个终端进入 native session：

```bash
nexus-native-session list
nexus-native-session attach <project> <channel-index>
```

## 快速开始

```bash
git clone https://github.com/Jiang0977/nexus.git
cd nexus
./setup.sh
```

打开：

```text
http://127.0.0.1:59000
```

`./setup.sh` 会自动生成安全凭据（并在终端展示一次性随机密码）、写入 `.env`、安装 `systemd --user` unit、安装 native session CLI symlink，并启动：

- `nexus.service`
- `nexus-tmux.service`
- `nexus-native-pty.service`（未启用 native backend 时保持空闲）

直接前台启动：

```bash
bash start.sh
```

完整配置指南见 [docs/QUICKSTART.md](docs/QUICKSTART.md)。

## 开发

关键约束：

- 运行时伺服 `frontend/dist/`；`frontend/src/` 是源码，不是生产入口。
- 改前端源码后必须重建 `frontend/dist/`。
- Rust release binary 是部署产物。
- 仓库级验证入口是 `npm run check`。

常用命令：

```bash
npm run check
npm run build:frontend
npm run build:rust-runtimes
npm run smoke:login-upload
```

登录/上传 smoke 会读取 `.context/secrets/e2e.env`：

```text
NEXUS_E2E_PASSWORD=<当前 Nexus 登录密码>
```

## 部署

部署权威说明见 [docs/DEPLOYMENT-RUNBOOK.md](docs/DEPLOYMENT-RUNBOOK.md)。

常规部署：

```bash
npm run deploy:service
```

如果改了前端源码：

```bash
npm run deploy:service -- --frontend
```

如果可以中断 native sessions，且需要刷新 native supervisor binary：

```bash
npm run deploy:service -- --restart-native-pty
```

部署脚本会自动解析运行时安装树：优先 `NEXUS_INSTALL_ROOT`，否则通过 `systemctl show nexus.service -p WorkingDirectory` 自动发现，最后才回退到当前 checkout——并在构建后把新 binaries 和 `frontend/dist` 同步进安装树。release binary 使用同目录 rename 切换，文件级别是 atomic。`frontend/dist` 使用 staged 两次 rename 切换：`dist/` 会有一个极短的不存在窗口，但读者不会看到半复制目录。任意 build / sync / restart / healthcheck 失败都会先回滚 checkout 与安装树到部署前快照，再调用 restart helper。CLI symlink（`~/.local/bin/nexus-native-session`）指向安装树里的 binary，不再指向 checkout。

建议通过 Cloudflare Tunnel、Tailscale 或内网访问，不要直接暴露到公网。

## 环境要求

| 依赖 | 说明 |
|---|---|
| Rust stable toolchain | 构建 `nexus-server`、child runtimes、setup 和 native PTY binaries。 |
| tmux | 默认后端需要。 |
| systemd user services | `./setup.sh` 需要；`bash start.sh` 前台运行不需要。 |
| Node.js + npm | 前端开发、测试和 `npm run check` 需要。 |
| Linux / WSL2 | 当前主要部署目标。native backend 的更广平台支持仍在硬化。 |
| Claude / Codex CLI | 可选；只有在 Nexus 内启动对应 agent 时才需要。 |

## 安全

Nexus 是单用户工具，不是多租户平台。

- bcrypt 密码哈希 + 30 天 JWT。
- WebSocket token 通过 query string 传递；生产环境必须配 TLS。
- 放在防火墙、VPN 或 tunnel 后面运行。
- 浏览器终端等价于对 `WORKSPACE_ROOT` 的本地 shell 访问。

## 文档

| 文档 | 用途 |
|---|---|
| [QUICKSTART.md](docs/QUICKSTART.md) | 安装、配置、profile、native backend、smoke test。 |
| [DEPLOYMENT-RUNBOOK.md](docs/DEPLOYMENT-RUNBOOK.md) | 更新、重启、验证、回滚。 |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | 当前运行架构与模块边界。 |
| [CURRENT-ROADMAP.md](docs/CURRENT-ROADMAP.md) | 当前执行状态与文档权威顺序。 |
| [NORTH-STAR.md](docs/NORTH-STAR.md) | 产品边界和非目标。 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 本地开发和贡献规则。 |

## 贡献

欢迎 PR 和 Issue。保持改动范围单一，提交前运行 `npm run check`；运行时行为变化必须同步文档。

## 许可证

双重授权：[GPL v3](LICENSE.md) 用于开源使用，商业 / SaaS 使用可联系获取商业授权。
