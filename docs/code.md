# Nexus4CC 源码深度解析


## 项目概述

Nexus4CC 是一个专为 Claude Code 打造的跨设备 AI 终端桥接工具，核心理念是让用户能够在任何设备（尤其是移动设备）上无缝访问和操作运行在服务器上的 Claude Code 会话。它不是一个通用的终端模拟器，而是围绕“随时随地运行 Claude Code”这一核心工作流精心设计的解决方案。

**核心价值主张**：解决 Claude Code 被锁定在笔记本终端的痛点，通过 WebSocket 桥接技术实现跨设备访问，提供移动端优先的用户体验。

**技术栈**：

- 后端：Node.js + Express + WebSocket (ws)

- 前端：React + Vite + xterm.js

- 终端复用：tmux

- 伪终端：node-pty

- 认证：JWT + bcrypt

## 架构设计

### 整体架构

Nexus4CC 采用经典的 C/S 架构，通过 WebSocket 实现浏览器与 tmux 会话之间的实时双向通信：

```plaintext
┌─────────────┐         WebSocket          ┌──────────────┐
│   Browser   │ ◄─────────────────────────► │ Node Server  │
│  (xterm.js) │    (Real-time I/O)          │   (Express)  │
└─────────────┘                             └──────┬───────┘
                                                   │ node-pty
                                                   ▼
                                            ┌──────────────┐
                                            │     tmux     │
                                            │   sessions   │
                                            └──────────────┘
                                                   │
                                                   ▼
                                            ┌──────────────┐
                                            │ Claude Code  │
                                            │   Processes  │
                                            └──────────────┘
```

### 核心组件

#### 1. 服务端核心 (server.js)

**职责**：作为 WebSocket 服务器和 HTTP API 服务器，管理 PTY 会话、文件系统访问、任务调度等。

**关键模块**：

**认证系统**：

- 使用 bcrypt (12 轮） 对密码进行哈希

- JWT token 有效期 30 天

- 所有 API 和 WebSocket 连接都需要 token 验证

- WebSocket 因协议限制通过 query string 传递 token

**PTY 会话管理**：

```javascript
const ptyMap = new Map() // 存储 PTY 实例
const ptyKey = (session, windowIndex) => `${session}:${windowIndex}`
```

每个 tmux window 对应一个 PTY 实例，采用懒加载策略：

- 首次 WebSocket 连接时创建 PTY

- 多个客户端可以共享同一个 PTY（通过 clients Set 管理）

- 最后一个客户端断开后，PTY 保持运行但停止输出缓存

- 支持输出缓冲（最后 2KB）用于状态卡片显示

**WebSocket 协议**：

```javascript
// 客户端 → 服务端
{ type: 'input', data: '...' }        // 用户输入
{ type: 'resize', cols, rows }        // 终端尺寸调整

// 服务端 → 客户端
{ type: 'output', data: '...' }       // 终端输出
{ type: 'exit', code }                // 进程退出
```

**Project-Channel 架构** (F-20)：

- Project = tmux session（项目级别）

- Channel = tmux window（频道/窗口级别）

- 每个 Project 有独立的 `NEXUS_CWD` 环境变量记录工作目录

- 支持动态创建 Project 和 Channel

**文件系统 API**：

- 浏览：`GET /api/workspace/files` - 列出目录内容

- 读取：`GET /api/workspace/file` - 读取文件内容

- 写入：`PUT /api/workspace/file` - 保存文件

- 创建：`POST /api/workspace/files` - 创建新文件

- 删除：`DELETE /api/workspace/entry` - 删除文件/目录

- 重命名：`POST /api/workspace/rename`

- 复制：`POST /api/workspace/copy`

- 移动：`POST /api/workspace/move`

所有路径操作都包含安全检查，防止路径遍历攻击（检查 `..` 的存在）。

**上传系统** (F-14, F-21)：

- 项目上传：`POST /api/upload` - 上传到当前 session 的 cwd

- 独立上传：`POST /api/files/upload` - 上传到 `data/uploads/日期/`

- 使用 multer 处理 multipart/form-data

- 支持文件冲突检测和覆盖选项

- 最大文件大小：项目上传 50MB，独立上传 100MB

**配置管理**：

- Claude 配置 profile 存储在 `data/configs/` 目录

- 工具栏配置存储在 `data/toolbar-config.json`

- 支持 CRUD 操作

**任务系统**：

- 任务定义存储在 `data/tasks.json`

- 支持 SSE (Server-Sent Events) 流式输出

- 任务执行通过创建新的 tmux window 并监听输出

- 客户端可以异步监控任务进度

**代理配置**：\
服务器自动将宿主机的代理环境变量传递给 tmux session：

```javascript
const proxyVars = {
  HTTP_PROXY, HTTPS_PROXY, ALL_PROXY,
  http_proxy, https_proxy,
  NEXUS_PROXY: CLAUDE_PROXY  // 自定义代理
}
```

#### 2. 前端架构

**技术选型**：

- React 18 + Hooks

- xterm.js + xterm-addon-fit - 终端模拟

- xterm-addon-web-links - 链接识别

- React Router - 路由管理

- PWA - 渐进式 Web 应用

**核心组件**：

**Terminal 组件**：

- 使用 xterm.js 渲染终端

- 支持触控手势（滑动切换窗口、双指缩放）

- 可配置的软键盘工具栏

- 自动重连机制

- 输入法兼容处理（compositionstart/compositionend）

**TaskPanel 组件**：

- 显示任务列表和执行状态

- SSE 连接接收实时输出

- 支持任务的启动、停止、删除

- 输出历史记录管理

**FileBrowser 组件**：

- 树形目录浏览

- 文件编辑器（Monaco Editor 或简单 textarea）

- 文件上传（拖拽支持）

- 排序功能（名称/修改时间/大小）

- 文件操作（重命名、删除、复制、移动）

**SessionManager 组件**：

- 显示所有 tmux sessions

- 支持切换 session

- 显示每个 session 的窗口数量和活跃状态

**状态管理**：\
使用 React Context + useState 管理全局状态：

- 认证状态（token）

- 当前 session

- 窗口列表

- 主题设置

- 工具栏配置

#### 3. 数据持久化

**目录结构**：

```plaintext
data/
├── toolbar-config.json      # 工具栏配置
├── tasks.json               # 任务定义
├── configs/                 # Claude 配置 profiles
│   ├── default.json
│   └── custom.json
└── uploads/                 # 上传文件（按日期分组）
    ├── 2026-04-06/
    └── 2026-04-07/
```

所有持久化数据存储在 `data/` 目录，支持 Docker volume 挂载，确保容器重建后数据不丢失。

## 核心功能实现

### 1. WebSocket ↔ tmux 桥接

**实现原理**：

每个 tmux window 对应一个 node-pty 实例，通过 `tmux attach-session` 命令附加到指定窗口：

```javascript
const pty = nodePty.spawn('tmux', [
  'attach-session',
  '-t', `${session}:${windowIndex}`,
  '-d'  // detach other clients
], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: process.env.HOME,
  env: process.env
})
```

**数据流**：

1. 浏览器通过 WebSocket 发送用户输入

2. 服务器将输入写入 PTY：`pty.write(data)`

3. PTY 将输出通过 `data` 事件发送给服务器

4. 服务器通过 WebSocket 广播给所有连接的客户端

**多客户端支持**：

- 使用 Set 存储连接到同一 PTY 的所有 WebSocket 客户端

- 输出广播给所有客户端

- 任一客户端的输入都会影响 PTY 状态

**生命周期管理**：

- PTY 创建：首次连接时

- PTY 保持：最后一个客户端断开后仍保持运行

- PTY 清理：可选的超时清理机制（当前未实现）

### 2. 移动端优化

**触控手势**：

**滑动切换窗口**：

```javascript
let touchStartX = 0
let touchEndX = 0

const handleTouchStart = (e) => {
  touchStartX = e.changedTouches[0].screenX
}

const handleTouchEnd = (e) => {
  touchEndX = e.changedTouches[0].screenX
  const diff = touchStartX - touchEndX
  if (Math.abs(diff) > 50) {  // 最小滑动距离
    diff > 0 ? nextWindow() : prevWindow()
  }
}
```

**双指缩放**：\
通过 CSS transform 和 xterm.js 的 fontSize 选项实现：

```javascript
const handlePinch = (scale) => {
  const newFontSize = baseFontSize * scale
  terminal.options.fontSize = Math.max(8, Math.min(32, newFontSize))
  fitAddon.fit()
}
```

**软键盘工具栏**：

- 可配置的快捷键按钮（Ctrl+C, Tab, Esc 等）

- 支持自定义按钮和文本输入

- 持久化配置到服务器

**响应式布局**：

- 使用 CSS Grid 和 Flexbox

- 移动端隐藏侧边栏，使用抽屉式导航

- 自适应终端尺寸（通过 xterm-addon-fit）

### 3. 任务面板与 SSE 流式输出

**任务定义**：

```json
{
  "id": "task-uuid",
  "name": "Build Project",
  "command": "npm run build",
  "cwd": "/workspace/project",
  "shell_type": "bash"
}
```

**执行流程**：

1. 客户端发起任务执行请求：`POST /api/tasks/: id/run`

2. 服务器创建新的 tmux window 执行任务

3. 服务器通过 SSE 流式推送输出：`GET /api/tasks/: id/stream`

4. 客户端通过 EventSource 接收实时输出

5. 任务完成后，服务器发送 `done` 事件

**SSE 实现**：

```javascript
app.get('/api/tasks/:id/stream', authMiddleware, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  
  // 定期发送输出
  const interval = setInterval(() => {
    const output = getTaskOutput(taskId)
    res.write(`data: ${JSON.stringify({ output })}

`)
  }, 500)
  
  req.on('close', () => clearInterval(interval))
})
```

**优势**：

- 火力即忘（Fire and Forget）- 启动任务后可以关闭页面

- 异步监控 - 随时回来查看进度

- 历史记录 - 保存任务输出供后续查看

### 4. 文件浏览与编辑

**浏览器实现**：

- 递归读取目录结构

- 支持文件类型图标识别

- 实时排序（名称/修改时间/大小）

**编辑器集成**：

- 小文件（< 1MB）：使用 Monaco Editor（VS Code 编辑器）

- 大文件：使用简单 textarea

- 语法高亮根据文件扩展名自动识别

- 自动保存功能（可选）

**上传功能**：

- 拖拽上传

- 文件冲突检测

- 进度显示

- 支持批量上传

### 5. 多 Session 管理

**Session 切换**：

```javascript
const switchSession = async (sessionName) => {
  // 1. 断开当前 WebSocket 连接
  closeAllConnections()
  
  // 2. 更新当前 session
  setCurrentSession(sessionName)
  
  // 3. 重新获取窗口列表
  const windows = await fetchWindows(sessionName)
  
  // 4. 重新连接到新 session 的窗口
  connectToWindow(windows[0])
}
```

**Session 信息**：

- 名称

- 窗口数量

- 是否附加（attached）

- 工作目录（NEXUS_CWD）

### 6. 配置管理

**Claude 配置 Profile**：

```json
{
  "id": "default",
  "label": "Default Profile",
  "api_key": "sk-...",
  "model": "claude-3-5-sonnet",
  "max_tokens": 4096,
  "temperature": 0.7
}
```

**工具栏配置**：

```json
{
  "buttons": [
    { "label": "Ctrl+C", "action": "\\u0003" },
    { "label": "Tab", "action": "\\t" },
    { "label": "Esc", "action": "\\u001b" }
  ]
}
```

配置通过 REST API 进行 CRUD 操作，前端实时同步。

## 安全设计

### 认证与授权

**密码哈希**：

```javascript
const hash = await bcrypt.hash(password, 12)  // 12轮 salt
```

**JWT Token**：

- 签名算法：HS256

- 有效期：30 天

- 存储位置：localStorage（前端）

- 传递方式：

  - HTTP API:`Authorization: Bearer <token>`

  - WebSocket:`ws://host/ws? token=<token>`（协议限制）

### 路径安全

所有文件操作都进行路径规范化和安全检查：

```javascript
function sanitizePath(userPath) {
  let fullPath = isAbsolute(userPath) 
    ? userPath 
    : join(WORKSPACE_ROOT, userPath)
  
  fullPath = normalize(fullPath)
  
  // 防止路径遍历
  if (fullPath.includes('..')) {
    throw new Error('Invalid path')
  }
  
  // 确保在工作区内
  if (!fullPath.startsWith(WORKSPACE_ROOT)) {
    throw new Error('Access denied')
  }
  
  return fullPath
}
```

### 部署建议

**生产环境**：

- 启用 HTTPS/WSS（TLS 加密）

- 使用 Cloudflare Tunnel 或 Tailscale 暴露服务

- 运行在防火墙或 VPN 后

- 定期轮换 JWT_SECRET

- 使用强密码（建议 16+ 字符）

**Docker 部署**：

- 挂载 `data/` 目录为 volume

- 挂载工作区目录

- 限制容器资源（CPU、内存）

- 使用非 root 用户运行

## 性能优化

### 1. 连接复用

- 多个浏览器标签页共享同一个 PTY 实例

- 减少 tmux attach/detach 开销

- 输出广播而非多次读取

### 2. 输出缓冲

- 每个 PTY 维护最后 2KB 输出缓冲

- 用于状态卡片快速显示

- 避免频繁调用 `tmux capture-pane`

### 3. 懒加载

- PTY 实例按需创建

- 前端组件按需渲染

- 文件列表虚拟滚动（大目录）

### 4. WebSocket 优化

- 二进制数据传输（可选）

- 心跳检测（ping/pong）

- 自动重连机制

- 指数退避策略

## 扩展性设计

### 插件系统（规划中）

**工具栏插件**：

```javascript
{
  type: 'toolbar-button',
  label: 'Custom Action',
  action: async (terminal) => {
    // 自定义逻辑
  }
}
```

**任务模板**：

```javascript
{
  type: 'task-template',
  name: 'Deploy to Production',
  steps: [
    { command: 'npm run build' },
    { command: 'npm run test' },
    { command: 'npm run deploy' }
  ]
}
```

### Webhook 集成

支持 Telegram Bot 集成（已实现部分）：

```javascript
app.post('/api/telegram/webhook', (req, res) => {
  const { message } = req.body
  // 处理 Telegram 消息，执行命令
  executeCommand(message.text)
  res.json({ ok: true })
})
```

## 代码质量

### 错误处理

**统一错误响应**：

```javascript
try {
  // 业务逻辑
} catch (err) {
  res.status(500).json({ 
    error: err.message,
    code: err.code 
  })
}
```

**WebSocket 错误处理**：

```javascript
ws.on('error', (err) => {
  console.error('WebSocket error:', err)
  ws.close()
})

pty.on('exit', (code) => {
  ws.send(JSON.stringify({ 
    type: 'exit', 
    code 
  }))
})
```

### 日志系统

当前使用 `console.log/error`，生产环境建议使用结构化日志：

- Winston / Pino

- 日志级别：debug, info, warn, error

- 日志轮转

- 远程日志收集（可选）

### 测试策略

**单元测试**（建议添加）：

- 路径安全函数

- 认证中间件

- PTY 管理逻辑

**集成测试**（建议添加）：

- API 端点

- WebSocket 连接

- 文件操作

**E2E 测试**（建议添加）：

- 使用 Playwright 测试前端交互

- 终端输入输出验证

- 多设备场景模拟

## 项目结构

```plaintext
nexus4cc/
├── server.js                    # 服务端主文件（1775行）
├── package.json                 # 后端依赖
├── .env.example                 # 环境变量模板
├── ecosystem.config.cjs         # PM2 配置
├── nexus-run-claude.sh          # Claude 启动脚本
├── data/                        # 持久化数据目录
│   ├── configs/                 # Claude 配置
│   ├── uploads/                 # 上传文件
│   ├── tasks.json               # 任务定义
│   └── toolbar-config.json      # 工具栏配置
├── frontend/                    # 前端代码
│   ├── src/
│   │   ├── App.jsx              # 主应用组件
│   │   ├── components/
│   │   │   ├── Terminal.jsx     # 终端组件
│   │   │   ├── TaskPanel.jsx    # 任务面板
│   │   │   ├── FileBrowser.jsx  # 文件浏览器
│   │   │   └── ...
│   │   ├── hooks/               # 自定义 Hooks
│   │   └── utils/               # 工具函数
│   ├── package.json             # 前端依赖
│   └── vite.config.js           # Vite 配置
├── public/                      # 静态资源
│   ├── icon.svg                 # PWA 图标
│   ├── manifest.json            # PWA 清单
│   └── sw.js                    # Service Worker
├── ARCHITECTURE.md              # 架构文档
├── NORTH-STAR.md                # 核心原则
├── PRD.md                       # 产品需求
├── ROADMAP.md                   # 路线图
└── README.md                    # 项目说明
```

## 依赖分析

### 后端核心依赖

```json
{
  "express": "^4.18.2",        // Web 框架
  "ws": "^8.18.0",             // WebSocket 服务器
  "node-pty": "^1.1.0",        // 伪终端
  "jsonwebtoken": "^9.0.2",    // JWT 认证
  "bcrypt": "^5.1.1",          // 密码哈希
  "multer": "^2.1.1",          // 文件上传
  "playwright": "^1.58.2"      // 浏览器自动化（可选）
}
```

### 前端核心依赖

```json
{
  "react": "^18.x",
  "react-dom": "^18.x",
  "react-router-dom": "^6.x",
  "xterm": "^5.x",
  "xterm-addon-fit": "^0.8.x",
  "xterm-addon-web-links": "^0.9.x"
}
```

## 部署方案

### Docker 部署

**Dockerfile**（建议）：

```bash
FROM node:20-alpine

WORKDIR /app

# 安装 tmux 和 zsh
RUN apk add --no-cache tmux zsh

# 复制依赖文件
COPY package*.json ./
COPY frontend/package*.json ./frontend/

# 安装依赖
RUN npm ci --production
RUN cd frontend && npm ci && npm run build

# 复制源码
COPY . .

# 创建数据目录
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["npm", "start"]
```

**docker-compose.yml**：

```yaml
version: '3.8'
services:
  nexus:
    build: .
    ports:
      - "59000:3000"
    volumes:
      - ./data:/app/data
      - /workspace:/workspace
    environment:
      - JWT_SECRET=${JWT_SECRET}
      - ACC_PASSWORD_HASH=${ACC_PASSWORD_HASH}
      - WORKSPACE_ROOT=/workspace
      - CLAUDE_PROXY=http://host.docker.internal:6789
    restart: unless-stopped
```

### PM2 部署

```javascript
// ecosystem.config.cjs
module.exports = {
  apps: [{
    name: 'nexus4cc',
    script: './server.js',
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
}
```

启动：

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # 开机自启
```

### Cloudflare Tunnel

```bash
# 安装 cloudflared
brew install cloudflared  # macOS
# 或下载二进制文件

# 登录
cloudflared tunnel login

# 创建隧道
cloudflared tunnel create nexus

# 配置路由
cloudflared tunnel route dns nexus nexus.yourdomain.com

# 启动隧道
cloudflared tunnel run nexus
```

配置文件 `~/.cloudflared/config.yml`：

```yaml
tunnel: <tunnel-id>
credentials-file: /path/to/credentials.json

ingress:
  - hostname: nexus.yourdomain.com
    service: http://localhost:3000
  - service: http_status:404
</tunnel-id>
```

## 未来规划

根据 [ROADMAP.md](http://ROADMAP.md)，项目规划包括：

### 短期（v1.x）

- ✅ 基础 WebSocket ↔ tmux 桥接

- ✅ 移动端优化（触控手势、软键盘）

- ✅ 任务面板与 SSE 流式输出

- ✅ 文件浏览器

- ✅ 多 Session 管理

- 🔄 性能优化（输出缓冲、连接复用）

- 🔄 测试覆盖率提升

### 中期（v2.x）

- 📋 插件系统

- 📋 多用户支持（可选）

- 📋 更多 Webhook 集成（GitHub, Slack）

- 📋 命令历史和搜索

- 📋 终端录制与回放

### 长期（v3.x）

- 📋 AI 辅助功能（命令建议、错误诊断）

- 📋 协作功能（多人共享 session）

- 📋 性能监控面板

- 📋 自定义主题系统

## 核心设计原则

根据 [NORTH-STAR.md](http://NORTH-STAR.md)，Nexus4CC 遵循以下核心原则：

### 1. 移动端优先

- 所有功能必须在手机上可用且易用

- 触控优化优先于键盘快捷键

- 响应式设计而非自适应设计

### 2. 单一职责

- 专注于 Claude Code 工作流

- 不追求成为通用终端模拟器

- 拒绝功能膨胀

### 3. 零配置启动

- 开箱即用

- 合理的默认配置

- 可选的高级配置

### 4. 性能至上

- WebSocket 直连，无中间层

- 最小化延迟

- 优化移动网络场景

### 5. 安全第一

- 默认安全的配置

- 明确的安全边界

- 清晰的安全文档

## 技术亮点

### 1. PTY 会话复用

通过 Map 数据结构管理 PTY 实例，实现多客户端共享同一终端会话，减少资源消耗。

### 2. 优雅的错误处理

WebSocket 断线自动重连，PTY 异常退出通知客户端，文件操作失败友好提示。

### 3. 移动端手势识别

原生实现触控手势，无需第三方库，性能优异。

### 4. SSE 流式输出

使用 Server-Sent Events 实现任务输出流式推送，比 WebSocket 更适合单向数据流场景。

### 5. 路径安全机制

多层安全检查（规范化、遍历检测、边界验证），确保文件系统访问安全。

## 学习价值

### 对开发者的启示

**1. WebSocket 实战**：

- 如何设计 WebSocket 协议

- 如何处理连接生命周期

- 如何实现心跳和重连

**2. PTY 编程**：

- node-pty 的使用

- 终端 I/O 处理

- tmux 集成技巧

**3. 移动端优化**：

- 触控手势实现

- 响应式布局设计

- PWA 最佳实践

**4. 全栈架构**：

- 前后端分离

- RESTful API 设计

- 状态管理策略

**5. 安全设计**：

- 认证授权流程

- 路径遍历防护

- 安全部署方案

## 总结

Nexus4CC 是一个设计精良、实现扎实的跨设备终端桥接工具。它不追求大而全，而是专注于解决一个具体问题：让 Claude Code 可以在任何设备上使用。通过 WebSocket + tmux + node-pty 的技术组合，实现了低延迟、高可用的终端访问体验。

项目的核心价值在于：

- **解决真实痛点**：移动端访问服务器终端

- **技术选型合理**：充分利用现有工具（tmux）而非重复造轮

- **用户体验优先**：移动端手势、软键盘、PWA

- **架构清晰**：前后端分离、模块化设计

- **安全可靠**：多层安全机制、生产级部署方案

对于想要学习全栈开发、WebSocket 编程、终端模拟器实现的开发者来说，这是一个非常值得深入研究的项目。代码质量高、注释清晰、文档完善，是学习和参考的优秀范例。

---

**项目地址**：<https://github.com/librae8226/nexus4cc>

**许可证**：MIT

**技术栈**：Node.js + React + WebSocket + tmux + xterm.js

**适用场景**：

- 移动端访问服务器终端

- 远程运行 Claude Code

- 长时间任务监控

- 团队协作开发（未来）

**推荐指数**：⭐⭐⭐⭐⭐
