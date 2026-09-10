# Codex Profile Skills Smoke

> Historical environment-specific evidence. Personal paths, project names and addresses have been anonymized; examples are not executable deployment targets.

日期：2026-05-11

## 背景

用户反馈：部署并重启 `nexus.service` 后，指定 Codex profile 新开 channel，Codex 里看不到 skills。

## 根因

- Codex profile channel 使用 `data/codex-runtime/<window>` 作为隔离 HOME。
- 隔离 HOME 需要把真实 `~/.codex/skills` 链接到 `data/codex-runtime/<window>/.codex/skills`。
- `nexus.service` 重启不会重启 `nexus-tmux.service`，旧 Codex channel 继续运行，旧 runtime HOME 不会自动重建。
- 部署脚本之前没有把 `nexus-codex-home` 纳入 release binary 构建集合，导致 Codex HOME 物化逻辑可能不是当前源码对应版本。

## 修复

- `scripts/deploy-nexus-service.sh` 构建并备份/回滚 `nexus-codex-home`。
- `start.sh` 在缺失或过期时构建 `nexus-codex-home`。
- `nexus-run-codex.sh` 启动 Codex 前自愈 `.codex/skills` symlink。
- 现有 `data/codex-runtime/*/.codex` 中缺失的 `skills` 已补链到 `/home/demo/.codex/skills`。

## 验证

```bash
node --test tests/serverRuntimeEntry.test.js tests/codexProfileLauncher.test.js
npm run deploy:service
curl -I --max-time 5 http://127.0.0.1:59000
find data/codex-runtime -maxdepth 3 -type l -path '*/.codex/skills' -printf '%p -> %l\n'
```

结果：

- 相关 Node 测试通过。
- `nexus.service` 重启后 `active (running)`。
- 首页返回 `200 OK`。
- runtime `.codex/skills` 链接到 `/home/demo/.codex/skills`。

## 经验

- 部署脚本的“release binaries”必须覆盖所有运行时真实会调用的 binary，不只 server 和显式 child runtime。
- `nexus.service` 与 `nexus-tmux.service` 生命周期不同；重启 web/server 不等于刷新已有 tmux/Codex 进程。
- profile 隔离 HOME 不能只验证 auth/config，还要验证共享能力目录，例如 `skills`。
