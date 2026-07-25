# Session Backend Contract

最后更新：2026-07-25

## 范围

本文冻结 Nexus session backend 的产品 contract。它不是 tmux 命令清单，也不是 native backend 的内部设计。

当前状态：

- `tmux` 仍是默认稳定 backend。
- `native` backend 已有 opt-in/staging 实现，必须继续满足本文的公开产品 contract。
- 前端和公开 HTTP/WS 协议不应感知 backend 类型。

当前 `nexus-session-runtime` 已按 catalog、lifecycle、cleanup 三类 capability port 装配 tmux/native adapter；后续改动应同时保护默认 tmux 行为和 opt-in native 行为。

## 非目标

- 不定义完整 tmux 兼容层。
- 不要求把 backend selector 暴露进公开 HTTP/WS 协议；Phase 2 的 opt-in native host 可以使用 `NEXUS_SESSION_BACKEND`，但不能改变本文冻结的默认 tmux contract。
- 不改变默认 backend。
- 不要求 native backend 导入外部 tmux session。
- 不要求 scrollback 精确模拟 tmux pane 历史；只冻结 Nexus 当前 snapshot/reconnect 语义。

## 公共协议

### WebSocket attach

入口保持：

```text
/ws?session=<project-name>&window=<channel-index>
```

字段语义：

| 字段 | 语义 |
|---|---|
| `session` | Nexus project 名；默认 tmux backend 下等价 tmux session 名 |
| `window` | Nexus channel index；默认 tmux backend 下等价 tmux window index |

连接成功后，PTY runtime 负责：

- attach 到指定 project/channel；
- 转发终端 output；
- 接收 input；
- 接收 resize；
- close 时不删除底层 project/channel。

### Session management stdio runtime

`nexus-session-runtime` 的 request/response envelope 保持：

```json
{"kind":"request","id":"...","method":"...","params":{}}
{"kind":"response","id":"...","ok":true,"result":{}}
{"kind":"response","id":"...","ok":false,"error":{"message":"..."}}
```

`ready` / `runtimeStatus` 必须返回：

```json
{
  "ready": true,
  "source": "nexus-session-runtime",
  "version": "<cargo package version>",
  "capabilities": {
    "sessions": true,
    "admin": true
  },
  "projectsCreated": 0,
  "windowsCreated": 0
}
```

## Project Contract

### `listProjects`

返回数组字段：

| 字段 | 类型 | 语义 |
|---|---:|---|
| `name` | string | project 名 |
| `path` | string | project cwd；优先 `NEXUS_CWD`，再 pane cwd，再 `WORKSPACE_ROOT` |
| `active` | boolean | 是否为当前 `TMUX_SESSION` |
| `channelCount` | number | channel/window 数量 |

不变量：

- 隐藏内部 `nexus-pty-*` session。
- 默认 tmux backend discovery 失败时，回退到当前 `TMUX_SESSION` 和 `WORKSPACE_ROOT`。
- 保持当前 UI 依赖的 reverse ordering。

### `listAllSessionNames`

返回 backend 暴露的所有 session/project 名，不做 project 级过滤。默认 tmux backend 下是 tmux session 名；当前用于需要完整 session name 集合的 server-side 路径。

## Channel Contract

### `listProjectChannels`

参数：

```json
{"projectName":"demo-project"}
```

返回：

```json
{
  "project": "demo-project",
  "channels": [
    {"index":2,"name":"review","active":false,"cwd":"/workspace/demo"}
  ]
}
```

不变量：

- `index` 保持 numeric window index。
- `active` 来自 backend 的 active channel 状态。
- `cwd` 是 channel 当前 cwd。
- 保持当前 reverse ordering。

### `listSessionWindows`

返回 legacy session/window 列表：

```json
{
  "session": "demo-project",
  "windows": [
    {"index":0,"name":"shell","active":true}
  ]
}
```

## Lifecycle Contract

### Create

`createProject` 必须：

- 创建 project 和初始 channel；
- 设置 project cwd；
- 应用 proxy env；
- 标记当前 Nexus instance ownership；
- 增加 `projectsCreated` 和 `windowsCreated` counters。

`createProjectChannel` / `createResumeWindow` 必须：

- 如果 project 缺失，先创建 fallback shell session；
- 应用 proxy env；
- 创建 channel；
- 增加 `windowsCreated` counter。

### Rename / attach / delete

`renameProject` 返回：

```json
{"ok":true,"oldName":"old","newName":"new"}
```

`attachSessionWindow` 必须选择 channel，并记录 `NEXUS_LAST_CHANNEL`。

`renameSessionWindow` 返回：

```json
{"ok":true,"name":"new-name"}
```

`deleteSessionWindow` 必须：

- 删除指定 channel；
- 当删除最后一个 channel 或请求 `createFallbackShell` 时，先创建 fallback shell；
- 清理关联 Codex runtime dir。

`deleteProject` 必须：

- 删除 project；
- 清理所有关联 Codex runtime dirs。

## Codex History / Metadata Contract

`listCodexSessions` / `getCodexSessionDetail` 只读取共享 Codex home，并按 project cwd/repo root 过滤。

`resumeCodexSession` 必须：

- 在 project 下创建新 channel；
- 将 Codex session id 写入 channel metadata；
- 选择新 channel；
- 写入 last channel；
- 返回：

```json
{
  "ok": true,
  "project": "demo-project",
  "channelIndex": 7,
  "channelName": "codex-history",
  "sessionId": "session-1"
}
```

`deleteProjectCodexSession` 必须：

- 删除 Codex session 文件和 index entry；
- 关闭所有关联 resume channel；
- 如果这些 channel 覆盖 project 全部窗口，先创建 fallback shell；
- 清理关联 runtime dirs；
- 返回 closed window indexes。

## Scrollback / Snapshot Contract

当前 server fallback 通过 backend snapshot 能力读取指定 project/channel 的最近输出。

HTTP/WS 上层只依赖：

- 成功时返回 trimmed text snapshot；
- backend capture 失败时保持当前错误形状；
- snapshot 不创建或删除 project/channel。

默认 tmux 的 `capture-pane` 仍在 server fallback 路径中；native snapshot 则由 PTY runtime / supervisor 提供。两条路径必须保持相同的上层结果语义。

## Failure Contract

必须保持的错误语义：

| 场景 | 错误 |
|---|---|
| project 缺失 | `project not found` |
| session id 为空 | `session id required` |
| Codex session 不属于 project | `codex session not found in project` |
| unsupported runtime method | `unsupported method: <method>` |
| tmux command stderr 非空 | stderr 文本 |
| tmux command stderr 为空 | `tmux command failed: <args>` |

## Current Test Mapping

| Contract area | Current evidence |
|---|---|
| catalog / lifecycle / cleanup capability ports | `rust-runtime/src/bin/nexus_session_runtime/backend/{catalog,lifecycle,cleanup}.rs` 内的 local fake contract tests |
| stdio envelope / ready / client mapping | `tests/sessionManagementRustClient.test.js` |
| project/channel lifecycle | `tests/sessionManagementRustRuntimeBinary.test.js` |
| discovery filtering/fallback/ordering | `tests/sessionManagementRustRuntimeBinary.test.js` |
| Codex metadata resume/delete cleanup | `tests/sessionManagementRustRuntimeBinary.test.js` |
| PTY attach public `/ws?session=&window=` | `tests/ptyBrokerRustRuntimeBinary.test.js`, `tests/browserTerminalRegression.test.js` |
| scrollback snapshot fallback | `tests/nexusRustServerEntry.test.js` |
