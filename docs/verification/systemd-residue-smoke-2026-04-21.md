# Systemd Residue Smoke

日期：2026-04-21

## Goal

验证 `nexus.service` / `nexus-tmux.service` 当前 systemd 拆分是否已经收口历史上的 `left-over process` 启动告警，同时确认 tmux 持久化语义没有回归。

## Baseline

- `nexus.service`
  - `KillMode=control-group`
  - 通过 drop-in `10-tmux.conf` 依赖 `nexus-tmux.service`
- `nexus-tmux.service`
  - `Type=simple`
  - `ExecStart=/usr/bin/bash .../scripts/nexus-tmux-service.sh start-foreground`
  - 主进程是 `tmux -D`
- 当前真实运行态里，`nexus-pty-runtime` 仍会在 `nexus.service` 下启动 `tmux attach-session -t <session>:<window>`

这意味着：

- `tmux attach-session` client 继续挂在 `nexus.service` cgroup 下是当前实现事实
- 但真正需要收口的是：
  - 重启时不再出现成串 `Found left-over process ... while starting unit`
  - `nexus-tmux.service` 持有的 tmux server / window 状态不被 `nexus.service` 重启破坏

## Evidence

### 1. 历史告警来源

`journalctl` 里的旧告警主要集中在 2026-04-19 ~ 2026-04-20，内容包括：

- `tmux: server`
- `chrome-devtools`
- `zsh`
- `node`
- `codex`
- 早期 `nexus-*` runtime

这批告警对应的是旧部署形态下 `nexus.service` control group 里混入大量非 server 进程。

### 2. 当前运行态

当前可稳定观察到：

- `nexus-tmux.service` 持有真正的 `tmux -D` server
- `nexus.service` 持有：
  - `nexus-server`
  - `nexus-task-runtime`
  - `nexus-pty-runtime`
  - `nexus-window-launch-runtime`
  - `nexus-session-runtime`
  - 活跃的 `tmux attach-session` client

### 3. 带活跃 attach client 的重启验证

重启前：

- `nexus-tmux.service` MainPID = `2708`
- `tmux` window 列表：
  - `1:shell:0`
  - `2:codex-history:1`
- 活跃 attach client PID = `18882`

执行：

```bash
sudo systemctl restart nexus
```

重启后：

- `nexus-tmux.service` MainPID 仍然是 `2708`
- `tmux` window 列表保持不变：
  - `1:shell:0`
  - `2:codex-history:1`
- 活跃 attach client PID 从 `18882` 变为新进程 `20747`
- `journalctl -u nexus --since '1 minute ago'` 未出现新的 `left-over process`
- `curl -I http://127.0.0.1:59000` 返回 `HTTP/1.1 200 OK`

## Conclusion

结论：这项运维债可以关闭。

原因：

- 当前 systemd 拆分已经把真正需要持久化的 tmux server 固定在 `nexus-tmux.service`
- `nexus.service` 重启时，活跃 `attach-session` client 会被销毁后重建，不再导致新的 `left-over process` 启动告警
- tmux server PID 和 window 状态在重启前后保持稳定，说明持久化语义未回归

## Important Clarification

`tmux attach-session` client 仍然出现在 `nexus.service` cgroup 下，这本身不再算 open issue。

它现在代表的是：

- 浏览器终端连接的前台 attach client 属于 `nexus.service` 生命周期
- 持久化 server 属于 `nexus-tmux.service` 生命周期

只要重启时：

- 不再打新的 `left-over process`
- tmux server / windows 不丢
- 服务可达

就视为当前实现满足运维边界。
