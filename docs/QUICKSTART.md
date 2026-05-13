# Quick Start — 从零开始运行 Nexus

预计时间：10 分钟左右。默认平台：Linux / WSL2。

## 前置要求

| 依赖 | 检查命令 | 说明 |
|---|---|---|
| Rust stable toolchain | `cargo --version` | 用于构建 `nexus-server` 和 child runtimes |
| Node.js + npm | `node --version` / `npm --version` | 仅在修改前端源码并重建 `frontend/dist` 时需要 |
| tmux | `tmux -V` | Nexus 会话事实源 |
| systemd user services | `systemctl --user --version` | `./setup.sh` 需要；直接 `bash start.sh` 可不依赖 |
| Claude / Codex CLI | `claude --version` / `codex --version` | 如需在 Nexus 内启动对应 agent |

注意：

- 默认运行链仍然不依赖 Node/PM2。
- 仓库现在重新携带 `frontend/src/` 和 `frontend/package.json`，前端可以在本仓库内重新构建。
- 线上运行仍直接使用 `frontend/dist/`。
- 仓库级验证入口统一为 `npm run check`。
- 如果 Codex CLI 通过 NVM / Volta / npm 安装，Nexus 启动链会在运行时补齐对应 PATH；但前提是机器上真实 `codex` 二进制本来就存在。

## 第一步：克隆仓库

```bash
git clone https://github.com/Jiang0977/nexus.git
cd nexus
```

## 第二步：安装或直接启动

推荐方式：

```bash
cp .env.example .env
./setup.sh
```

`./setup.sh` 会做这些事：

1. 检查 tmux
2. 检查 `systemd --user`
3. 创建 `.env`
4. 校验 `frontend/dist/index.html`
5. 写入并启动 `nexus.service` / `nexus-tmux.service`
6. 确保 tmux `main` session 存在

如果你只想前台直接跑：

```bash
cp .env.example .env
bash start.sh
```

访问：

```text
http://localhost:59000
```

## 第三步：确认服务状态

如果使用 `./setup.sh`：

```bash
systemctl --user status nexus --no-pager
journalctl --user -u nexus -n 30 --no-pager
```

成功标准：

- `nexus` 为 `active (running)`
- 日志里出现 `启动 Nexus Rust server`
- 浏览器打开首页返回 `200`

## 第四步：最小配置

`.env.example` 已带默认值。复制后通常可以直接启动。

建议至少检查这些项：

| 配置项 | 说明 |
|---|---|
| `JWT_SECRET` | JWT 签名密钥 |
| `ACC_PASSWORD_HASH` | 登录密码的 bcrypt hash，默认密码是 `nexus123` |
| `WORKSPACE_ROOT` | Nexus 允许访问的目录根 |
| `PORT` | 默认 `59000` |
| `GITHUB_REPO` | 默认 `Jiang0977/nexus`，用于版本检查 |

如果只是本机试跑，可以先保留默认密码；正式使用前再换。

## 第五步：创建 Profile

Nexus 通过 `data/configs/*.json` 和 `data/codex-configs/*.json` 管理不同 agent profile。

Claude 示例：

```bash
mkdir -p data/configs
```

创建 `data/configs/anthropic.json`：

```json
{
  "label": "Anthropic Claude",
  "BASE_URL": "",
  "AUTH_TOKEN": "",
  "API_KEY": "",
  "DEFAULT_MODEL": "claude-sonnet-4-6",
  "THINK_MODEL": "claude-opus-4-6",
  "LONG_CONTEXT_MODEL": "claude-opus-4-6",
  "DEFAULT_HAIKU_MODEL": "claude-haiku-4-5-20251001",
  "API_TIMEOUT_MS": "3000000"
}
```

## 常见问题

### 1. `frontend/dist/index.html` 缺失

结论：仓库内容不完整。即使仓库里有前端源码，运行时仍要求 `frontend/dist/` 存在。

### 2. `systemctl --user` 不可用

可以先用：

```bash
bash start.sh
```

但 `./setup.sh` 和用户级守护启动会失败。需要先启用 `systemd --user`。

### 3. 改了 Rust 代码但服务没更新

`bash start.sh` 只会补构建“缺失”的 release binary，不会强制重建现有产物。代码变更后显式重建：

```bash
cargo build --manifest-path rust-runtime/Cargo.toml --release \
  --bin nexus-server \
  --bin nexus-task-runtime \
  --bin nexus-pty-runtime \
  --bin nexus-native-pty-supervisor \
  --bin nexus-native-session \
  --bin nexus-window-launch-runtime \
  --bin nexus-session-runtime
```

然后重启服务。

### 4. native 模式下从另一个终端进入会话

native 后端仍是 opt-in。启用后确认 supervisor 服务在运行：

```bash
systemctl --user status nexus-native-pty
```

另一个终端可以直接列出并进入 native 会话：

```bash
nexus-native-session list
nexus-native-session attach <project> <channel-index>
```

如果 shell 提示 `nexus-native-session: command not found`，先确认 `~/.local/bin` 在当前终端的 `PATH` 中，或临时使用完整路径 `rust-runtime/target/release/nexus-native-session`。

### 5. 如何改密码

把 `.env` 里的 `ACC_PASSWORD_HASH` 改成新的 bcrypt hash。仓库当前不内置密码生成工具，使用你现有的 bcrypt 工具生成即可。

### 6. 如何重建前端

如果你改了 `frontend/src/*`：

```bash
npm install
npm run build:frontend
```

构建会把新产物写回 `frontend/dist/`，Rust server 会继续直接伺服这个目录。

如果你想在本地一次性验证 Rust、Node 测试和 `frontend/dist` 漂移保护：

```bash
npm run check
```

### 7. Nexus 内 `codex` 提示 wrapper 找不到真实二进制

先检查宿主机上真实 CLI 是否存在：

```bash
codex --version
which -a codex
find "$HOME/.nvm/versions/node" -maxdepth 3 \( -type f -o -type l \) -path '*/bin/codex' 2>/dev/null
```

如果机器上本来就装了 Codex，再重启服务：

```bash
sudo systemctl restart nexus-tmux
sudo systemctl restart nexus
```

然后确认服务 PATH 已带上真实 CLI 目录：

```bash
server_pid="$(systemctl show -p MainPID --value nexus)"
tr '\0' '\n' < "/proc/${server_pid}/environ" | rg '^PATH='
```

## 下一步

- 架构和模块边界：见 [ARCHITECTURE.md](ARCHITECTURE.md)
- 上线、重启、回滚：见 [DEPLOYMENT-RUNBOOK.md](DEPLOYMENT-RUNBOOK.md)
