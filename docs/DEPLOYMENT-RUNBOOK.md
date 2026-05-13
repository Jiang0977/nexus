# Nexus 部署与更新 Runbook

最后验证日期：2026-05-11

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
- Codex profile channel 依赖 `rust-runtime/target/release/nexus-codex-home` 物化隔离 HOME；它和 server/runtime binaries 一样属于部署必构建产物。
- 所以发布前仍建议显式重建 Rust release binary，并确认 `frontend/dist/` 仍存在。

## 标准上线步骤

### 1. 部署前检查

```bash
git status --short
test -f frontend/dist/index.html
npm run check
cargo fmt --manifest-path rust-runtime/Cargo.toml --check
cargo build --manifest-path rust-runtime/Cargo.toml --release --bin nexus-server --bin nexus-task-runtime --bin nexus-pty-runtime --bin nexus-window-launch-runtime --bin nexus-session-runtime --bin nexus-codex-home
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

### 4. 一键部署

如果前端源码没改，优先直接运行：

```bash
npm run deploy:service
```

如果这次改了 `frontend/src/`，先重建前端再部署：

```bash
npm run deploy:service -- --frontend
```

行为：

- 先备份当前 Rust release binaries 到 `/tmp/nexus-deploy-backup.*`
- 重新构建 `nexus-server`、4 个 runtime binary 与 `nexus-codex-home`
- 调用 `npm run restart:service`
- 如果重启或探活失败，自动恢复旧 release binaries 并再次重启服务

注意：

- 这个脚本只自动回滚 Rust release binaries，不会自动回滚工作树里的 shell 脚本或文档改动。
- 如果脚本最终失败但服务已被回滚拉起，修复问题后再重新部署。

### 5. 手动重启服务

优先用你实际安装方式对应的命令：

当前这台机器如果已经具备免交互 sudo，优先直接跑仓库脚本：

```bash
npm run restart:service
```

它会执行 `sudo -n systemctl restart nexus`，随后检查 `systemctl status` 和 `http://127.0.0.1:59000/api/version`。

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

### 6. 上线后验证

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

补充说明：

- 活跃的 `tmux attach-session` client 仍可能出现在 `nexus.service` cgroup 下；这代表浏览器终端前台连接，而不是 tmux server 漂移。
- 2026-04-21 的真实重启验证表明，这类 attach client 会在 `nexus.service` 重启后被新进程重建，不再触发新的 `left-over process` 启动告警。
- 关闭证据见 [systemd-residue-smoke-2026-04-21.md](verification/systemd-residue-smoke-2026-04-21.md)。

如果本次改动涉及 Codex 启动链，再额外验证：

```bash
server_pid="$(systemctl show -p MainPID --value nexus)"
tmux_pid="$(systemctl show -p MainPID --value nexus-tmux)"
tr '\0' '\n' < "/proc/${server_pid}/environ" | rg '^PATH='
tr '\0' '\n' < "/proc/${tmux_pid}/environ" | rg '^PATH='
tmux show-environment -g PATH
test -x rust-runtime/target/release/nexus-codex-home
```

通过标准：

- `PATH` 以 `~/.local/bin` 开头，保证 Nexus 终端里手动输入 `codex` 时先命中 wrapper
- `PATH` 同时含真实 Codex CLI 所在目录，例如 `~/.nvm/versions/node/<version>/bin`
- `nexus-codex-home` 是本次源码对应的新 release binary
- 新建指定 Codex profile 的 channel 后，`data/codex-runtime/<window>/.codex/skills` 应该链接到真实用户的 `~/.codex/skills`

## 回滚

触发条件：

- 服务重启后不可达
- `systemctl` 状态不是 `active (running)`
- 首页探活失败

推荐回滚：

```bash
git checkout <last-known-good-commit>
cargo build --manifest-path rust-runtime/Cargo.toml --release --bin nexus-server --bin nexus-task-runtime --bin nexus-pty-runtime --bin nexus-window-launch-runtime --bin nexus-session-runtime --bin nexus-codex-home
systemctl --user restart nexus
```

如果你用的是系统级服务，把最后一行换成 `sudo systemctl restart nexus`。

dirty worktree 回滚：

```bash
git restore .
git clean -fd
cargo build --manifest-path rust-runtime/Cargo.toml --release --bin nexus-server --bin nexus-task-runtime --bin nexus-pty-runtime --bin nexus-window-launch-runtime --bin nexus-session-runtime --bin nexus-codex-home
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

### 4. native 模式另一个终端无法进入会话

先确认 native supervisor 服务和 socket：

```bash
systemctl --user status nexus-native-pty
test -S data/native-sessions/supervisor.sock
```

列出 native project/channel：

```bash
nexus-native-session list
```

进入指定 channel：

```bash
nexus-native-session attach <project> <channel-index>
```

如果 `nexus-native-session` 不在 `PATH`，重新跑部署脚本或确认 `~/.local/bin/nexus-native-session` 存在；也可以临时使用完整路径 `rust-runtime/target/release/nexus-native-session`。

如果 `attach` 报 supervisor 连接失败，先看 backend 是否已经切到 native，并重启服务：

```bash
cat data/session-backend.json
systemctl --user restart nexus-native-pty
systemctl --user restart nexus
```

如果使用了 `NEXUS_DATA_DIR`，socket 和 `session-backend.json` 都在该数据目录下。

### 5. 指定 Codex profile 新开 channel 后没有 skills

原因：

- `nexus.service` 重启不会重启持久的 `nexus-tmux.service`，已有 Codex channel 仍在旧 runtime HOME 中运行。
- Codex profile channel 使用 `data/codex-runtime/<window>` 作为隔离 HOME；`~/.codex/skills` 必须被链接进 runtime 的 `.codex/skills`。
- 如果部署漏构建 `nexus-codex-home`，或旧 runtime HOME 没有自愈链接，就会出现 Codex 看不到 skills。

排查：

```bash
find data/codex-runtime -maxdepth 3 -type l -path '*/.codex/skills' -printf '%p -> %l\n'
test -d "$HOME/.codex/skills"
test -x rust-runtime/target/release/nexus-codex-home
```

修复：

- 当前 `nexus-run-codex.sh` 会在 Codex 启动前自愈缺失或错误的 `.codex/skills` symlink。
- 已打开的 Codex 进程可能缓存了启动时的 skills 列表；在 channel 中退出 Codex 后按 `r` 重启，或新开 Codex profile channel。
- 不要为了这个问题直接重启 `nexus-tmux.service`，除非你明确接受所有 tmux 会话被影响。

### 6. 重启时报 `Address already in use`

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

### 7. `systemctl --user` 不可用

说明：当前机器没有用户级 systemd。可以临时 `bash start.sh` 前台运行，但这不等于正式部署。

### 8. Nexus 内 `codex` 报 `real codex binary not found in PATH`

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
