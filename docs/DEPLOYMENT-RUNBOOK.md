# Nexus 部署与更新 Runbook

最后验证日期：2026-04-19

目标：线上更新时只按这份文档执行。不要再走 `npm`、`pm2`、前端现场构建这类旧路径。

## 当前部署形态

- 服务管理：`systemd`
- 默认启动链：`bash start.sh -> rust-runtime/target/release/nexus-server`
- 静态资源：仓库内 vendored `frontend/dist/`
- tmux 守护：`nexus-tmux.service`
- 默认端口：`59000`

关键事实：

- 仓库已移除 Node/npm/PM2。
- `start.sh` 只会补构建缺失的 Rust release binary。
- `start.sh` 不会重建已有 release binary。
- `start.sh` 会在 `frontend/dist/index.html` 缺失时直接失败。
- 所以发布前必须显式重建 Rust release binary，并确认 `frontend/dist/` 仍存在。

## 标准上线步骤

### 1. 部署前检查

```bash
git status --short
test -f frontend/dist/index.html
cargo fmt --manifest-path rust-runtime/Cargo.toml --check
cargo test --manifest-path rust-runtime/Cargo.toml
cargo build --manifest-path rust-runtime/Cargo.toml --release --bin nexus-server --bin nexus-task-runtime --bin nexus-pty-runtime --bin nexus-window-launch-runtime --bin nexus-session-runtime
```

如果 `test -f frontend/dist/index.html` 失败，不要继续上线。

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

用户级安装：

```bash
systemctl --user restart nexus
systemctl --user status nexus --no-pager
```

系统级安装：

```bash
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

原因：你没重建 Rust release binary，只是重启了服务。

### 2. 首页 404

原因：`frontend/dist/` 缺失或仓库不完整。当前仓库没有 Node 前端源码和构建链，不能现场 `npm run build` 修。

### 3. `systemctl --user` 不可用

说明：当前机器没有用户级 systemd。可以临时 `bash start.sh` 前台运行，但这不等于正式部署。

## 交付约束

- 任何代码部署后都必须重启 `nexus` 服务。
- 重启后必须验证服务可达。
- 如果重启后服务不可达，立即回滚到上一个稳定版本。
