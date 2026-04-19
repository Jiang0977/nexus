# Nexus 部署与更新 Runbook

最后验证日期：2026-04-18

目标：以后更新线上时，直接按这份文档执行，不再临时查资料和试错。

## 当前线上形态

- 服务管理：`systemd`
- 主服务：`nexus.service`
- tmux 服务：`nexus-tmux.service`
- 工作目录：`/home/demo/workspace/rust/nexus`
- 启动链路：`nexus.service -> bash start.sh -> rust-runtime/target/release/nexus-server`
- 对外端口：`59000`

关键事实：

- `start.sh` 只会在 `frontend/dist` 不存在时才构建前端。
- `start.sh` 只会在缺少 release binaries 时才补构建 Rust server / runtimes。
- 也就是说，前端源码改了以后，部署前必须手动执行 `npm --prefix frontend run build`。
- Rust 后端源码改了以后，部署前必须手动执行：
  - `npm run build:rust-runtimes`
  - `npm run build:rust-server`
- Rust 后端改动只有在重新构建 release binaries 并重启 `nexus.service` 后才会生效。
- 当前环境里直接执行 `systemctl restart nexus` 会要求交互鉴权，自动化场景不可用。
- `nexus.service` 配置了 `Restart=on-failure`，因此可以通过杀掉主进程触发 systemd 自动拉起新版本。

## 标准上线步骤

### 1. 部署前检查

```bash
git status --short
npm run build:rust-runtimes
npm run build:rust-server
npm --prefix frontend run build
```

如果这次改动涉及启动链路、配置解析或 shell 规划，再补跑相关测试，例如：

```bash
cargo fmt --manifest-path rust-runtime/Cargo.toml --check
cargo test --manifest-path rust-runtime/Cargo.toml
node --test tests/*.test.js
```

### 2. 可选预演

当改动碰到启动链路、认证、配置导入时，先在备用端口预演一次：

```bash
PORT=59001 bash start.sh
```

另开一个终端探活：

```bash
curl -I --max-time 5 http://127.0.0.1:59001
curl --silent --show-error --max-time 5 http://127.0.0.1:59001 | head -n 5
```

看到 `HTTP/1.1 200 OK` 且日志里出现 `nexus-server listening on 127.0.0.1:59001` 再继续。预演结束后记得 `Ctrl+C` 退出。

如果你要在同一份代码上起一个真正独立的预演实例，别共用默认 `data/`，而是显式指定独立数据目录，例如：

```bash
PORT=59001 NEXUS_DATA_DIR=/tmp/nexus-preview-data bash start.sh
```

否则两个实例会共享 `tasks.json`、profiles、toolbar config、uploads 等状态。

### 3. 准备回滚基线

推荐做法：

- 最好先把待部署版本提交到明确的 Git commit，再上线。
- 如果和这次一样是 dirty worktree 部署，必须先备份当前 diff。

备份命令：

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

### 4. 重启正式服务

当前环境的标准无交互重启方式：

```bash
MAIN_PID="$(systemctl show -p MainPID --value nexus)"
kill -9 "$MAIN_PID"
sleep 6
```

说明：

- 不要先杀 `nexus-tmux.service`，正常更新不需要动 tmux。
- `kill -9` 后，systemd 会因为 `Restart=on-failure` 自动重启 `nexus.service`。
- `RestartSec` 当前是 `5s`，所以至少等 6 秒再做验证。

### 5. 上线后验证

```bash
systemctl status nexus --no-pager
journalctl -u nexus -n 30 --no-pager
curl -I --max-time 5 http://127.0.0.1:59000
curl --silent --show-error --max-time 5 http://127.0.0.1:59000 | head -n 5
```

通过标准：

- `systemctl status nexus` 显示 `active (running)`
- 日志里出现：
  - `启动 Nexus Rust server on :59000 ...`
  - `nexus-server listening on 127.0.0.1:59000`
- HTTP 返回 `200 OK`

## 标准回滚步骤

触发条件：

- 服务重启后 `nexus.service` 不是 `active (running)`
- 或首页 `http://127.0.0.1:59000` 无法返回 `200`

### 推荐回滚

如果这次部署前已经有 commit，直接回到上一个稳定 commit，重新构建并再次按本文重启：

```bash
git checkout <last-known-good-commit>
npm run build:rust-runtimes
npm run build:rust-server
npm --prefix frontend run build
MAIN_PID="$(systemctl show -p MainPID --value nexus)"
kill -9 "$MAIN_PID"
sleep 6
```

### dirty worktree 回滚

如果是未提交改动直接上线，先保留备份，再回到 `HEAD`：

```bash
git restore .
git clean -fd
npm run build:rust-runtimes
npm run build:rust-server
npm --prefix frontend run build
MAIN_PID="$(systemctl show -p MainPID --value nexus)"
kill -9 "$MAIN_PID"
sleep 6
```

警告：

- 这会清掉工作树未提交改动，所以 dirty worktree 上线前一定要先做第 3 步备份。
- 回滚成功后，如需恢复未上线改动，再从 `/tmp/nexus-deploy-backups/<timestamp>/` 里的 patch 和 tar 包恢复。

## 这次验证过的真实问题

### 问题 1：`systemctl restart nexus` 需要交互鉴权

现象：

```text
Failed to restart nexus.service: Interactive authentication required.
```

结论：

- 不能把 `systemctl restart nexus` 当作默认自动化命令。
- 统一改用 `kill -9 $(systemctl show -p MainPID --value nexus)` 触发 systemd 自动重启。

### 问题 2：前后端构建产物不会在重启时自动刷新

原因：

- `start.sh` 只在 `frontend/dist` 不存在时执行前端构建。
- `start.sh` 只在缺少 Rust release binaries 时执行后端构建。

结论：

- 任何前端源码变更上线前，必须手动运行：

```bash
npm --prefix frontend run build
```

- 任何后端源码变更上线前，必须手动运行：

```bash
npm run build:rust-runtimes
npm run build:rust-server
```

### 问题 3：`node:sqlite` 会打印 experimental warning

现象：

- 启动日志会出现 `SQLite is an experimental feature`。

结论：

- 当前不是阻塞项。
- 只要服务能正常监听且测试覆盖相关解析路径，就允许上线。

## 本次上线记录

- 预演端口：`59001`
- 预演结果：`200 OK`
- 正式服务重启方式：杀主进程，等待 systemd 自动拉起
- 正式服务新 PID：`2888210`
- 正式服务验证：`systemctl active` + `curl 59000` 均通过
- 备份目录：`.context/deploy-backups/20260413-232524`
