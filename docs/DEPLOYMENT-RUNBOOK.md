# Nexus 部署与更新 Runbook

最后验证日期：2026-04-20

目标：线上更新时只按这份文档执行。不要再走 `npm`、`pm2`、前端现场构建这类旧路径。

## 当前部署形态

- 服务管理：`systemd`
- 默认启动链：`bash start.sh -> rust-runtime/target/release/nexus-server`
- 静态资源：仓库内 vendored `frontend/dist/`
- tmux 守护：`nexus-tmux.service`
- 默认端口：`59000`

关键事实：

- 默认运行链不依赖 Node/npm/PM2，但仓库重新携带了 `frontend/src/` 与 `frontend/package.json`。
- `start.sh` 会在默认 release binary 缺失或其真实依赖更新时重建对应 Rust binary。
- `start.sh` 会优先使用 `PATH` 里的 `cargo`；如果 systemd 环境没带上 `cargo`，会回退到 `$HOME/.cargo/bin/cargo`。
- `start.sh` 和 `scripts/nexus-tmux-service.sh` 会在启动早期尝试修正 Codex CLI 路径：如果当前 `codex --version` 失败，但真实 CLI 存在于 `NEXUS_CODEX_EXECUTABLE`、Volta、npm 或 NVM 目录，会把对应 bin 目录前置到 `PATH`。
- `start.sh` 会在 `frontend/dist/index.html` 缺失时直接失败。
- 如果这次改动触及 `frontend/src/`，发布前还要先在 `frontend/` 下执行前端构建，确保新的 `frontend/dist/` 已产出。
- 所以发布前仍建议显式重建 Rust release binary，并确认 `frontend/dist/` 仍存在。

## 标准上线步骤

### 1. 部署前检查

```bash
git status --short
test -f frontend/dist/index.html
npm run check
cargo fmt --manifest-path rust-runtime/Cargo.toml --check
cargo build --manifest-path rust-runtime/Cargo.toml --release --bin nexus-server --bin nexus-task-runtime --bin nexus-pty-runtime --bin nexus-window-launch-runtime --bin nexus-session-runtime
```

如果本次改了前端源码，再额外执行：

```bash
npm --prefix frontend install
npm --prefix frontend run build
```

如果 `test -f frontend/dist/index.html` 失败，不要继续上线。

说明：

- `npm run check` 是当前本地与 CI 共用的验证入口。
- 它会串行执行 Rust 测试、Node 测试、前端构建，以及 `frontend/dist` 无漂移校验。

### 2. 可选预演

```bash
PORT=59001 bash start.sh
```

另开一个终端验证：

```bash
curl -I --max-time 5 http://127.0.0.1:59001
curl --silent --show-error --max-time 5 http://127.0.0.1:59001 | head -n 5
```

看到 `HTTP/1.1 200 OK` 再继续。结束预演后 `Ctrl+C` 退出。

### 3. 准备回滚基线

推荐先有明确 commit；如果是 dirty worktree，先备份：

```bash
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="/tmp/nexus-deploy-backups/$TS"
mkdir -p "$BACKUP_DIR"
git diff --binary HEAD > "$BACKUP_DIR/tracked.patch"
git diff --name-only HEAD > "$BACKUP_DIR/tracked-files.txt"
git ls-files --others --exclude-standard > "$BACKUP_DIR/untracked-files.txt"
if [ -s "$BACKUP_DIR/untracked-files.txt" ]; then
  tar -czf "$BACKUP_DIR/untracked-files.tar.gz" -T "$BACKUP_DIR/untracked-files.txt"
fi
echo "$BACKUP_DIR"
```

### 4. 重启服务

优先用你实际安装方式对应的命令：

如果这次部署改了 `deploy/systemd/*.service`，先把 unit 文件同步到 systemd 并 reload：

系统级安装：

```bash
sudo cp deploy/systemd/nexus.service /etc/systemd/system/nexus.service
sudo cp deploy/systemd/nexus-tmux.service /etc/systemd/system/nexus-tmux.service
sudo systemctl daemon-reload
```

用户级安装：

```bash
systemctl --user restart nexus
systemctl --user status nexus --no-pager
```

系统级安装：

```bash
sudo systemctl restart nexus-tmux
sudo systemctl restart nexus
sudo systemctl status nexus --no-pager
```

### 5. 上线后验证

用户级：

```bash
systemctl --user status nexus --no-pager
journalctl --user -u nexus -n 30 --no-pager
curl -I --max-time 5 http://127.0.0.1:59000
curl --silent --show-error --max-time 5 http://127.0.0.1:59000 | head -n 5
```

系统级把上面命令替换为 `sudo systemctl` / `sudo journalctl`。

通过标准：

- 服务状态 `active (running)`
- 日志里出现 `启动 Nexus Rust server on :59000`
- 首页返回 `200 OK`
- `nexus-tmux.service` 处于 `active (running)`，并且 `tmux -D` 归属在 `nexus-tmux.service`，不是 `nexus.service`

如果本次改动涉及 Codex 启动链，再额外验证：

```bash
server_pid="$(systemctl show -p MainPID --value nexus)"
tmux_pid="$(systemctl show -p MainPID --value nexus-tmux)"
tr '\0' '\n' < "/proc/${server_pid}/environ" | rg '^PATH='
tr '\0' '\n' < "/proc/${tmux_pid}/environ" | rg '^PATH='
tmux show-environment -g PATH
```

通过标准：

- `PATH` 以 `~/.local/bin` 开头，保证 Nexus 终端里手动输入 `codex` 时先命中 wrapper
- `PATH` 同时含真实 Codex CLI 所在目录，例如 `~/.nvm/versions/node/<version>/bin`

## 回滚

触发条件：

- 服务重启后不可达
- `systemctl` 状态不是 `active (running)`
- 首页探活失败

推荐回滚：

```bash
git checkout <last-known-good-commit>
cargo build --manifest-path rust-runtime/Cargo.toml --release --bin nexus-server --bin nexus-task-runtime --bin nexus-pty-runtime --bin nexus-window-launch-runtime --bin nexus-session-runtime
systemctl --user restart nexus
```

如果你用的是系统级服务，把最后一行换成 `sudo systemctl restart nexus`。

dirty worktree 回滚：

```bash
git restore .
git clean -fd
cargo build --manifest-path rust-runtime/Cargo.toml --release --bin nexus-server --bin nexus-task-runtime --bin nexus-pty-runtime --bin nexus-window-launch-runtime --bin nexus-session-runtime
systemctl --user restart nexus
```

警告：

- 这会清掉未提交改动。
- 先确保第 3 步的备份已经完成。

## 常见坑

### 1. 重启后还是旧代码

原因：你没重建 Rust release binary，且 `start.sh` 也没检测到真实依赖变化。

### 2. `cargo: command not found`

原因：当前机器既没有把 cargo 放进 `PATH`，也没有可执行的 `$HOME/.cargo/bin/cargo`。

处理：

```bash
command -v cargo
test -x "$HOME/.cargo/bin/cargo"
```

至少满足一个，再重启服务。

### 3. 首页 404

原因：`frontend/dist/` 缺失或仓库不完整。当前运行时仍只认 `frontend/dist/`；如果仓库完整，可以在 `frontend/` 下重新构建后再重启。

### 4. 重启时报 `Address already in use`

原因：历史上旧 unit 可能留下孤儿 `nexus-server` 进程，占住 `127.0.0.1:59000`。

处理：

```bash
sudo systemctl stop nexus
ss -ltnp '( sport = :59000 )'
ps -eo pid,ppid,unit,args | rg 'nexus-server|nexus-(task|pty|window|session)'
kill <stale-nexus-server-pid>
sudo systemctl start nexus
```

如果新的 unit 已部署正确，清掉这次残留后，后续重启不应再复发。

### 5. `systemctl --user` 不可用

说明：当前机器没有用户级 systemd。可以临时 `bash start.sh` 前台运行，但这不等于正式部署。

### 6. Nexus 内 `codex` 报 `real codex binary not found in PATH`

原因：服务或 tmux 的 `PATH` 里只有 wrapper，没带上真实 Codex CLI 所在目录。

处理：

```bash
codex --version
server_pid="$(systemctl show -p MainPID --value nexus)"
tmux_pid="$(systemctl show -p MainPID --value nexus-tmux)"
tr '\0' '\n' < "/proc/${server_pid}/environ" | rg '^PATH='
tr '\0' '\n' < "/proc/${tmux_pid}/environ" | rg '^PATH='
sudo systemctl restart nexus-tmux
sudo systemctl restart nexus
```

如果重启后仍失败，检查真实 CLI 是否存在于以下任一路径：

- `NEXUS_CODEX_EXECUTABLE`
- `~/.volta/bin/codex`
- `~/.npm/bin/codex`
- `~/.nvm/versions/node/*/bin/codex`

## 交付约束

- 任何代码部署后都必须重启 `nexus` 服务。
- 重启后必须验证服务可达。
- 如果重启后服务不可达，立即回滚到上一个稳定版本。
