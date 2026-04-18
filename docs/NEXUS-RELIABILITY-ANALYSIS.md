# Nexus 高可用与 Claude Profile 启动流程分析（历史归档）

**原始分析日期**: 2026-04-02
**归档日期**: 2026-04-18
**原始分析对象**: 当时仍存在的旧 Node 运行时、PM2 托管链路，以及 Claude profile 环境注入路径

---

## Read This First

本文不是当前运行时手册。

它记录的是 2026-04-02 对旧部署形态做的一次 incident 分析。当前源码树的默认启动链已经切到 [`start.sh`](/home/jiang/workspace/typescript/nexus4cc/start.sh) -> Rust `nexus-server`，旧 Node 后端入口和相关业务服务源码已从当前分支删除。

因此，这份文档现在只保留两个用途：

- 给历史 incident 留背景
- 保留 `CLAUDE_CONFIG_DIR` 污染导致 profile 跑偏的根因分析

当前事实源见：

- [ARCHITECTURE.md](/home/jiang/workspace/typescript/nexus4cc/docs/ARCHITECTURE.md)
- [DEPLOYMENT-RUNBOOK.md](/home/jiang/workspace/typescript/nexus4cc/docs/DEPLOYMENT-RUNBOOK.md)
- [code.md](/home/jiang/workspace/typescript/nexus4cc/docs/code.md)

---

## 1. 历史结论摘要

截至 2026-04-02，当时的分析结论是：

1. `nexus` 服务重启次数异常高，进程监管层配置偏弱，而且旧运行时入口缺少全局异常与端口占用护栏。
2. nexus 目录下启动 `"anthropic"` profile 实际跑成 kimi 的根因，不在前端选项，而在 `CLAUDE_CONFIG_DIR`、凭证文件和 profile JSON 三者组合出的环境污染。
3. 当时同时存在三条不同的 Claude 启动路径，脚本、环境和凭证来源并不一致，这让排障成本非常高。

---

## 2. 历史启动链脆弱点

2026-04-02 当时观察到的链路是：

```text
systemd (pm2-<user>.service)
  -> PM2 daemon
    -> 旧 nexus 后端进程
      -> tmux server
        -> tmux windows (zsh / claude)
```

当时识别出的脆弱点：

- `systemd` 没有稳定托管 PM2，WSL2 会话结束后服务不一定自动恢复。
- PM2 配置缺少 `max_restarts`、`min_uptime`、`max_memory_restart`、`kill_timeout` 之类的基本护栏。
- 旧后端入口自身缺少全局异常处理和 listen error 处理。
- `ttyd` 备用入口虽然能救火，但它和主服务是两条完全独立的生命线，会进一步放大“到底哪条路径在生效”的排障复杂度。

这些判断解释了当时为什么先做“旧后端清边界”，但它们已经不是当前 Rust 运行时的现状描述。

---

## 3. 仍然有价值的根因：Anthropic Profile 为什么会跑偏

这部分历史分析今天仍有参考价值，因为问题根因不依赖旧 Node 入口本身，而依赖 shell / profile / 凭证链路。

### 3.1 污染链路

当时的核心问题是：

```text
交互式 shell
  -> 启动 nexus
    -> 启动 tmux window
      -> claude CLI 继承了 CLAUDE_CONFIG_DIR=/mnt/c/Users/libra/work/nexus/.claude-data
```

一旦 `CLAUDE_CONFIG_DIR` 被这样带进来，Claude CLI 会强制把 nexus 本地目录当配置根。

### 3.2 凭证断层

当时确认到：

- `~/.claude/` 下存在可用的 Anthropic 登录凭证
- `nexus/.claude-data/` 下缺少对应凭证文件
- `data/configs/anthropic.json` 里的 `API_KEY` 和 `AUTH_TOKEN` 为空

结果就是：

- CLI 读不到官方 API 凭证
- CLI 读不到由环境变量补上的 Anthropic 凭证
- 最后只能回退或复用本地历史里残留的 kimi 配置

### 3.3 这个结论今天怎么用

即使后端入口已经 Rust 化，下面几件事依然值得继续检查：

- 启动脚本或 supervisor 环境里是否还会注入 `CLAUDE_CONFIG_DIR`
- `nexus-run-claude.sh`、profile JSON 和全局凭证目录是否仍然指向同一套真实凭证
- 是否还保留多条彼此不一致的 Claude 启动路径

---

## 4. 历史建议与当前状态

| 2026-04-02 的建议 | 当前状态 |
|------------------|----------|
| 加强 PM2 配置 | 仍然是有效的运维原则，但对象应是当前 Rust 启动链，而不是已删除的旧入口 |
| 给旧入口补全局异常捕获和 listen error handler | 已被 Rust runtime cutover 超越，不应再回头给旧 Node 入口补丁 |
| 确保 systemd 真正托管 supervisor | 仍然有效，但应按当前 [DEPLOYMENT-RUNBOOK.md](/home/jiang/workspace/typescript/nexus4cc/docs/DEPLOYMENT-RUNBOOK.md) 执行 |
| 处理 `CLAUDE_CONFIG_DIR` 污染 | 仍然有效，而且和 Rust cutover 无关，继续是 profile 跑偏排查重点 |

---

## 5. 现阶段该怎么读这份文档

正确读法：

- 把它当成“旧部署形态为什么不稳、profile 为什么会跑偏”的历史归档
- 复用其中关于 supervisor、环境继承和凭证链路的排障思路

错误读法：

- 把它当成当前源码仍在使用的运行时说明
- 按这份文档去恢复旧 Node 入口或旧 supervisor script

如果需要当前架构、启动链或部署步骤，请直接看 [ARCHITECTURE.md](/home/jiang/workspace/typescript/nexus4cc/docs/ARCHITECTURE.md) 和 [DEPLOYMENT-RUNBOOK.md](/home/jiang/workspace/typescript/nexus4cc/docs/DEPLOYMENT-RUNBOOK.md)。
