import test from 'node:test'
import assert from 'node:assert/strict'
import bcrypt from 'bcrypt'
import { once } from 'node:events'
import { spawn, spawnSync } from 'node:child_process'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TASK_FIXTURE = join(ROOT, 'tests', 'fixtures', 'fakeTaskRustRuntime.js')
const PTY_FIXTURE = join(ROOT, 'tests', 'fixtures', 'fakePtyRustRuntime.js')
const WINDOW_LAUNCH_FIXTURE = join(ROOT, 'tests', 'fixtures', 'fakeWindowLaunchRustRuntime.js')
const SESSION_MANAGEMENT_FIXTURE = join(ROOT, 'tests', 'fixtures', 'fakeSessionManagementRustRuntime.js')
const RUST_SERVER_BINARY = join(
  ROOT,
  'rust-runtime',
  'target',
  'debug',
  process.platform === 'win32' ? 'nexus-server.exe' : 'nexus-server',
)
const RUST_SESSION_RUNTIME_BINARY = join(
  ROOT,
  'rust-runtime',
  'target',
  'debug',
  process.platform === 'win32' ? 'nexus-session-runtime.exe' : 'nexus-session-runtime',
)
const RUST_WINDOW_LAUNCH_RUNTIME_BINARY = join(
  ROOT,
  'rust-runtime',
  'target',
  'debug',
  process.platform === 'win32' ? 'nexus-window-launch-runtime.exe' : 'nexus-window-launch-runtime',
)

let buildChecked = false

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout.trim()
}

function createGitRepoWithTags(repoDir, tags) {
  runCommand('git', ['init'], repoDir)
  runCommand('git', ['config', 'user.email', 'nexus@example.com'], repoDir)
  runCommand('git', ['config', 'user.name', 'Nexus Test'], repoDir)

  for (const [index, tag] of tags.entries()) {
    writeFileSync(join(repoDir, 'version.txt'), `${tag}\n`, 'utf8')
    runCommand('git', ['add', '.'], repoDir)
    runCommand('git', ['commit', '-m', `commit-${index + 1}`], repoDir)
    runCommand('git', ['tag', tag], repoDir)
  }
}

function ensureRustServerBuilt() {
  if (buildChecked) return
  const build = spawnSync(
      'cargo',
      [
        'build',
        '--manifest-path',
        'rust-runtime/Cargo.toml',
        '--bin',
        'nexus-server',
        '--bin',
        'nexus-session-runtime',
        '--bin',
        'nexus-window-launch-runtime',
      ],
    {
      cwd: ROOT,
      encoding: 'utf8',
    },
  )

  assert.equal(build.status, 0, build.stderr || build.stdout)
  buildChecked = true
}

async function getFreePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  server.close()
  await once(server, 'close')
  return port
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  const exitPromise = once(child, 'exit')
  const timeoutPromise = delay(5000).then(() => {
    if (child.exitCode === null) child.kill('SIGKILL')
  })
  await Promise.race([exitPromise, timeoutPromise])
}

async function waitForHealthyHttp(port, child) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`rust nexus-server exited early with code ${child.exitCode}`)
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (response.ok) return
    } catch {}

    await delay(250)
  }

  throw new Error(`rust nexus-server did not become healthy on port ${port}`)
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null

  while (Date.now() < deadline) {
    try {
      const result = await predicate()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await delay(50)
  }

  if (lastError) throw lastError
  throw new Error(`condition not met within ${timeoutMs}ms`)
}

function createProjectFixture() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'nexus-rust-server-'))
  mkdirSync(join(projectRoot, 'frontend', 'dist', 'assets'), { recursive: true })
  mkdirSync(join(projectRoot, 'public'), { recursive: true })

  writeFileSync(
    join(projectRoot, 'frontend', 'dist', 'index.html'),
    '<!doctype html><html><body><div id="app">rust server fixture</div></body></html>',
  )
  writeFileSync(join(projectRoot, 'frontend', 'dist', 'assets', 'app.js'), 'console.log("rust fixture");\n')
  writeFileSync(join(projectRoot, 'public', 'hello.txt'), 'hello from public\n')

  return projectRoot
}

function writeJsonl(filePath, lines) {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8')
}

function createCodexSessionFile(baseDir, { id, datePath, cwd, timestamp = '2026-04-14T12:00:00.000Z', metaFields = {} }) {
  const dir = join(baseDir, 'sessions', ...datePath.split('/'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, `rollout-${datePath.replaceAll('/', '-')}-${id}.jsonl`)
  writeJsonl(filePath, [
    JSON.stringify({
      timestamp,
      type: 'session_meta',
      payload: {
        id,
        timestamp,
        cwd,
        ...metaFields,
      },
    }),
  ])
  return filePath
}

function createDeleteTmuxFixture() {
  const baseDir = mkdtempSync(join(tmpdir(), 'nexus-rust-server-delete-tmux-'))
  const logFile = join(baseDir, 'tmux.log')
  const homeDir = join(baseDir, 'home')
  const dataDir = join(baseDir, 'data')
  mkdirSync(homeDir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })

  writeFileSync(
    join(baseDir, 'tmux'),
    `#!/bin/sh
set -eu
log_file="${logFile}"
cmd="$1"
shift || true
printf '%s|%s\n' "$cmd" "$*" >> "$log_file"
case "$cmd" in
  has-session|kill-session|kill-window|new-window)
    exit 0
    ;;
  display-message)
    if [ "$1" = "-t" ] && [ "$2" = "solo-project:7" ] && [ "$3" = "-p" ] && [ "$4" = '#{window_id}' ]; then
      printf '@7\n'
      exit 0
    fi
    exit 1
    ;;
  list-windows)
    if [ "$1" = "-t" ] && [ "$2" = "solo-project" ] && [ "$3" = "-F" ] && [ "$4" = '#{window_index}' ]; then
      printf '7\n'
      exit 0
    fi
    if [ "$1" = "-t" ] && [ "$2" = "demo-project" ] && [ "$3" = "-F" ] && [ "$4" = '#{window_id}' ]; then
      printf '%s\n' \
        '@3' \
        '@4'
      exit 0
    fi
    exit 1
    ;;
  *)
    exit 1
    ;;
esac
`,
    { mode: 0o755 },
  )

  return { baseDir, logFile, homeDir, dataDir }
}

function createCodexResumeTmuxFixture() {
  const baseDir = mkdtempSync(join(tmpdir(), 'nexus-rust-server-codex-resume-tmux-'))
  const logFile = join(baseDir, 'tmux.log')
  const homeDir = join(baseDir, 'home')
  const dataDir = join(baseDir, 'data')
  mkdirSync(homeDir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })

  writeFileSync(
    join(baseDir, 'tmux'),
    `#!/bin/sh
set -eu
log_file="${logFile}"
cmd="$1"
shift || true
printf '%s|%s\n' "$cmd" "$*" >> "$log_file"
case "$cmd" in
  has-session)
    if [ "$1" = "-t" ] && [ "$2" = "demo-project" ]; then
      exit 0
    fi
    exit 1
    ;;
  show-environment)
    if [ "$1" = "-t" ] && [ "$2" = "demo-project" ] && [ "$3" = "NEXUS_CWD" ]; then
      printf 'NEXUS_CWD=/workspace/demo\n'
      exit 0
    fi
    exit 1
    ;;
  new-window)
    if [ "$1" = "-P" ]; then
      printf '@9|7|history\n'
      exit 0
    fi
    exit 1
    ;;
  set-option|select-window|set-environment)
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
`,
    { mode: 0o755 },
  )

  return { baseDir, logFile, homeDir, dataDir }
}

function createShellPlanningTmuxFixture() {
  const baseDir = mkdtempSync(join(tmpdir(), 'nexus-rust-server-create-tmux-'))
  const logFile = join(baseDir, 'tmux.log')
  const homeDir = join(baseDir, 'home')
  const dataDir = join(baseDir, 'data')
  mkdirSync(homeDir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })

  writeFileSync(
    join(baseDir, 'tmux'),
    `#!/bin/sh
set -eu
log_file="${logFile}"
cmd="$1"
shift || true
printf '%s|%s\n' "$cmd" "$*" >> "$log_file"
case "$cmd" in
  has-session|set-environment|new-session|new-window)
    exit 0
    ;;
  list-sessions)
    if [ "$1" = "-F" ] && [ "$2" = '#{session_name}' ]; then
      printf '%s\n' \
        'workspace-demo' \
        'workspace-demo-1'
      exit 0
    fi
    exit 1
    ;;
  list-windows)
    if [ "$1" = "-t" ] && [ "$2" = "demo-project" ] && [ "$3" = "-F" ] && [ "$4" = '#{window_index}|#{window_name}|#{window_active}|#{pane_current_path}' ]; then
      printf '%s\n' \
        '0|shell|1|/workspace' \
        '1|review|0|/workspace/apps/demo'
      exit 0
    fi
    exit 1
    ;;
  *)
    exit 1
    ;;
esac
`,
    { mode: 0o755 },
  )

  return { baseDir, logFile, homeDir, dataDir }
}

function createWindowLaunchTmuxFixture() {
  const baseDir = mkdtempSync(join(tmpdir(), 'nexus-rust-server-window-launch-tmux-'))
  const logFile = join(baseDir, 'tmux.log')
  const stateDir = join(baseDir, 'state')
  const dataDir = join(baseDir, 'data')
  mkdirSync(stateDir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })

  writeFileSync(
    join(baseDir, 'tmux'),
    `#!/bin/sh
set -eu
log_file="${logFile}"
state_dir="${stateDir}"
cmd="$1"
shift || true
printf '%s|%s\n' "$cmd" "$*" >> "$log_file"
case "$cmd" in
  has-session|new-window|new-session)
    exit 0
    ;;
  set-environment)
    if [ "$1" = "-t" ]; then
      session="$2"
      key="$3"
      value="$4"
      mkdir -p "$state_dir/$session"
      printf '%s' "$value" > "$state_dir/$session/$key"
      exit 0
    fi
    exit 1
    ;;
  show-environment)
    if [ "$1" = "-t" ]; then
      session="$2"
      key="$3"
      file="$state_dir/$session/$key"
      if [ -f "$file" ]; then
        printf '%s=%s\n' "$key" "$(cat "$file")"
        exit 0
      fi
    fi
    exit 1
    ;;
  display-message)
    if [ "$1" = "-t" ] && [ "$3" = "-p" ] && [ "$4" = '#{pane_current_path}' ]; then
      session="$2"
      file="$state_dir/$session/NEXUS_CWD"
      if [ -f "$file" ]; then
        cat "$file"
        printf '\n'
        exit 0
      fi
      printf '/workspace\n'
      exit 0
    fi
    exit 1
    ;;
  *)
    exit 1
    ;;
esac
`,
    { mode: 0o755 },
  )

  return { baseDir, dataDir, logFile }
}

function createPtyScrollbackTmuxFixture() {
  const baseDir = mkdtempSync(join(tmpdir(), 'nexus-rust-server-pty-tmux-'))
  const logFile = join(baseDir, 'tmux.log')

  writeFileSync(
    join(baseDir, 'tmux'),
    `#!/bin/sh
set -eu
log_file="${logFile}"
cmd="$1"
shift || true
printf '%s|%s\n' "$cmd" "$*" >> "$log_file"
case "$cmd" in
  capture-pane)
    if [ "$1" = "-p" ] && [ "$2" = "-S" ] && [ "$4" = "-t" ] && [ "$5" = "demo-project:3" ]; then
      printf 'alpha   \nbeta   \n'
      exit 0
    fi
    exit 1
    ;;
  *)
    exit 1
    ;;
esac
`,
    { mode: 0o755 },
  )

  return { baseDir, logFile }
}

function spawnRustServer(envOverrides = {}) {
  let logs = ''
  const child = spawn(RUST_SERVER_BINARY, {
    cwd: ROOT,
    env: {
      ...process.env,
      NEXUS_SESSION_BACKEND: 'tmux',
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout.on('data', (chunk) => {
    logs += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    logs += chunk.toString()
  })

  return { child, getLogs: () => logs }
}

function requestRaw(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers,
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

function headerValue(headers, name) {
  const value = headers[String(name).toLowerCase()]
  if (Array.isArray(value)) return value.join(', ')
  return value == null ? '' : String(value)
}

function decodeEncodedBody(encoding, body) {
  if (encoding === 'gzip') return gunzipSync(body)
  if (encoding === 'br') return brotliDecompressSync(body)
  if (!encoding || encoding === 'identity') return body
  throw new Error(`unexpected content-encoding: ${encoding}`)
}

function assertNotImmutableCache(headers, label) {
  assert.equal(
    /(?:^|[,;\s])immutable(?:$|[,;\s])/i.test(headerValue(headers, 'cache-control')),
    false,
    `${label} must not receive immutable caching`,
  )
}

async function login(port, password) {
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })

  assert.equal(response.status, 200)
  return response.json()
}

function waitForWebSocketOpen(ws) {
  return new Promise((resolve, reject) => {
    const handleOpen = () => {
      cleanup()
      resolve()
    }
    const handleError = (error) => {
      cleanup()
      reject(error)
    }
    const handleClose = (code, reason) => {
      cleanup()
      reject(new Error(`websocket closed before open (${code}: ${reason.toString()})`))
    }
    const cleanup = () => {
      ws.off('open', handleOpen)
      ws.off('error', handleError)
      ws.off('close', handleClose)
    }
    ws.on('open', handleOpen)
    ws.on('error', handleError)
    ws.on('close', handleClose)
  })
}

function waitForWebSocketMessage(ws) {
  return new Promise((resolve, reject) => {
    const handleMessage = (data) => {
      cleanup()
      resolve(data.toString())
    }
    const handleError = (error) => {
      cleanup()
      reject(error)
    }
    const handleClose = (code, reason) => {
      cleanup()
      reject(new Error(`websocket closed before message (${code}: ${reason.toString()})`))
    }
    const cleanup = () => {
      ws.off('message', handleMessage)
      ws.off('error', handleError)
      ws.off('close', handleClose)
    }
    ws.on('message', handleMessage)
    ws.on('error', handleError)
    ws.on('close', handleClose)
  })
}

function waitForWebSocketPing(ws, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`websocket did not receive a ping within ${timeoutMs}ms`))
    }, timeoutMs)
    const handlePing = (data) => {
      cleanup()
      resolve(data)
    }
    const handleError = (error) => {
      cleanup()
      reject(error)
    }
    const handleClose = (code, reason) => {
      cleanup()
      reject(new Error(`websocket closed before ping (${code}: ${reason.toString()})`))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      ws.off('ping', handlePing)
      ws.off('error', handleError)
      ws.off('close', handleClose)
    }
    ws.on('ping', handlePing)
    ws.on('error', handleError)
    ws.on('close', handleClose)
  })
}

function waitForWebSocketClose(ws) {
  return new Promise((resolve, reject) => {
    const handleClose = (code, reason) => {
      cleanup()
      resolve({
        code,
        reason: reason.toString(),
      })
    }
    const handleError = (error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      ws.off('close', handleClose)
      ws.off('error', handleError)
    }
    ws.on('close', handleClose)
    ws.on('error', handleError)
  })
}

function parseSseTranscript(transcript) {
  return String(transcript)
    .trim()
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      let event = ''
      let data = ''
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7)
        if (line.startsWith('data: ')) data += line.slice(6)
      }
      return {
        event,
        data: data ? JSON.parse(data) : null,
      }
    })
}

async function createFakeTelegramApiServer() {
  const webhookSetups = []
  const sendMessages = []
  const editedMessages = []
  const fileLookups = []
  const fileDownloads = []
  let nextMessageId = 100

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const rawBody = Buffer.concat(chunks).toString('utf8')
    const jsonBody = rawBody ? JSON.parse(rawBody) : null

    if (req.method === 'GET' && url.pathname === '/botbot-token/setWebhook') {
      webhookSetups.push({
        webhookUrl: url.searchParams.get('url'),
        secretToken: url.searchParams.get('secret_token'),
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        webhookUrl: url.searchParams.get('url'),
        secretToken: url.searchParams.get('secret_token'),
      }))
      return
    }

    if (req.method === 'POST' && url.pathname === '/botbot-token/sendMessage') {
      sendMessages.push(jsonBody)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        result: {
          message_id: nextMessageId++,
        },
      }))
      return
    }

    if (req.method === 'POST' && url.pathname === '/botbot-token/editMessageText') {
      editedMessages.push(jsonBody)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        result: {
          message_id: jsonBody?.message_id || 0,
        },
      }))
      return
    }

    if (req.method === 'GET' && url.pathname === '/botbot-token/getFile') {
      fileLookups.push({
        fileId: url.searchParams.get('file_id'),
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        result: {
          file_path: 'docs/note.txt',
        },
      }))
      return
    }

    if (req.method === 'GET' && url.pathname === '/file/botbot-token/docs/note.txt') {
      fileDownloads.push({ path: url.pathname })
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('telegram-file-body')
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    webhookSetups,
    sendMessages,
    editedMessages,
    fileLookups,
    fileDownloads,
    async close() {
      server.close()
      await once(server, 'close')
    },
  }
}

test('rust nexus-server serves static assets and spa fallback', async (t) => {
  ensureRustServerBuilt()

  const projectRoot = createProjectFixture()
  const port = await getFreePort()
  const passwordHash = bcrypt.hashSync('server-password', 8)
  const { child, getLogs } = spawnRustServer({
    NEXUS_PROJECT_ROOT: projectRoot,
    HOST: '127.0.0.1',
    PORT: String(port),
    JWT_SECRET: 'rust-server-secret',
    ACC_PASSWORD_HASH: passwordHash,
  })

  t.after(async () => {
    await stopChild(child)
    rmSync(projectRoot, { recursive: true, force: true })
  })

  await waitForHealthyHttp(port, child)

  const indexResponse = await fetch(`http://127.0.0.1:${port}/`)
  const assetResponse = await fetch(`http://127.0.0.1:${port}/hello.txt`)
  const fallbackResponse = await fetch(`http://127.0.0.1:${port}/projects/demo`)

  assert.equal(indexResponse.status, 200)
  assert.match(await indexResponse.text(), /rust server fixture/)
  assert.equal(assetResponse.status, 200)
  assert.equal(await assetResponse.text(), 'hello from public\n')
  assert.equal(fallbackResponse.status, 200)
  assert.match(await fallbackResponse.text(), /rust server fixture/)
  assert.match(getLogs(), /nexus-server listening on 127\.0\.0\.1:/)
  assert.equal(
    readFileSync(join(projectRoot, 'frontend', 'dist', 'index.html'), 'utf8').includes('rust server fixture'),
    true,
  )
})

test('rust nexus-server negotiates static compression and cache headers', async (t) => {
  ensureRustServerBuilt()

  const projectRoot = createProjectFixture()
  const workspaceRoot = join(projectRoot, 'workspace')
  const dataDir = mkdtempSync(join(tmpdir(), 'nexus-rust-server-static-cache-'))
  const uploadsDateDir = join(dataDir, 'uploads', '2026-08-27')
  const hashedJs = `window.__NEXUS_STATIC_FIXTURE__=${JSON.stringify('x'.repeat(4096))};\n`
  const hashedCss = `/* nexus-static-fixture */\nbody{--nexus:'${'c'.repeat(2048)}';}\n`
  const stableJs = `window.__NEXUS_STABLE_FIXTURE__=${JSON.stringify('s'.repeat(4096))};\n`
  const uploadBody = `${'upload-bytes '.repeat(80)}\n`
  const workspaceBody = `${'workspace-download '.repeat(80)}\n`
  const workspaceFile = join(workspaceRoot, 'notes.txt')
  const hashedJsName = 'index-BjGrl-33.js'
  const hashedCssName = 'index-CIs4pl-C.css'

  mkdirSync(join(workspaceRoot), { recursive: true })
  mkdirSync(uploadsDateDir, { recursive: true })
  writeFileSync(join(projectRoot, 'frontend', 'dist', 'assets', hashedJsName), hashedJs)
  writeFileSync(join(projectRoot, 'frontend', 'dist', 'assets', hashedCssName), hashedCss)
  writeFileSync(join(projectRoot, 'frontend', 'dist', 'assets', 'stable.js'), stableJs)
  writeFileSync(join(projectRoot, 'frontend', 'dist', 'assets', 'configuration-defaults.js'), stableJs)
  writeFileSync(join(uploadsDateDir, 'notes.txt'), uploadBody)
  writeFileSync(workspaceFile, workspaceBody)

  const port = await getFreePort()
  const password = 'static-cache-password'
  const passwordHash = bcrypt.hashSync(password, 8)
  const { child } = spawnRustServer({
    NEXUS_PROJECT_ROOT: projectRoot,
    NEXUS_DATA_DIR: dataDir,
    WORKSPACE_ROOT: workspaceRoot,
    HOST: '127.0.0.1',
    PORT: String(port),
    JWT_SECRET: 'rust-server-secret',
    ACC_PASSWORD_HASH: passwordHash,
  })

  t.after(async () => {
    await stopChild(child)
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  await waitForHealthyHttp(port, child)

  const { token } = await login(port, password)
  const hashedAssetPath = `/assets/${hashedJsName}`
  const originalJs = Buffer.from(hashedJs)

  const gzipAsset = await requestRaw(port, hashedAssetPath, { 'accept-encoding': 'gzip' })
  assert.equal(gzipAsset.status, 200)
  assert.equal(headerValue(gzipAsset.headers, 'content-encoding'), 'gzip')
  assert.match(headerValue(gzipAsset.headers, 'vary'), /accept-encoding/i)
  assert.equal(headerValue(gzipAsset.headers, 'cache-control'), 'public, max-age=31536000, immutable')
  assert.equal(gzipAsset.body.equals(originalJs), false)
  assert.equal(decodeEncodedBody('gzip', gzipAsset.body).equals(originalJs), true)

  const brotliAsset = await requestRaw(port, hashedAssetPath, { 'accept-encoding': 'br' })
  assert.equal(brotliAsset.status, 200)
  assert.equal(headerValue(brotliAsset.headers, 'content-encoding'), 'br')
  assert.match(headerValue(brotliAsset.headers, 'vary'), /accept-encoding/i)
  assert.equal(headerValue(brotliAsset.headers, 'cache-control'), 'public, max-age=31536000, immutable')
  assert.equal(decodeEncodedBody('br', brotliAsset.body).equals(originalJs), true)

  const identityAsset = await requestRaw(port, hashedAssetPath, { 'accept-encoding': 'identity' })
  assert.equal(identityAsset.status, 200)
  assert.equal(headerValue(identityAsset.headers, 'content-encoding'), '')
  assert.match(headerValue(identityAsset.headers, 'vary'), /accept-encoding/i)
  assert.equal(identityAsset.body.equals(originalJs), true)
  assert.equal(headerValue(identityAsset.headers, 'cache-control'), 'public, max-age=31536000, immutable')

  const cssAsset = await requestRaw(port, `/assets/${hashedCssName}`, { 'accept-encoding': 'gzip' })
  assert.equal(cssAsset.status, 200)
  assert.equal(headerValue(cssAsset.headers, 'content-encoding'), 'gzip')
  assert.equal(headerValue(cssAsset.headers, 'cache-control'), 'public, max-age=31536000, immutable')
  assert.equal(decodeEncodedBody('gzip', cssAsset.body).toString('utf8'), hashedCss)

  const stableAsset = await requestRaw(port, '/assets/stable.js')
  assert.equal(stableAsset.status, 200)
  assert.equal(stableAsset.body.toString('utf8'), stableJs)
  assert.equal(headerValue(stableAsset.headers, 'cache-control'), 'no-cache')
  assertNotImmutableCache(stableAsset.headers, '/assets/stable.js')

  const longWordAsset = await requestRaw(port, '/assets/configuration-defaults.js')
  assert.equal(longWordAsset.status, 200)
  assert.equal(longWordAsset.body.toString('utf8'), stableJs)
  assert.equal(headerValue(longWordAsset.headers, 'cache-control'), 'no-cache')
  assertNotImmutableCache(longWordAsset.headers, '/assets/configuration-defaults.js')

  const indexResponse = await requestRaw(port, '/')
  assert.equal(indexResponse.status, 200)
  assert.equal(headerValue(indexResponse.headers, 'cache-control'), 'no-cache')
  assert.equal(indexResponse.body.includes('rust server fixture'), true)

  const spaFallback = await requestRaw(port, '/projects/demo')
  assert.equal(spaFallback.status, 200)
  assert.equal(headerValue(spaFallback.headers, 'cache-control'), 'no-cache')
  assert.equal(spaFallback.body.includes('rust server fixture'), true)

  const publicFile = await requestRaw(port, '/hello.txt')
  assert.equal(publicFile.status, 200)
  assert.equal(publicFile.body.toString('utf8'), 'hello from public\n')
  assert.equal(headerValue(publicFile.headers, 'cache-control'), 'no-cache')
  assertNotImmutableCache(publicFile.headers, '/hello.txt')

  const uploadFile = await requestRaw(port, '/uploads/2026-08-27/notes.txt')
  assert.equal(uploadFile.status, 200)
  assert.equal(uploadFile.body.toString('utf8'), uploadBody)
  assert.equal(headerValue(uploadFile.headers, 'cache-control'), 'no-cache')
  assertNotImmutableCache(uploadFile.headers, '/uploads')

  const workspaceDownload = await requestRaw(
    port,
    `/workspace?path=${encodeURIComponent(workspaceFile)}&token=${encodeURIComponent(token)}&dl=1`,
  )
  assert.equal(workspaceDownload.status, 200)
  assert.equal(workspaceDownload.body.toString('utf8'), workspaceBody)
  assert.match(headerValue(workspaceDownload.headers, 'content-disposition'), /attachment; filename\*=UTF-8''notes\.txt/)
  assert.equal(headerValue(workspaceDownload.headers, 'cache-control'), 'no-cache')
  assertNotImmutableCache(workspaceDownload.headers, '/workspace download')
})

test('rust nexus-server logs in and reports runtime status', async (t) => {
  ensureRustServerBuilt()

  const projectRoot = createProjectFixture()
  const port = await getFreePort()
  const password = 'phase1-password'
  const passwordHash = bcrypt.hashSync(password, 8)
  const { child } = spawnRustServer({
    NEXUS_PROJECT_ROOT: projectRoot,
    HOST: '127.0.0.1',
    PORT: String(port),
    JWT_SECRET: 'rust-server-secret',
    ACC_PASSWORD_HASH: passwordHash,
  })

  t.after(async () => {
    await stopChild(child)
    rmSync(projectRoot, { recursive: true, force: true })
  })

  await waitForHealthyHttp(port, child)

  const missingPasswordResponse = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  const unauthorizedResponse = await fetch(`http://127.0.0.1:${port}/api/runtime/status`)
  const loginResponse = await login(port, password)
  const runtimeStatusResponse = await fetch(`http://127.0.0.1:${port}/api/runtime/status`, {
    headers: { Authorization: `Bearer ${loginResponse.token}` },
  })

  assert.equal(missingPasswordResponse.status, 400)
  assert.equal(unauthorizedResponse.status, 401)
  assert.ok(loginResponse.token)
  assert.equal(runtimeStatusResponse.status, 200)
  assert.deepEqual(await runtimeStatusResponse.json(), {
    server: {
      mode: 'rust',
      ready: true,
      source: 'nexus-server',
    },
    taskRunner: {
      mode: 'unconfigured',
      ready: false,
      source: 'nexus-server',
      error: 'runtime executable not configured',
    },
    ptyBroker: {
      mode: 'unconfigured',
      ready: false,
      source: 'nexus-server',
      error: 'runtime executable not configured',
    },
    windowLaunch: {
      mode: 'unconfigured',
      ready: false,
      source: 'nexus-server',
      error: 'runtime executable not configured',
    },
    sessionManagement: {
      mode: 'unconfigured',
      ready: false,
      source: 'nexus-server',
      error: 'runtime executable not configured',
    },
  })
})

test('rust nexus-server reports configured child runtime status', async (t) => {
  ensureRustServerBuilt()

  const projectRoot = createProjectFixture()
  const port = await getFreePort()
  const password = 'runtime-phase2-password'
  const passwordHash = bcrypt.hashSync(password, 8)
  const { child, getLogs } = spawnRustServer({
    NEXUS_PROJECT_ROOT: projectRoot,
    HOST: '127.0.0.1',
    PORT: String(port),
    JWT_SECRET: 'rust-server-secret',
    ACC_PASSWORD_HASH: passwordHash,
    NEXUS_TASK_RUNNER_RUST_EXECUTABLE: process.execPath,
    NEXUS_TASK_RUNNER_RUST_ARGS: JSON.stringify([TASK_FIXTURE]),
    NEXUS_PTY_BROKER_RUST_EXECUTABLE: process.execPath,
    NEXUS_PTY_BROKER_RUST_ARGS: JSON.stringify([PTY_FIXTURE]),
    NEXUS_WINDOW_LAUNCH_RUST_EXECUTABLE: process.execPath,
    NEXUS_WINDOW_LAUNCH_RUST_ARGS: JSON.stringify([WINDOW_LAUNCH_FIXTURE]),
    NEXUS_SESSION_MANAGEMENT_RUST_EXECUTABLE: process.execPath,
    NEXUS_SESSION_MANAGEMENT_RUST_ARGS: JSON.stringify([SESSION_MANAGEMENT_FIXTURE]),
  })

  t.after(async () => {
    await stopChild(child)
    rmSync(projectRoot, { recursive: true, force: true })
  })

  await waitForHealthyHttp(port, child)

  const loginResponse = await login(port, password)
  const runtimeStatusResponse = await fetch(`http://127.0.0.1:${port}/api/runtime/status`, {
    headers: { Authorization: `Bearer ${loginResponse.token}` },
  })

  assert.equal(runtimeStatusResponse.status, 200)
  assert.deepEqual(await runtimeStatusResponse.json(), {
    server: {
      mode: 'rust',
      ready: true,
      source: 'nexus-server',
    },
    taskRunner: {
      mode: 'rust',
      ready: true,
      source: 'fake-task-rust-runtime',
      version: '0.0-test',
      capabilities: {
        tasks: true,
        admin: true,
      },
      runningTasks: 0,
    },
    ptyBroker: {
      mode: 'rust',
      ready: true,
      source: 'fake-pty-rust-runtime',
      version: '0.0-test',
      capabilities: {
        terminal: true,
        admin: true,
      },
      runningPtys: 0,
    },
    windowLaunch: {
      mode: 'rust',
      ready: true,
      source: 'fake-window-launch-rust-runtime',
      version: '0.0-test',
      capabilities: {
        launch: true,
        admin: true,
      },
      launches: 0,
    },
    sessionManagement: {
      mode: 'rust',
      ready: true,
      source: 'fake-session-management-rust-runtime',
      version: '0.0-test',
      capabilities: {
        sessions: true,
        admin: true,
      },
      projectsCreated: 0,
      windowsCreated: 0,
    },
  })
  assert.match(getLogs(), /task runner runtime ready: fake-task-rust-runtime@0\.0-test/)
  assert.match(getLogs(), /pty broker runtime ready: fake-pty-rust-runtime@0\.0-test/)
  assert.match(getLogs(), /window launch runtime ready: fake-window-launch-rust-runtime@0\.0-test/)
  assert.match(getLogs(), /session management runtime ready: fake-session-management-rust-runtime@0\.0-test/)
})

test('rust nexus-server serves pty output snapshot and tmux scrollback routes', async (t) => {
  ensureRustServerBuilt()

  const projectRoot = createProjectFixture()
  const tmuxFixture = createPtyScrollbackTmuxFixture()
  const port = await getFreePort()
  const password = 'pty-route-password'
  const passwordHash = bcrypt.hashSync(password, 8)
  const { child } = spawnRustServer({
    NEXUS_PROJECT_ROOT: projectRoot,
    HOST: '127.0.0.1',
    PORT: String(port),
    JWT_SECRET: 'rust-server-secret',
    ACC_PASSWORD_HASH: passwordHash,
    PATH: `${tmuxFixture.baseDir}:${process.env.PATH || ''}`,
    NEXUS_PTY_BROKER_RUST_EXECUTABLE: process.execPath,
    NEXUS_PTY_BROKER_RUST_ARGS: JSON.stringify([PTY_FIXTURE]),
    FAKE_PTY_RUNTIME_SNAPSHOT_JSON: JSON.stringify({
      'demo-project:3': {
        output: 'tail output',
        clients: 2,
      },
    }),
  })

  t.after(async () => {
    await stopChild(child)
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(tmuxFixture.baseDir, { recursive: true, force: true })
  })

  await waitForHealthyHttp(port, child)

  const { token } = await login(port, password)
  const headers = { Authorization: `Bearer ${token}` }
  const currentDate = new Date().toISOString().slice(0, 10)

  const outputResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/3/output?session=demo-project`, {
    headers,
  })
  const scrollbackResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/3/scrollback?session=demo-project&lines=20000`, {
    headers,
  })

  assert.equal(outputResponse.status, 200)
  assert.deepEqual(await outputResponse.json(), {
    connected: true,
    output: 'tail output',
    clients: 2,
    idleMs: 0,
  })

  assert.equal(scrollbackResponse.status, 200)
  assert.deepEqual(await scrollbackResponse.json(), {
    content: 'alpha\nbeta\n',
  })

  const log = readFileSync(tmuxFixture.logFile, 'utf8')
  assert.match(log, /capture-pane\|-p -S -10000 -t demo-project:3/)
})

test('rust nexus-server serves native scrollback from the pty runtime snapshot', async (t) => {
  ensureRustServerBuilt()

  const projectRoot = createProjectFixture()
  const tmuxFixture = createPtyScrollbackTmuxFixture()
  const port = await getFreePort()
  const password = 'native-scrollback-route-password'
  const passwordHash = bcrypt.hashSync(password, 8)
  const { child } = spawnRustServer({
    NEXUS_PROJECT_ROOT: projectRoot,
    HOST: '127.0.0.1',
    PORT: String(port),
    JWT_SECRET: 'rust-server-secret',
    ACC_PASSWORD_HASH: passwordHash,
    PATH: `${tmuxFixture.baseDir}:${process.env.PATH || ''}`,
    NEXUS_SESSION_BACKEND: 'native',
    NEXUS_PTY_BROKER_RUST_EXECUTABLE: process.execPath,
    NEXUS_PTY_BROKER_RUST_ARGS: JSON.stringify([PTY_FIXTURE]),
    FAKE_PTY_RUNTIME_SNAPSHOT_JSON: JSON.stringify({
      'demo-project:3': {
        outputSnapshot: 'recent native tail\n',
        scrollbackSnapshot: '\x1b[31mnative alpha\x1b[0m\r\nprogress 1\rprogress done\n\x1b[?25lCodex text\x1b[?25h\nrecent native tail\n',
        clients: 0,
      },
    }),
  })

  t.after(async () => {
    await stopChild(child)
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(tmuxFixture.baseDir, { recursive: true, force: true })
  })

  await waitForHealthyHttp(port, child)

  const { token } = await login(port, password)
  const headers = { Authorization: `Bearer ${token}` }

  const scrollbackResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/3/scrollback?session=demo-project&lines=100`, {
    headers,
  })

  assert.equal(scrollbackResponse.status, 200)
  assert.deepEqual(await scrollbackResponse.json(), {
    content: 'native alpha\nprogress done\nCodex text\nrecent native tail\n',
  })

  const log = existsSync(tmuxFixture.logFile) ? readFileSync(tmuxFixture.logFile, 'utf8') : ''
  assert.doesNotMatch(log, /capture-pane/)
})

test('rust nexus-server falls back to tmux capture-pane when pty snapshot is cold', async (t) => {
  ensureRustServerBuilt()

  const projectRoot = createProjectFixture()
  const tmuxFixture = createPtyScrollbackTmuxFixture()
  const port = await getFreePort()
  const password = 'pty-output-fallback-password'
  const passwordHash = bcrypt.hashSync(password, 8)
  const { child } = spawnRustServer({
    NEXUS_PROJECT_ROOT: projectRoot,
    HOST: '127.0.0.1',
    PORT: String(port),
    JWT_SECRET: 'rust-server-secret',
    ACC_PASSWORD_HASH: passwordHash,
    PATH: `${tmuxFixture.baseDir}:${process.env.PATH || ''}`,
    NEXUS_PTY_BROKER_RUST_EXECUTABLE: process.execPath,
    NEXUS_PTY_BROKER_RUST_ARGS: JSON.stringify([PTY_FIXTURE]),
  })

  t.after(async () => {
    await stopChild(child)
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(tmuxFixture.baseDir, { recursive: true, force: true })
  })

  await waitForHealthyHttp(port, child)

  const { token } = await login(port, password)
  const headers = { Authorization: `Bearer ${token}` }

  const outputResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/3/output?session=demo-project`, {
    headers,
  })

  assert.equal(outputResponse.status, 200)
  assert.deepEqual(await outputResponse.json(), {
    connected: true,
    output: 'alpha\nbeta\n',
    clients: 0,
    idleMs: 4000,
  })

  const log = readFileSync(tmuxFixture.logFile, 'utf8')
  assert.match(log, /capture-pane\|-p -S -200 -t demo-project:3/)
})

test('rust nexus-server honors optional output snapshot tailChars', async (t) => {
  ensureRustServerBuilt()

  const projectRoot = createProjectFixture()
  const tmuxFixture = createPtyScrollbackTmuxFixture()
  const requestLog = join(tmuxFixture.baseDir, 'pty-requests.log')
  const port = await getFreePort()
  const password = 'pty-output-tail-password'
  const passwordHash = bcrypt.hashSync(password, 8)
  const unicodeOutput = `HEAD-${'a'.repeat(20000)}-世界🙂TAIL`
  const { child } = spawnRustServer({
    NEXUS_PROJECT_ROOT: projectRoot,
    HOST: '127.0.0.1',
    PORT: String(port),
    JWT_SECRET: 'rust-server-secret',
    ACC_PASSWORD_HASH: passwordHash,
    PATH: `${tmuxFixture.baseDir}:${process.env.PATH || ''}`,
    NEXUS_PTY_BROKER_RUST_EXECUTABLE: process.execPath,
    NEXUS_PTY_BROKER_RUST_ARGS: JSON.stringify([PTY_FIXTURE]),
    FAKE_PTY_RUNTIME_REQUEST_LOG: requestLog,
    FAKE_PTY_RUNTIME_SNAPSHOT_JSON: JSON.stringify({
      'demo-project:1': {
        outputSnapshot: unicodeOutput,
        clients: 1,
      },
    }),
  })

  t.after(async () => {
    await stopChild(child)
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(tmuxFixture.baseDir, { recursive: true, force: true })
  })

  await waitForHealthyHttp(port, child)

  const { token } = await login(port, password)
  const headers = { Authorization: `Bearer ${token}` }
  const unicodeChars = Array.from(unicodeOutput)

  const fullResponse = await fetch('http://127.0.0.1:' + port + '/api/sessions/1/output?session=demo-project', {
    headers,
  })
  assert.equal(fullResponse.status, 200)
  const fullBody = await fullResponse.json()
  assert.equal(fullBody.connected, true)
  assert.equal(fullBody.output, unicodeOutput)
  assert.equal(Array.from(fullBody.output).length, unicodeChars.length)

  const unicodeResponse = await fetch(
    'http://127.0.0.1:' + port + '/api/sessions/1/output?session=demo-project&tailChars=6',
    { headers },
  )
  assert.equal(unicodeResponse.status, 200)
  const unicodeBody = await unicodeResponse.json()
  assert.equal(unicodeBody.output, unicodeChars.slice(-6).join(''))
  assert.equal(unicodeBody.output, '界🙂TAIL')

  const clampedResponse = await fetch(
    'http://127.0.0.1:' + port + '/api/sessions/1/output?session=demo-project&tailChars=999999',
    { headers },
  )
  assert.equal(clampedResponse.status, 200)
  const clampedBody = await clampedResponse.json()
  assert.equal(Array.from(clampedBody.output).length, 16384)
  assert.equal(clampedBody.output, unicodeChars.slice(-16384).join(''))
  assert.equal(clampedBody.output.startsWith('HEAD-'), false)

  const zeroResponse = await fetch(
    'http://127.0.0.1:' + port + '/api/sessions/1/output?session=demo-project&tailChars=0',
    { headers },
  )
  assert.equal(zeroResponse.status, 200)
  const zeroBody = await zeroResponse.json()
  assert.equal(Array.from(zeroBody.output).length, 16384)
  assert.equal(zeroBody.output, clampedBody.output)

  const invalidResponse = await fetch(
    'http://127.0.0.1:' + port + '/api/sessions/1/output?session=demo-project&tailChars=abc',
    { headers },
  )
  assert.equal(invalidResponse.status, 200)
  const invalidBody = await invalidResponse.json()
  assert.equal(Array.from(invalidBody.output).length, 16384)
  assert.equal(invalidBody.output, clampedBody.output)

  const emptyResponse = await fetch(
    'http://127.0.0.1:' + port + '/api/sessions/1/output?session=demo-project&tailChars=',
    { headers },
  )
  assert.equal(emptyResponse.status, 200)
  const emptyBody = await emptyResponse.json()
  assert.equal(Array.from(emptyBody.output).length, 16384)
  assert.equal(emptyBody.output, clampedBody.output)

  const whitespaceResponse = await fetch(
    'http://127.0.0.1:' + port + '/api/sessions/1/output?session=demo-project&tailChars=%20',
    { headers },
  )
  assert.equal(whitespaceResponse.status, 200)
  const whitespaceBody = await whitespaceResponse.json()
  assert.equal(Array.from(whitespaceBody.output).length, 16384)
  assert.equal(whitespaceBody.output, clampedBody.output)

  const fallbackResponse = await fetch(
    'http://127.0.0.1:' + port + '/api/sessions/3/output?session=demo-project&tailChars=5',
    { headers },
  )
  assert.equal(fallbackResponse.status, 200)
  const fallbackBody = await fallbackResponse.json()
  assert.equal(fallbackBody.connected, true)
  assert.equal(fallbackBody.output, Array.from('alpha\nbeta\n').slice(-5).join(''))

  const tmuxLog = readFileSync(tmuxFixture.logFile, 'utf8')
  assert.match(tmuxLog, /capture-pane\|-p -S -200 -t demo-project:3/)

  const brokerRequests = readFileSync(requestLog, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const snapshotRequests = brokerRequests.filter((entry) => entry.method === 'getOutputSnapshot')
  assert.ok(snapshotRequests.length >= 8, `expected broker snapshot requests, got ${snapshotRequests.length}`)
  assert.equal(
    snapshotRequests.some((entry) => entry.params.windowIndex === 1 && entry.params.tailChars === undefined),
    true,
    'omitted tailChars must keep the full getOutputSnapshot contract',
  )
  assert.equal(
    snapshotRequests.some((entry) => entry.params.windowIndex === 1 && entry.params.tailChars === 6),
    true,
    'broker must receive the requested tailChars',
  )
  assert.equal(
    snapshotRequests.some((entry) => entry.params.windowIndex === 1 && entry.params.tailChars === 16384),
    true,
    'empty/whitespace/zero/invalid/too-large tailChars must be clamped before the broker',
  )
  assert.equal(
    snapshotRequests.some((entry) => entry.params.windowIndex === 3 && entry.params.tailChars === 5),
    true,
    'tmux fallback requests must still pass tailChars to the broker',
  )
})

test('rust nexus-server bridges pty websocket traffic through the rust runtime', async (t) => {
  ensureRustServerBuilt()

  const projectRoot = createProjectFixture()
  const port = await getFreePort()
  const password = 'pty-ws-password'
  const passwordHash = bcrypt.hashSync(password, 8)
  const { child } = spawnRustServer({
    NEXUS_PROJECT_ROOT: projectRoot,
    HOST: '127.0.0.1',
    PORT: String(port),
    JWT_SECRET: 'rust-server-secret',
    ACC_PASSWORD_HASH: passwordHash,
    NEXUS_PTY_BROKER_RUST_EXECUTABLE: process.execPath,
    NEXUS_PTY_BROKER_RUST_ARGS: JSON.stringify([PTY_FIXTURE]),
    NEXUS_WS_HEARTBEAT_MS: '25',
  })

  t.after(async () => {
    await stopChild(child)
    rmSync(projectRoot, { recursive: true, force: true })
  })

  await waitForHealthyHttp(port, child)

  const { token } = await login(port, password)
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}&session=demo-project&window=3`)
  const closed = waitForWebSocketClose(ws)

  await waitForWebSocketOpen(ws)
  await waitForWebSocketPing(ws)
  ws.send('pwd\n')
  assert.equal(await waitForWebSocketMessage(ws), 'pwd\n')

  ws.close(1000, 'test complete')
  assert.deepEqual(await closed, {
    code: 1000,
    reason: 'test complete',
  })

  await delay(100)

  const outputResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/3/output?session=demo-project`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  assert.equal(outputResponse.status, 200)
  assert.deepEqual(await outputResponse.json(), {
    connected: false,
    output: '',
    clients: 0,
  })
})

test('rust nexus-server rejects websocket clients with invalid tokens', async (t) => {
  ensureRustServerBuilt()

  const projectRoot = createProjectFixture()
  const port = await getFreePort()
  const passwordHash = bcrypt.hashSync('pty-ws-invalid-token', 8)
  const { child } = spawnRustServer({
    NEXUS_PROJECT_ROOT: projectRoot,
    HOST: '127.0.0.1',
    PORT: String(port),
    JWT_SECRET: 'rust-server-secret',
    ACC_PASSWORD_HASH: passwordHash,
  })

  t.after(async () => {
    await stopChild(child)
    rmSync(projectRoot, { recursive: true, force: true })
  })

  await waitForHealthyHttp(port, child)

  const unauthorizedWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=bad-token&session=demo-project&window=3`)
  const closeResult = await waitForWebSocketClose(unauthorizedWs)

  assert.equal(closeResult.code, 4001)
  assert.equal(closeResult.reason, 'unauthorized')
})

test('rust nexus-server serves version and upload routes', async (t) => {
  ensureRustServerBuilt()

  const projectRoot = createProjectFixture()
  const workspaceRoot = join(projectRoot, 'workspace')
  const reviewDir = join(workspaceRoot, 'demo')
  const dataDir = mkdtempSync(join(tmpdir(), 'nexus-rust-server-upload-data-'))
  const uploadsDir = join(dataDir, 'uploads')
  mkdirSync(reviewDir, { recursive: true })
  mkdirSync(uploadsDir, { recursive: true })

  createGitRepoWithTags(projectRoot, ['v4.4.2'])
  writeFileSync(join(projectRoot, 'dirty.txt'), 'dirty\n', 'utf8')

  const latestRepo = mkdtempSync(join(tmpdir(), 'nexus-rust-server-latest-repo-'))
  createGitRepoWithTags(latestRepo, ['v4.5.0', 'v4.6.0'])

  const port = await getFreePort()
  const password = 'version-upload-password'
  const passwordHash = bcrypt.hashSync(password, 8)
  const { child } = spawnRustServer({
    NEXUS_PROJECT_ROOT: projectRoot,
    NEXUS_DATA_DIR: dataDir,
    WORKSPACE_ROOT: workspaceRoot,
    GITHUB_REPO: latestRepo,
    HOST: '127.0.0.1',
    PORT: String(port),
    JWT_SECRET: 'rust-server-secret',
    ACC_PASSWORD_HASH: passwordHash,
    NEXUS_SESSION_MANAGEMENT_RUST_EXECUTABLE: process.execPath,
    NEXUS_SESSION_MANAGEMENT_RUST_ARGS: JSON.stringify([SESSION_MANAGEMENT_FIXTURE]),
    FAKE_SESSION_MANAGEMENT_WORKSPACE_ROOT: workspaceRoot,
  })

  t.after(async () => {
    await stopChild(child)
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(latestRepo, { recursive: true, force: true })
  })

  await waitForHealthyHttp(port, child)

  const { token } = await login(port, password)
  const headers = { Authorization: `Bearer ${token}` }
  const currentDate = new Date().toISOString().slice(0, 10)

  const currentVersionResponse = await fetch(`http://127.0.0.1:${port}/api/version`, { headers })
  assert.equal(currentVersionResponse.status, 200)
  assert.deepEqual(await currentVersionResponse.json(), {
    current: 'v4.4.2',
    clean: false,
  })

  const latestVersionResponse = await fetch(`http://127.0.0.1:${port}/api/version/latest`, { headers })
  assert.equal(latestVersionResponse.status, 200)
  assert.deepEqual(await latestVersionResponse.json(), {
    latest: 'v4.6.0',
    url: `${latestRepo}#v4.6.0`,
  })

  const workspaceUploadForm = new FormData()
  workspaceUploadForm.set('session_name', 'review')
  workspaceUploadForm.set('file', new Blob(['workspace-bytes']), 'report?.txt')

  const workspaceUploadResponse = await fetch(`http://127.0.0.1:${port}/api/upload`, {
    method: 'POST',
    headers,
    body: workspaceUploadForm,
  })
  assert.equal(workspaceUploadResponse.status, 200)
  assert.deepEqual(await workspaceUploadResponse.json(), {
    ok: true,
    path: join(reviewDir, 'report_.txt'),
    filename: 'report_.txt',
    size: 15,
  })
  assert.equal(readFileSync(join(reviewDir, 'report_.txt'), 'utf8'), 'workspace-bytes')

  const managedUploadForm = new FormData()
  managedUploadForm.set('originalName', 'capture?.png')
  managedUploadForm.set('file', new Blob(['managed-bytes']), 'image?.png')

  const managedUploadResponse = await fetch(`http://127.0.0.1:${port}/api/files/upload`, {
    method: 'POST',
    headers,
    body: managedUploadForm,
  })
  assert.equal(managedUploadResponse.status, 200)
  const managedUpload = await managedUploadResponse.json()
  assert.deepEqual(managedUpload, {
    ok: true,
    filename: 'capture_.png',
    url: `/uploads/${currentDate}/capture_.png`,
    fullPath: join(uploadsDir, currentDate, 'capture_.png'),
    size: 13,
    originalName: 'capture?.png',
  })
  assert.equal(readFileSync(managedUpload.fullPath, 'utf8'), 'managed-bytes')

  const managedStaticResponse = await fetch(`http://127.0.0.1:${port}${managedUpload.url}`)
  assert.equal(managedStaticResponse.status, 200)
  assert.equal(await managedStaticResponse.text(), 'managed-bytes')

  const managedFilesResponse = await fetch(`http://127.0.0.1:${port}/api/files`, { headers })
  assert.equal(managedFilesResponse.status, 200)
  const managedFiles = await managedFilesResponse.json()
  assert.equal(managedFiles.length, 1)
  assert.equal(managedFiles[0].date, currentDate)
  assert.equal(managedFiles[0].files[0].name, 'capture_.png')
  assert.equal(managedFiles[0].files[0].url, managedUpload.url)

  const deleteManagedFileResponse = await fetch(
    `http://127.0.0.1:${port}/api/files/${managedFiles[0].date}/${encodeURIComponent('capture_.png')}`,
    {
      method: 'DELETE',
      headers,
    },
  )
  assert.equal(deleteManagedFileResponse.status, 200)
  assert.deepEqual(await deleteManagedFileResponse.json(), { ok: true })

  const secondManagedUploadForm = new FormData()
  secondManagedUploadForm.set('file', new Blob(['cleanup']), 'cleanup.txt')
  const secondManagedUploadResponse = await fetch(`http://127.0.0.1:${port}/api/files/upload`, {
    method: 'POST',
    headers,
    body: secondManagedUploadForm,
  })
  assert.equal(secondManagedUploadResponse.status, 200)

  const deleteAllManagedFilesResponse = await fetch(`http://127.0.0.1:${port}/api/files/all`, {
    method: 'DELETE',
    headers,
  })
  assert.equal(deleteAllManagedFilesResponse.status, 200)
  assert.deepEqual(await deleteAllManagedFilesResponse.json(), {
    ok: true,
    deletedCount: 1,
  })
})

test('rust nexus-server serves config and workspace routes', async (t) => {
  ensureRustServerBuilt()

  const projectRoot = createProjectFixture()
  const workspaceRoot = join(projectRoot, 'workspace')
  const dataDir = mkdtempSync(join(tmpdir(), 'nexus-rust-server-workspace-data-'))
  const demoDir = join(workspaceRoot, 'demo')
  const docsDir = join(workspaceRoot, 'docs')
  const hiddenDir = join(workspaceRoot, '.hidden')
  const notesFile = join(demoDir, 'notes.txt')
  const binaryFile = join(docsDir, 'guide.md')
  const nestedDir = join(demoDir, 'archive')
  const movedFile = join(demoDir, 'notes-renamed.txt')
  const copiedFile = join(demoDir, 'notes-copy.txt')
  const movedTarget = join(demoDir, 'moved', 'notes.txt')
  mkdirSync(demoDir, { recursive: true })
  mkdirSync(docsDir, { recursive: true })
  mkdirSync(hiddenDir, { recursive: true })
  writeFileSync(notesFile, 'alpha\n', 'utf8')
  writeFileSync(binaryFile, '# 指南\n中文内容\n', 'utf8')
  writeFileSync(join(workspaceRoot, '.secret'), 'hidden\n', 'utf8')
  writeFileSync(join(dataDir, 'project-shell-defaults.json'), `${JSON.stringify({
    [demoDir]: {
      shell_type: 'codex',
      profile: 'daily',
      updated_at: '2026-04-18T00:00:00.000Z',
    },
  }, null, 2)}\n`)
  writeFileSync(join(dataDir, 'toolbar-config.json'), '{broken', 'utf8')

  const port = await getFreePort()
  const password = 'workspace-route-password'
  const passwordHash = bcrypt.hashSync(password, 8)
  const { child } = spawnRustServer({
    NEXUS_PROJECT_ROOT: projectRoot,
    NEXUS_DATA_DIR: dataDir,
    WORKSPACE_ROOT: workspaceRoot,
    NEXUS_CODEX_HISTORY_ENABLED: '0',
    TMUX_SESSION: '~',
    HOST: '127.0.0.1',
    PORT: String(port),
    JWT_SECRET: 'rust-server-secret',
    ACC_PASSWORD_HASH: passwordHash,
  })

  t.after(async () => {
    await stopChild(child)
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  await waitForHealthyHttp(port, child)

  const { token } = await login(port, password)
  const headers = { Authorization: `Bearer ${token}` }
  const jsonHeaders = {
    ...headers,
    'Content-Type': 'application/json',
  }

  const configResponse = await fetch(`http://127.0.0.1:${port}/api/config`, { headers })
  assert.equal(configResponse.status, 200)
  assert.deepEqual(await configResponse.json(), {
    tmuxSession: '~',
    sessionBackend: 'tmux',
    configuredSessionBackend: 'tmux',
    workspaceRoot,
    features: {
      codexHistory: false,
    },
  })

  const projectDefaultsResponse = await fetch(
    `http://127.0.0.1:${port}/api/project-defaults?path=${encodeURIComponent('demo')}`,
    { headers },
  )
  assert.equal(projectDefaultsResponse.status, 200)
  assert.deepEqual(await projectDefaultsResponse.json(), {
    path: demoDir,
    shell_type: 'codex',
    profile: 'daily',
  })

  const brokenToolbarResponse = await fetch(`http://127.0.0.1:${port}/api/toolbar-config`, { headers })
  assert.equal(brokenToolbarResponse.status, 200)
  assert.equal(await brokenToolbarResponse.json(), null)

  const saveToolbarResponse = await fetch(`http://127.0.0.1:${port}/api/toolbar-config`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ density: 'compact', showLabels: true }),
  })
  assert.equal(saveToolbarResponse.status, 200)
  assert.deepEqual(await saveToolbarResponse.json(), { ok: true })

  const toolbarResponse = await fetch(`http://127.0.0.1:${port}/api/toolbar-config`, { headers })
  assert.equal(toolbarResponse.status, 200)
  assert.deepEqual(await toolbarResponse.json(), {
    density: 'compact',
    showLabels: true,
  })

  const browseResponse = await fetch(`http://127.0.0.1:${port}/api/browse`, { headers })
  assert.equal(browseResponse.status, 200)
  assert.deepEqual(await browseResponse.json(), {
    path: workspaceRoot,
    parent: dirname(workspaceRoot),
    dirs: [
      { name: 'demo', path: demoDir },
      { name: 'docs', path: docsDir },
    ],
  })

  const listRootResponse = await fetch(`http://127.0.0.1:${port}/api/workspace/files`, { headers })
  assert.equal(listRootResponse.status, 200)
  const listRootPayload = await listRootResponse.json()
  assert.equal(listRootPayload.path, workspaceRoot)
  assert.deepEqual(
    listRootPayload.entries.map(({ name, type }) => ({ name, type })),
    [
      { name: 'demo', type: 'dir' },
      { name: 'docs', type: 'dir' },
    ],
  )

  const mkdirResponse = await fetch(`http://127.0.0.1:${port}/api/workspace/mkdir`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ path: demoDir, name: 'archive' }),
  })
  assert.equal(mkdirResponse.status, 200)
  assert.deepEqual(await mkdirResponse.json(), {
    ok: true,
    path: nestedDir,
  })

  const createFileResponse = await fetch(`http://127.0.0.1:${port}/api/workspace/files`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ path: nestedDir, name: 'todo.txt', content: 'draft\n' }),
  })
  assert.equal(createFileResponse.status, 200)
  assert.deepEqual(await createFileResponse.json(), {
    ok: true,
    path: join(nestedDir, 'todo.txt'),
  })

  const readFileResponse = await fetch(
    `http://127.0.0.1:${port}/api/workspace/file?path=${encodeURIComponent(notesFile)}`,
    { headers },
  )
  assert.equal(readFileResponse.status, 200)
  assert.deepEqual(await readFileResponse.json(), {
    path: notesFile,
    content: 'alpha\n',
  })

  const writeFileResponse = await fetch(`http://127.0.0.1:${port}/api/workspace/file`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify({ path: notesFile, content: 'beta\n' }),
  })
  assert.equal(writeFileResponse.status, 200)
  assert.deepEqual(await writeFileResponse.json(), {
    ok: true,
    path: notesFile,
  })
  assert.equal(readFileSync(notesFile, 'utf8'), 'beta\n')

  const renameResponse = await fetch(`http://127.0.0.1:${port}/api/workspace/rename`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ path: notesFile, newName: 'notes-renamed.txt' }),
  })
  assert.equal(renameResponse.status, 200)
  assert.deepEqual(await renameResponse.json(), {
    ok: true,
    path: movedFile,
  })

  const copyResponse = await fetch(`http://127.0.0.1:${port}/api/workspace/copy`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ sourcePath: movedFile, targetPath: copiedFile }),
  })
  assert.equal(copyResponse.status, 200)
  assert.deepEqual(await copyResponse.json(), {
    ok: true,
    path: copiedFile,
  })

  const mkdirMovedResponse = await fetch(`http://127.0.0.1:${port}/api/workspace/mkdir`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ path: demoDir, name: 'moved' }),
  })
  assert.equal(mkdirMovedResponse.status, 200)

  const moveResponse = await fetch(`http://127.0.0.1:${port}/api/workspace/move`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ sourcePath: copiedFile, targetPath: movedTarget }),
  })
  assert.equal(moveResponse.status, 200)
  assert.deepEqual(await moveResponse.json(), {
    ok: true,
    path: movedTarget,
  })

  const deleteResponse = await fetch(`http://127.0.0.1:${port}/api/workspace/entry`, {
    method: 'DELETE',
    headers: jsonHeaders,
    body: JSON.stringify({ path: movedTarget }),
  })
  assert.equal(deleteResponse.status, 200)
  assert.deepEqual(await deleteResponse.json(), { ok: true })
  assert.equal(existsSync(movedTarget), false)

  const servedFileResponse = await fetch(
    `http://127.0.0.1:${port}/workspace?path=${encodeURIComponent(movedFile)}&token=${encodeURIComponent(token)}&dl=1`,
  )
  assert.equal(servedFileResponse.status, 200)
  assert.equal(await servedFileResponse.text(), 'beta\n')
  assert.match(
    servedFileResponse.headers.get('content-disposition') || '',
    /attachment; filename\*=UTF-8''notes-renamed\.txt/,
  )

  const servedMarkdownResponse = await fetch(
    `http://127.0.0.1:${port}/workspace?path=${encodeURIComponent(binaryFile)}&token=${encodeURIComponent(token)}`,
  )
  assert.equal(servedMarkdownResponse.status, 200)
  assert.match(servedMarkdownResponse.headers.get('content-type') || '', /^text\/markdown(?:;|$)/)
  assert.match(servedMarkdownResponse.headers.get('content-type') || '', /charset=utf-8/i)
  assert.equal(await servedMarkdownResponse.text(), '# 指南\n中文内容\n')
})

test('rust nexus-server persists session backend config and keeps current backend until restart', async (t) => {
  ensureRustServerBuilt()

  const projectRoot = createProjectFixture()
  const dataDir = mkdtempSync(join(tmpdir(), 'nexus-session-backend-data-'))
  const requestLog = join(dataDir, 'session-requests.jsonl')
  const port = await getFreePort()
  const password = 'session-backend-password'
  const passwordHash = bcrypt.hashSync(password, 8)
  const { child } = spawnRustServer({
    NEXUS_PROJECT_ROOT: projectRoot,
    NEXUS_DATA_DIR: dataDir,
    WORKSPACE_ROOT: '/workspace',
    TMUX_SESSION: '~',
    HOST: '127.0.0.1',
    PORT: String(port),
    JWT_SECRET: 'rust-server-secret',
    ACC_PASSWORD_HASH: passwordHash,
    NEXUS_SESSION_MANAGEMENT_RUST_EXECUTABLE: process.execPath,
    NEXUS_SESSION_MANAGEMENT_RUST_ARGS: JSON.stringify([SESSION_MANAGEMENT_FIXTURE]),
    FAKE_SESSION_MANAGEMENT_REQUEST_LOG: requestLog,
    FAKE_SESSION_MANAGEMENT_LOG_ENV: '1',
  })

  t.after(async () => {
    await stopChild(child)
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  await waitForHealthyHttp(port, child)

  const { token } = await login(port, password)
  const headers = { Authorization: `Bearer ${token}` }
  const jsonHeaders = {
    ...headers,
    'Content-Type': 'application/json',
  }

  const beforeResponse = await fetch(`http://127.0.0.1:${port}/api/config`, { headers })
  assert.equal(beforeResponse.status, 200)
  assert.deepEqual(await beforeResponse.json(), {
    tmuxSession: '~',
    sessionBackend: 'tmux',
    configuredSessionBackend: 'tmux',
    workspaceRoot: '/workspace',
    features: {
      codexHistory: true,
    },
  })

  const saveResponse = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ session_backend: 'native' }),
  })
  assert.equal(saveResponse.status, 200)
  assert.deepEqual(await saveResponse.json(), {
    ok: true,
    sessionBackend: 'tmux',
    configuredSessionBackend: 'native',
    restartRequired: true,
  })

  const afterResponse = await fetch(`http://127.0.0.1:${port}/api/config`, { headers })
  assert.equal(afterResponse.status, 200)
  assert.deepEqual(await afterResponse.json(), {
    tmuxSession: '~',
    sessionBackend: 'tmux',
    configuredSessionBackend: 'native',
    workspaceRoot: '/workspace',
    features: {
      codexHistory: true,
    },
  })

  assert.deepEqual(
    JSON.parse(readFileSync(join(dataDir, 'session-backend.json'), 'utf8')),
    { session_backend: 'native' },
  )

  const projectsResponse = await fetch(`http://127.0.0.1:${port}/api/projects`, { headers })
  assert.equal(projectsResponse.status, 200)

  const requests = readFileSync(requestLog, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const listProjects = requests.find((request) => request.method === 'listProjects')
  assert.ok(listProjects)
  assert.equal(listProjects.env.NEXUS_SESSION_BACKEND, 'tmux')
})

test('rust nexus-server serves config profile and cc-switch routes', async (t) => {
  ensureRustServerBuilt()

  const projectRoot = createProjectFixture()
  const dataDir = mkdtempSync(join(tmpdir(), 'nexus-rust-server-config-data-'))
  const homeDir = join(dataDir, 'home')
  const binDir = join(dataDir, 'bin')
  const claudeDir = join(homeDir, '.claude')
  const codexHomeDir = join(homeDir, '.codex')
  const ccSwitchDir = join(homeDir, '.cc-switch')
  mkdirSync(join(dataDir, 'configs'), { recursive: true })
  mkdirSync(join(dataDir, 'codex-configs'), { recursive: true })
  mkdirSync(join(dataDir, 'codex-validate'), { recursive: true })
  mkdirSync(claudeDir, { recursive: true })
  mkdirSync(codexHomeDir, { recursive: true })
  mkdirSync(ccSwitchDir, { recursive: true })
  mkdirSync(binDir, { recursive: true })

  writeFileSync(join(dataDir, 'configs', 'team.json'), JSON.stringify({
    label: 'Team Profile',
    API_KEY: 'old-key',
    SYNC_SOURCE: 'cc-switch',
    SYNC_SOURCE_ID: 'provider-1',
  }, null, 2), 'utf8')
  writeFileSync(join(dataDir, 'codex-configs', 'imported.json'), JSON.stringify({ label: 'existing' }, null, 2), 'utf8')
  writeFileSync(join(dataDir, 'codex-configs', 'chatgpt-only.json'), JSON.stringify({
    label: 'ChatGPT Only',
    AUTH_JSON: JSON.stringify({ auth_mode: 'chatgpt' }, null, 2),
  }, null, 2), 'utf8')
  writeFileSync(join(dataDir, 'codex-configs', 'sync-me.json'), JSON.stringify({
    label: 'Sync Me',
    AUTH_JSON: JSON.stringify({ auth_mode: 'chatgpt' }, null, 2),
  }, null, 2), 'utf8')

  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: 'https://claude.example.com',
      ANTHROPIC_AUTH_TOKEN: 'token-123',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-5',
    },
  }, null, 2), 'utf8')

  writeFileSync(
    join(codexHomeDir, 'config.toml'),
    'model_provider = "custom"\nmodel = "gpt-5.4"\nmodel_reasoning_effort = "high"\n\n[model_providers.custom]\nbase_url = "https://api.openai.com/v1"\n',
    'utf8',
  )
  writeFileSync(join(codexHomeDir, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt' }, null, 2), 'utf8')

  writeFileSync(
    join(binDir, 'codex'),
    `#!/bin/sh
set -eu
if [ "$1" = "login" ] && [ "$2" = "status" ]; then
  printf 'Logged in using ChatGPT\\n'
  exit 0
fi
if [ "$1" = "exec" ]; then
  output_file=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "-o" ]; then
      output_file="$2"
      shift 2
      continue
    fi
    shift
  done
  if [ -n "$output_file" ]; then
    printf 'OK\\n' > "$output_file"
  fi
  exit 0
fi
exit 1
`,
    { mode: 0o755 },
  )

  const db = new DatabaseSync(join(ccSwitchDir, 'cc-switch.db'))
  db.exec(`
    CREATE TABLE providers (
      id TEXT NOT NULL,
      app_type TEXT NOT NULL,
      name TEXT NOT NULL,
      settings_config TEXT NOT NULL,
      meta TEXT NOT NULL DEFAULT '{}',
      is_current BOOLEAN NOT NULL DEFAULT 0,
      PRIMARY KEY (id, app_type)
    );
  `)
  db.prepare(`
    INSERT INTO providers (id, app_type, name, settings_config, is_current)
    VALUES (?, 'codex', ?, ?, ?)
  `).run(
    'provider-xmapi',
    'xmapi',
    JSON.stringify({
      auth: { OPENAI_API_KEY: 'sk-test' },
      config: 'model_provider = "custom"\nmodel = "gpt-5.4"\n\n[model_providers.custom]\nbase_url = "https://example.com/v1"',
    }),
    1,
  )
  db.close()

  const port = await getFreePort()
  const password = 'config-profile-password'
  const passwordHash = bcrypt.hashSync(password, 8)
  const { child } = spawnRustServer({
    NEXUS_PROJECT_ROOT: projectRoot,
    NEXUS_DATA_DIR: dataDir,
    HOME: homeDir,
    PATH: `${process.env.PATH || ''}:${binDir}`,
    TMUX_SESSION: '~',
    HOST: '127.0.0.1',
    PORT: String(port),
    JWT_SECRET: 'rust-server-secret',
    ACC_PASSWORD_HASH: passwordHash,
  })

  t.after(async () => {
    await stopChild(child)
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  await waitForHealthyHttp(port, child)

  const { token } = await login(port, password)
  const headers = { Authorization: `Bearer ${token}` }
  const jsonHeaders = {
    ...headers,
    'Content-Type': 'application/json',
  }

  const claudeListResponse = await fetch(`http://127.0.0.1:${port}/api/configs`, { headers })
  assert.equal(claudeListResponse.status, 200)
  const claudeList = await claudeListResponse.json()
  assert.equal(claudeList.some((config) => config.id === 'team' && config.label === 'Team Profile'), true)

  const saveClaudeResponse = await fetch(`http://127.0.0.1:${port}/api/configs/new-profile`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      label: 'New Profile',
      BASE_URL: 'https://kimi.example.com',
      API_KEY: 'kimi-key',
    }),
  })
  assert.equal(saveClaudeResponse.status, 200)
  assert.deepEqual(await saveClaudeResponse.json(), {
    ok: true,
    id: 'new-profile',
  })

  const syncClaudeResponse = await fetch(`http://127.0.0.1:${port}/api/configs/team/sync-current`, {
    method: 'POST',
    headers,
  })
  assert.equal(syncClaudeResponse.status, 200)
  const syncedClaude = await syncClaudeResponse.json()
  assert.equal(syncedClaude.ok, true)
  assert.equal(syncedClaude.id, 'team')
  assert.equal(syncedClaude.config.label, 'Team Profile')
  assert.equal(syncedClaude.config.BASE_URL, 'https://claude.example.com')
  assert.equal(syncedClaude.config.AUTH_TOKEN, 'token-123')
  assert.equal(syncedClaude.config.DEFAULT_MODEL, 'claude-sonnet-4-5')
  assert.equal(syncedClaude.config.SYNC_SOURCE, 'cc-switch')
  assert.equal(syncedClaude.config.SYNC_SOURCE_ID, 'provider-1')

  const deleteClaudeResponse = await fetch(`http://127.0.0.1:${port}/api/configs/new-profile`, {
    method: 'DELETE',
    headers,
  })
  assert.equal(deleteClaudeResponse.status, 200)
  assert.deepEqual(await deleteClaudeResponse.json(), { ok: true })

  const codexListResponse = await fetch(`http://127.0.0.1:${port}/api/codex-configs`, { headers })
  assert.equal(codexListResponse.status, 200)
  const codexList = await codexListResponse.json()
  assert.equal(codexList.some((config) => config.id === 'chatgpt-only' && config.label === 'ChatGPT Only'), true)

  const saveCodexResponse = await fetch(`http://127.0.0.1:${port}/api/codex-configs/manual`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      label: 'Manual',
      BASE_URL: 'https://api.openai.example/v1',
      MODEL: 'gpt-5.4',
    }),
  })
  assert.equal(saveCodexResponse.status, 200)
  assert.deepEqual(await saveCodexResponse.json(), {
    ok: true,
    id: 'manual',
  })

  const validateCodexResponse = await fetch(`http://127.0.0.1:${port}/api/codex-configs/chatgpt-only/validate`, {
    method: 'POST',
    headers,
  })
  assert.equal(validateCodexResponse.status, 200)
  assert.deepEqual(await validateCodexResponse.json(), {
    ok: true,
    message: 'Logged in using ChatGPT',
  })

  const importGlobalCodexResponse = await fetch(`http://127.0.0.1:${port}/api/codex-configs/import-global`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ id: 'Imported' }),
  })
  assert.equal(importGlobalCodexResponse.status, 200)
  const importedGlobalCodex = await importGlobalCodexResponse.json()
  assert.equal(importedGlobalCodex.ok, true)
  assert.equal(importedGlobalCodex.id, 'imported-1')
  assert.equal(importedGlobalCodex.config.id, 'imported-1')
  assert.equal(importedGlobalCodex.config.MODEL, 'gpt-5.4')
  assert.equal(importedGlobalCodex.config.BASE_URL, 'https://api.openai.com/v1')
  assert.match(String(importedGlobalCodex.config.AUTH_JSON || ''), /"auth_mode": "chatgpt"/)

  const syncCodexResponse = await fetch(`http://127.0.0.1:${port}/api/codex-configs/sync-me/sync-current`, {
    method: 'POST',
    headers,
  })
  assert.equal(syncCodexResponse.status, 200)
  const syncedCodex = await syncCodexResponse.json()
  assert.equal(syncedCodex.ok, true)
  assert.equal(syncedCodex.id, 'sync-me')
  assert.equal(syncedCodex.config.label, 'Sync Me')
  assert.equal(syncedCodex.config.MODEL, 'gpt-5.4')
  assert.equal(syncedCodex.config.BASE_URL, 'https://api.openai.com/v1')
  assert.match(String(syncedCodex.config.AUTH_JSON || ''), /"auth_mode": "chatgpt"/)

  const codexProvidersResponse = await fetch(`http://127.0.0.1:${port}/api/cc-switch/providers?kind=codex`, { headers })
  assert.equal(codexProvidersResponse.status, 200)
  assert.deepEqual(await codexProvidersResponse.json(), [{
    provider_id: 'provider-xmapi',
    kind: 'codex',
    name: 'xmapi',
    is_current: true,
    model: 'gpt-5.4',
    base_url: 'https://example.com/v1',
    auth_mode: 'api_key',
    existing_profile_id: null,
    target_profile_id: 'cc-switch-xmapi',
  }])

  const importCcSwitchResponse = await fetch(
    `http://127.0.0.1:${port}/api/cc-switch/providers/codex/${encodeURIComponent('provider-xmapi')}/import`,
    {
      method: 'POST',
      headers,
    },
  )
  assert.equal(importCcSwitchResponse.status, 200)
  const importedCcSwitch = await importCcSwitchResponse.json()
  assert.equal(importedCcSwitch.ok, true)
  assert.equal(importedCcSwitch.id, 'cc-switch-xmapi')
  assert.equal(importedCcSwitch.config.id, 'cc-switch-xmapi')
  assert.equal(importedCcSwitch.config.MODEL, 'gpt-5.4')
  assert.equal(importedCcSwitch.config.BASE_URL, 'https://example.com/v1')
  assert.equal(importedCcSwitch.config.SYNC_SOURCE, 'cc-switch')
  assert.equal(importedCcSwitch.config.SYNC_SOURCE_ID, 'provider-xmapi')

  const deleteCodexResponse = await fetch(`http://127.0.0.1:${port}/api/codex-configs/manual`, {
    method: 'DELETE',
    headers,
  })
  assert.equal(deleteCodexResponse.status, 200)
  assert.deepEqual(await deleteCodexResponse.json(), { ok: true })
})

test('rust nexus-server syncs codex history from cc-switch into the global codex home', async (t) => {
  ensureRustServerBuilt()

  const projectRoot = createProjectFixture()
  const dataDir = mkdtempSync(join(tmpdir(), 'nexus-rust-server-codex-sync-data-'))
  const homeDir = join(dataDir, 'home')
  const codexHomeDir = join(homeDir, '.codex')
  const ccSwitchDir = join(homeDir, '.cc-switch')
  const activationJournal = join(homeDir, '.local', 'state', 'cc-switch', 'activation-journal.jsonl')
  mkdirSync(codexHomeDir, { recursive: true })
  mkdirSync(ccSwitchDir, { recursive: true })
  mkdirSync(dirname(activationJournal), { recursive: true })

  const sessionId = '11111111-2222-3333-4444-555555555555'
  writeJsonl(join(codexHomeDir, 'sessions', '2026', '04', '14', `rollout-2026-04-14-${sessionId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-04-14T12:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: sessionId,
        timestamp: '2026-04-14T12:00:00.000Z',
        cwd: '/workspace/demo',
        source: 'exec',
        model_provider: 'openai',
        cli_version: '0.117.0',
        dynamic_tools: [
          {
            name: 'shell_exec',
            description: 'execute shell command',
            input_schema: { type: 'object' },
            defer_loading: false,
          },
        ],
      },
    }),
    JSON.stringify({
      timestamp: '2026-04-14T12:00:01.000Z',
      type: 'turn_context',
      payload: {
        model: 'gpt-5.4',
        approval_policy: 'never',
        sandbox_policy: { mode: 'danger-full-access' },
      },
    }),
    JSON.stringify({
      timestamp: '2026-04-14T12:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Fix replay sync' }],
      },
    }),
  ])
  writeJsonl(activationJournal, [
    JSON.stringify({
      type: 'activation',
      timestamp: '2026-04-14T11:59:00.000Z',
      providerId: 'codex',
      accountId: 'provider-xmapi',
      previousAccountId: 'provider-old',
      reason: 'manual',
      automatic: false,
      forced: false,
      protectedByManualGrace: false,
    }),
  ])
  writeFileSync(
    join(ccSwitchDir, 'settings.json'),
    `${JSON.stringify({ currentProviderCodex: 'provider-xmapi' }, null, 2)}\n`,
    'utf8',
  )

  const db = new DatabaseSync(join(ccSwitchDir, 'cc-switch.db'))
  db.exec(`
    CREATE TABLE providers (
      id TEXT NOT NULL,
      app_type TEXT NOT NULL,
      name TEXT NOT NULL,
      website_url TEXT,
      category TEXT,
      settings_config TEXT NOT NULL,
      meta TEXT NOT NULL DEFAULT '{}',
      is_current BOOLEAN NOT NULL DEFAULT 0,
      PRIMARY KEY (id, app_type)
    );
  `)
  db.prepare(`
    INSERT INTO providers (id, app_type, name, website_url, category, settings_config, is_current)
    VALUES (?, 'codex', ?, ?, ?, ?, ?)
  `).run(
    'provider-xmapi',
    'xmapi',
    'https://example.com',
    'custom',
    JSON.stringify({
      config: 'model_provider = "custom"\nmodel = "gpt-5.4"\n\n[model_providers.custom]\nbase_url = "https://example.com/v1"\n',
    }),
    1,
  )
  db.close()

  const port = await getFreePort()
  const password = 'codex-sync-password'
  const passwordHash = bcrypt.hashSync(password, 8)
  const { child } = spawnRustServer({
    NEXUS_PROJECT_ROOT: projectRoot,
    NEXUS_DATA_DIR: dataDir,
    HOME: homeDir,
    HOST: '127.0.0.1',
    PORT: String(port),
    JWT_SECRET: 'rust-server-secret',
    ACC_PASSWORD_HASH: passwordHash,
  })

  t.after(async () => {
    await stopChild(child)
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  await waitForHealthyHttp(port, child)

  const { token } = await login(port, password)
  const response = await fetch(`http://127.0.0.1:${port}/api/cc-switch/codex/sync-history`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.currentProviderCodex, 'provider-xmapi')
  assert.equal(payload.targetAccountId, 'provider-xmapi')
  assert.equal(payload.indexProjection.writtenEntries, 1)
  assert.equal(payload.stateProjection.writtenThreads, 1)
  assert.equal(payload.stateProjection.targetModelProvider, 'custom')

  const sessionIndex = readFileSync(join(codexHomeDir, 'session_index.jsonl'), 'utf8')
  assert.match(sessionIndex, /Fix replay sync/)
  assert.match(sessionIndex, new RegExp(sessionId))

  const stateDb = new DatabaseSync(join(codexHomeDir, 'state_5.sqlite'))
  const projectedThread = stateDb.prepare(`
    SELECT id, model_provider, source, title
    FROM threads
    ORDER BY updated_at DESC
    LIMIT 1
  `).get()
  const projectedTool = stateDb.prepare(`
    SELECT name, description
    FROM thread_dynamic_tools
    WHERE thread_id = ?
    ORDER BY position ASC
    LIMIT 1
  `).get(sessionId)
  stateDb.close()

  assert.deepEqual({ ...projectedThread }, {
    id: sessionId,
    model_provider: 'custom',
    source: 'cli',
    title: 'Fix replay sync',
  })
  assert.deepEqual({ ...projectedTool }, {
    name: 'shell_exec',
    description: 'execute shell command',
  })
})

test('rust nexus-server serves telegram setup and webhook routes', async (t) => {
  ensureRustServerBuilt()

  const projectRoot = createProjectFixture()
  const workspaceRoot = join(projectRoot, 'workspace')
  const reviewDir = join(workspaceRoot, 'demo')
  const dataDir = mkdtempSync(join(tmpdir(), 'nexus-rust-server-telegram-data-'))
  mkdirSync(reviewDir, { recursive: true })
  const telegramApi = await createFakeTelegramApiServer()
  const port = await getFreePort()
  const password = 'telegram-route-password'
  const passwordHash = bcrypt.hashSync(password, 8)
  const { child } = spawnRustServer({
    NEXUS_PROJECT_ROOT: projectRoot,
    NEXUS_DATA_DIR: dataDir,
    WORKSPACE_ROOT: workspaceRoot,
    TMUX_SESSION: '~',
    TELEGRAM_BOT_TOKEN: 'bot-token',
    TELEGRAM_WEBHOOK_SECRET: 'secret-token',
    TELEGRAM_DEFAULT_SESSION: 'review',
    NEXUS_TELEGRAM_API_BASE_URL: telegramApi.baseUrl,
    HOST: '127.0.0.1',
    PORT: String(port),
    JWT_SECRET: 'rust-server-secret',
    ACC_PASSWORD_HASH: passwordHash,
    NEXUS_TASK_RUNNER_RUST_EXECUTABLE: process.execPath,
    NEXUS_TASK_RUNNER_RUST_ARGS: JSON.stringify([TASK_FIXTURE]),
    NEXUS_SESSION_MANAGEMENT_RUST_EXECUTABLE: process.execPath,
    NEXUS_SESSION_MANAGEMENT_RUST_ARGS: JSON.stringify([SESSION_MANAGEMENT_FIXTURE]),
    FAKE_SESSION_MANAGEMENT_WORKSPACE_ROOT: workspaceRoot,
  })

  t.after(async () => {
    await stopChild(child)
    await telegramApi.close()
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  await waitForHealthyHttp(port, child)

  const { token } = await login(port, password)
  const headers = { Authorization: `Bearer ${token}` }
  const jsonHeaders = {
    'Content-Type': 'application/json',
  }

  const setupResponse = await fetch(`http://127.0.0.1:${port}/api/telegram/setup`, {
    headers: {
      ...headers,
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'nexus.example.com',
    },
  })
  assert.equal(setupResponse.status, 200)
  assert.deepEqual(await setupResponse.json(), {
    webhookUrl: 'https://nexus.example.com/api/webhooks/telegram',
    telegramResponse: {
      ok: true,
      webhookUrl: 'https://nexus.example.com/api/webhooks/telegram',
      secretToken: 'secret-token',
    },
  })
  assert.deepEqual(telegramApi.webhookSetups, [{
    webhookUrl: 'https://nexus.example.com/api/webhooks/telegram',
    secretToken: 'secret-token',
  }])

  const invalidWebhookResponse = await fetch(`http://127.0.0.1:${port}/api/webhooks/telegram`, {
    method: 'POST',
    headers: {
      ...jsonHeaders,
      'x-telegram-bot-api-secret-token': 'wrong-secret',
    },
    body: JSON.stringify({ message: { chat: { id: 11 }, text: 'ignore me' } }),
  })
  assert.equal(invalidWebhookResponse.status, 403)
  assert.deepEqual(await invalidWebhookResponse.json(), { error: 'forbidden' })

  const textWebhookResponse = await fetch(`http://127.0.0.1:${port}/api/webhooks/telegram`, {
    method: 'POST',
    headers: {
      ...jsonHeaders,
      'x-telegram-bot-api-secret-token': 'secret-token',
    },
    body: JSON.stringify({ message: { chat: { id: 11 }, text: 'fix this' } }),
  })
  assert.equal(textWebhookResponse.status, 200)
  assert.deepEqual(await textWebhookResponse.json(), { ok: true })

  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/tasks`, { headers })
    const tasks = await response.json()
    return tasks[0]?.source === 'telegram' && tasks[0]?.status === 'success' ? tasks : null
  })

  const historyAfterTextResponse = await fetch(`http://127.0.0.1:${port}/api/tasks`, { headers })
  assert.equal(historyAfterTextResponse.status, 200)
  const historyAfterText = await historyAfterTextResponse.json()
  assert.equal(historyAfterText[0].prompt, 'fix this')
  assert.equal(historyAfterText[0].source, 'telegram')
  assert.equal(historyAfterText[0].session_name, 'review')
  assert.equal(historyAfterText[0].tmux_session, '~')
  assert.equal(historyAfterText[0].output, 'fake:fix this')

  await waitFor(() => telegramApi.editedMessages.length >= 1)
  assert.match(telegramApi.sendMessages[0].text, /执行中/)
  assert.match(telegramApi.editedMessages[0].text, /执行完成/)

  const uploadWebhookResponse = await fetch(`http://127.0.0.1:${port}/api/webhooks/telegram`, {
    method: 'POST',
    headers: {
      ...jsonHeaders,
      'x-telegram-bot-api-secret-token': 'secret-token',
    },
    body: JSON.stringify({
      message: {
        chat: { id: 21 },
        document: { file_id: 'file-1', file_name: 'note.txt' },
        caption: 'summarize it',
      },
    }),
  })
  assert.equal(uploadWebhookResponse.status, 200)
  assert.deepEqual(await uploadWebhookResponse.json(), { ok: true })

  await waitFor(() => existsSync(join(workspaceRoot, 'note.txt')))
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/tasks`, { headers })
    const tasks = await response.json()
    return tasks[0]?.prompt === 'summarize it' && tasks[0]?.status === 'success' ? tasks : null
  })

  const historyAfterUploadResponse = await fetch(`http://127.0.0.1:${port}/api/tasks`, { headers })
  assert.equal(historyAfterUploadResponse.status, 200)
  const historyAfterUpload = await historyAfterUploadResponse.json()
  assert.equal(historyAfterUpload[0].prompt, 'summarize it')
  assert.equal(historyAfterUpload[0].source, 'telegram')
  assert.equal(historyAfterUpload[0].session_name, 'telegram')
  assert.equal(historyAfterUpload[0].output, 'fake:summarize it')
  assert.equal(readFileSync(join(workspaceRoot, 'note.txt'), 'utf8'), 'telegram-file-body')
  assert.deepEqual(telegramApi.fileLookups, [{ fileId: 'file-1' }])
  assert.deepEqual(telegramApi.fileDownloads, [{ path: '/file/botbot-token/docs/note.txt' }])
  assert.equal(telegramApi.sendMessages.some((message) => /正在下载文件/.test(message.text)), true)
  assert.equal(telegramApi.sendMessages.some((message) => /文件已保存/.test(message.text)), true)
})

test('rust nexus-server serves task history, SSE task execution, and task deletion', async (t) => {
  ensureRustServerBuilt()

  const projectRoot = createProjectFixture()
  const dataDir = mkdtempSync(join(tmpdir(), 'nexus-rust-server-task-data-'))
  writeFileSync(
    join(dataDir, 'tasks.json'),
    `${JSON.stringify([
      {
        id: 'finished-1',
        status: 'success',
        output: 'done',
        error: '',
        createdAt: '2026-04-01T00:00:00.000Z',
      },
      {
        id: 'running-1',
        status: 'running',
        output: '',
        error: '',
        createdAt: '2026-04-01T00:05:00.000Z',
      },
    ], null, 2)}\n`,
  )
  const port = await getFreePort()
  const password = 'task-route-password'
  const passwordHash = bcrypt.hashSync(password, 8)
  const { child } = spawnRustServer({
    NEXUS_PROJECT_ROOT: projectRoot,
    NEXUS_DATA_DIR: dataDir,
    HOST: '127.0.0.1',
    PORT: String(port),
    JWT_SECRET: 'rust-server-secret',
    ACC_PASSWORD_HASH: passwordHash,
    NEXUS_TASK_RUNNER_RUST_EXECUTABLE: process.execPath,
    NEXUS_TASK_RUNNER_RUST_ARGS: JSON.stringify([TASK_FIXTURE]),
    NEXUS_SESSION_MANAGEMENT_RUST_EXECUTABLE: process.execPath,
    NEXUS_SESSION_MANAGEMENT_RUST_ARGS: JSON.stringify([SESSION_MANAGEMENT_FIXTURE]),
  })

  t.after(async () => {
    await stopChild(child)
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  await waitForHealthyHttp(port, child)

  const { token } = await login(port, password)
  const headers = { Authorization: `Bearer ${token}` }
  const jsonHeaders = {
    ...headers,
    'Content-Type': 'application/json',
  }

  const historyBeforeResponse = await fetch(`http://127.0.0.1:${port}/api/tasks`, { headers })
  assert.equal(historyBeforeResponse.status, 200)
  const historyBefore = await historyBeforeResponse.json()
  assert.equal(historyBefore[0].id, 'running-1')
  assert.equal(historyBefore[0].status, 'error')
  assert.equal(historyBefore[0].error, '(服务重启，任务中断)')
  assert.ok(historyBefore[0].completedAt)
  assert.equal(historyBefore[1].id, 'finished-1')

  const createTaskResponse = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      session_name: 'review',
      prompt: 'ship it',
      profile: 'ops',
      tmux_session: 'demo-project',
    }),
  })

  assert.equal(createTaskResponse.status, 200)
  assert.match(createTaskResponse.headers.get('content-type') || '', /text\/event-stream/)

  const taskEvents = parseSseTranscript(await createTaskResponse.text())
  assert.deepEqual(taskEvents.map((event) => event.event), ['start', 'output', 'done'])
  const taskId = taskEvents[0].data.taskId
  assert.equal(taskEvents[0].data.session_name, 'review')
  assert.equal(taskEvents[0].data.prompt, 'ship it')
  assert.ok(taskEvents[0].data.createdAt)
  assert.deepEqual(taskEvents[1].data, { chunk: 'fake:ship it' })
  assert.deepEqual(taskEvents[2].data, {
    taskId,
    status: 'success',
    exitCode: 0,
  })

  const historyAfterResponse = await fetch(`http://127.0.0.1:${port}/api/tasks`, { headers })
  assert.equal(historyAfterResponse.status, 200)
  const historyAfter = await historyAfterResponse.json()
  assert.equal(historyAfter[0].id, taskId)
  assert.equal(historyAfter[0].session_name, 'review')
  assert.equal(historyAfter[0].tmux_session, 'demo-project')
  assert.equal(historyAfter[0].status, 'success')
  assert.equal(historyAfter[0].output, 'fake:ship it')
  assert.equal(historyAfter[0].error, '')
  assert.equal(historyAfter[0].source, 'web')
  assert.ok(historyAfter[0].completedAt)

  const deleteTaskResponse = await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}`, {
    method: 'DELETE',
    headers,
  })
  assert.equal(deleteTaskResponse.status, 200)
  assert.deepEqual(await deleteTaskResponse.json(), { ok: true })

  const historyAfterDeleteResponse = await fetch(`http://127.0.0.1:${port}/api/tasks`, { headers })
  const historyAfterDelete = await historyAfterDeleteResponse.json()
  assert.equal(historyAfterDelete.some((task) => task.id === taskId), false)

  const persistedTasks = JSON.parse(readFileSync(join(dataDir, 'tasks.json'), 'utf8'))
  assert.equal(persistedTasks.some((task) => task.id === taskId), false)
})

test('rust nexus-server keeps tasks running after the SSE client disconnects', async (t) => {
  ensureRustServerBuilt()

  const projectRoot = createProjectFixture()
  const dataDir = mkdtempSync(join(tmpdir(), 'nexus-rust-server-task-disconnect-data-'))
  const port = await getFreePort()
  const password = 'task-disconnect-password'
  const passwordHash = bcrypt.hashSync(password, 8)
  const { child } = spawnRustServer({
    NEXUS_PROJECT_ROOT: projectRoot,
    NEXUS_DATA_DIR: dataDir,
    HOST: '127.0.0.1',
    PORT: String(port),
    JWT_SECRET: 'rust-server-secret',
    ACC_PASSWORD_HASH: passwordHash,
    NEXUS_TASK_RUNNER_RUST_EXECUTABLE: process.execPath,
    NEXUS_TASK_RUNNER_RUST_ARGS: JSON.stringify([TASK_FIXTURE]),
    NEXUS_SESSION_MANAGEMENT_RUST_EXECUTABLE: process.execPath,
    NEXUS_SESSION_MANAGEMENT_RUST_ARGS: JSON.stringify([SESSION_MANAGEMENT_FIXTURE]),
    FAKE_TASK_RUNTIME_DELAY_MS: '200',
  })

  t.after(async () => {
    await stopChild(child)
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  await waitForHealthyHttp(port, child)

  const { token } = await login(port, password)
  const headers = { Authorization: `Bearer ${token}` }
  const jsonHeaders = {
    ...headers,
    'Content-Type': 'application/json',
  }

  const createTaskResponse = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      session_name: 'review',
      prompt: 'keep running',
      tmux_session: 'demo-project',
    }),
  })

  assert.equal(createTaskResponse.status, 200)
  assert.match(createTaskResponse.headers.get('content-type') || '', /text\/event-stream/)
  await createTaskResponse.body?.cancel()
  await delay(50)

  let sawRunning = false
  const completedTask = await waitFor(async () => {
    const historyResponse = await fetch(`http://127.0.0.1:${port}/api/tasks`, { headers })
    assert.equal(historyResponse.status, 200)
    const history = await historyResponse.json()
    const task = history.find((item) => item.prompt === 'keep running')
    if (!task) return false
    if (task.status === 'running') {
      sawRunning = true
      return false
    }
    if (task.status === 'success') {
      return task
    }
    throw new Error(`task ended unexpectedly: ${JSON.stringify(task)}`)
  }, 5000)

  assert.equal(sawRunning, true)
  assert.equal(completedTask.session_name, 'review')
  assert.equal(completedTask.status, 'success')
  assert.equal(completedTask.output, 'fake:keep running')
  assert.equal(completedTask.error, '')
})

test('rust nexus-server proxies session and codex history routes', async (t) => {
  ensureRustServerBuilt()

  const projectRoot = createProjectFixture()
  const port = await getFreePort()
  const password = 'session-history-password'
  const passwordHash = bcrypt.hashSync(password, 8)
  const { child } = spawnRustServer({
    NEXUS_PROJECT_ROOT: projectRoot,
    HOST: '127.0.0.1',
    PORT: String(port),
    JWT_SECRET: 'rust-server-secret',
    ACC_PASSWORD_HASH: passwordHash,
    NEXUS_SESSION_MANAGEMENT_RUST_EXECUTABLE: process.execPath,
    NEXUS_SESSION_MANAGEMENT_RUST_ARGS: JSON.stringify([SESSION_MANAGEMENT_FIXTURE]),
  })

  t.after(async () => {
    await stopChild(child)
    rmSync(projectRoot, { recursive: true, force: true })
  })

  await waitForHealthyHttp(port, child)

  const { token } = await login(port, password)
  const headers = { Authorization: `Bearer ${token}` }

  const tmuxSessionsResponse = await fetch(`http://127.0.0.1:${port}/api/tmux-sessions`, { headers })
  const projectsResponse = await fetch(`http://127.0.0.1:${port}/api/projects`, { headers })
  const sessionCwdResponse = await fetch(`http://127.0.0.1:${port}/api/session-cwd?session=demo-project`, { headers })
  const channelsResponse = await fetch(`http://127.0.0.1:${port}/api/projects/demo-project/channels`, { headers })
  const activateProjectResponse = await fetch(`http://127.0.0.1:${port}/api/projects/demo-project/activate`, {
    method: 'POST',
    headers,
  })
  const sessionWindowsResponse = await fetch(`http://127.0.0.1:${port}/api/sessions?session=demo-project`, { headers })
  const codexSessionsResponse = await fetch(`http://127.0.0.1:${port}/api/codex-sessions?project=demo-project&limit=10&cursor=0`, { headers })
  const codexDetailResponse = await fetch(`http://127.0.0.1:${port}/api/codex-sessions/session-1/detail?project=demo-project`, { headers })
  const codexResumeResponse = await fetch(`http://127.0.0.1:${port}/api/codex-sessions/session-1/resume?project=demo-project`, {
    method: 'POST',
    headers,
  })
  const codexDeleteResponse = await fetch(`http://127.0.0.1:${port}/api/codex-sessions/session-1?project=demo-project`, {
    method: 'DELETE',
    headers,
  })

  assert.equal(tmuxSessionsResponse.status, 200)
  assert.deepEqual(await tmuxSessionsResponse.json(), [
    { name: 'nexus-preview-rust', windows: 1, attached: true },
    { name: 'demo-project', windows: 2, attached: false },
  ])

  assert.equal(projectsResponse.status, 200)
  assert.deepEqual(await projectsResponse.json(), [
    { name: 'demo-project', path: '/workspace/demo', active: false, channelCount: 2 },
    { name: 'nexus-preview-rust', path: '/workspace', active: true, channelCount: 1 },
  ])

  assert.equal(sessionCwdResponse.status, 200)
  assert.deepEqual(await sessionCwdResponse.json(), {
    cwd: '/workspace/demo',
    relative: 'demo',
  })

  assert.equal(channelsResponse.status, 200)
  assert.deepEqual(await channelsResponse.json(), {
    project: 'demo-project',
    channels: [
      { index: 2, name: 'review', active: false, cwd: '/workspace/demo' },
      { index: 1, name: 'shell', active: true, cwd: '/workspace' },
    ],
  })

  assert.equal(activateProjectResponse.status, 200)
  assert.deepEqual(await activateProjectResponse.json(), {
    active: true,
    project: 'demo-project',
    lastChannel: 4,
  })

  assert.equal(sessionWindowsResponse.status, 200)
  assert.deepEqual(await sessionWindowsResponse.json(), {
    session: 'demo-project',
    windows: [
      { index: 0, name: 'shell', active: true },
      { index: 1, name: 'notes', active: false },
    ],
  })

  assert.equal(codexSessionsResponse.status, 200)
  assert.deepEqual(await codexSessionsResponse.json(), {
    scope: {
      project: 'demo-project',
      path: '/workspace/demo',
      repoRoot: '/workspace/demo',
      summary: 'repo root: /workspace/demo',
    },
    items: [
      {
        id: 'session-1',
        title: 'Fix bug',
        updatedAt: '2026-04-14T12:00:00.000Z',
        cwd: '/workspace/demo',
        attributionKind: 'repo-root',
      },
    ],
    nextCursor: null,
    warning: null,
  })

  assert.equal(codexDetailResponse.status, 200)
  assert.deepEqual(await codexDetailResponse.json(), {
    id: 'session-1',
    title: 'Fix bug',
    updatedAt: '2026-04-14T12:00:00.000Z',
    startedAt: '2026-04-14T11:59:00.000Z',
    cwd: '/workspace/demo',
    attributionKind: 'repo-root',
    source: 'cli',
    originator: 'codex_cli_rs',
    cliVersion: '0.117.0',
    modelProvider: 'openai',
  })

  assert.equal(codexResumeResponse.status, 200)
  assert.deepEqual(await codexResumeResponse.json(), {
    ok: true,
    project: 'demo-project',
    channelIndex: 7,
    channelName: 'codex-history',
    sessionId: 'session-1',
  })

  assert.equal(codexDeleteResponse.status, 200)
  assert.deepEqual(await codexDeleteResponse.json(), {
    ok: true,
    sessionId: 'session-1',
    closedWindowIndexes: [7],
  })
})

test('rust nexus-server proxies session write routes with basic validation', async (t) => {
  ensureRustServerBuilt()

  const projectRoot = createProjectFixture()
  const port = await getFreePort()
  const password = 'session-write-password'
  const passwordHash = bcrypt.hashSync(password, 8)
  const { child } = spawnRustServer({
    NEXUS_PROJECT_ROOT: projectRoot,
    HOST: '127.0.0.1',
    PORT: String(port),
    JWT_SECRET: 'rust-server-secret',
    ACC_PASSWORD_HASH: passwordHash,
    NEXUS_SESSION_MANAGEMENT_RUST_EXECUTABLE: process.execPath,
    NEXUS_SESSION_MANAGEMENT_RUST_ARGS: JSON.stringify([SESSION_MANAGEMENT_FIXTURE]),
  })

  t.after(async () => {
    await stopChild(child)
    rmSync(projectRoot, { recursive: true, force: true })
  })

  await waitForHealthyHttp(port, child)

  const { token } = await login(port, password)
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }

  const invalidProjectRenameResponse = await fetch(`http://127.0.0.1:${port}/api/projects/demo-project/rename`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: '...' }),
  })
  const projectRenameResponse = await fetch(`http://127.0.0.1:${port}/api/projects/demo-project/rename`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'demo.project_2' }),
  })
  const attachSessionResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/1/attach?session=demo-project`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  const invalidSessionRenameResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/1/rename?session=demo-project`, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  })
  const renameSessionResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/1/rename?session=demo-project`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'notes 2' }),
  })

  assert.equal(invalidProjectRenameResponse.status, 400)
  assert.deepEqual(await invalidProjectRenameResponse.json(), { error: 'invalid name format' })

  assert.equal(projectRenameResponse.status, 200)
  assert.deepEqual(await projectRenameResponse.json(), {
    ok: true,
    oldName: 'demo-project',
    newName: 'demoproject_2',
  })

  assert.equal(attachSessionResponse.status, 200)
  assert.deepEqual(await attachSessionResponse.json(), { ok: true })

  assert.equal(invalidSessionRenameResponse.status, 400)
  assert.deepEqual(await invalidSessionRenameResponse.json(), { error: 'name required' })

  assert.equal(renameSessionResponse.status, 200)
  assert.deepEqual(await renameSessionResponse.json(), {
    ok: true,
    name: 'notes-2',
  })
})

test('rust nexus-server sends structured launch plans for native codex project creation', async (t) => {
  ensureRustServerBuilt()

  const projectRoot = createProjectFixture()
  const baseDir = mkdtempSync(join(tmpdir(), 'nexus-native-server-launch-plan-'))
  const requestLog = join(baseDir, 'session-requests.jsonl')
  const dataDir = join(baseDir, 'data')
  const port = await getFreePort()
  const password = 'native-server-launch-plan-password'
  const passwordHash = bcrypt.hashSync(password, 8)
  const { child } = spawnRustServer({
    NEXUS_PROJECT_ROOT: projectRoot,
    HOST: '127.0.0.1',
    PORT: String(port),
    JWT_SECRET: 'rust-server-secret',
    ACC_PASSWORD_HASH: passwordHash,
    WORKSPACE_ROOT: '/workspace',
    HTTPS_PROXY: 'http://proxy.local',
    HTTP_PROXY: '',
    ALL_PROXY: '',
    http_proxy: '',
    https_proxy: '',
    NEXUS_DATA_DIR: dataDir,
    NEXUS_SESSION_BACKEND: 'native',
    NEXUS_SESSION_MANAGEMENT_RUST_EXECUTABLE: process.execPath,
    NEXUS_SESSION_MANAGEMENT_RUST_ARGS: JSON.stringify([SESSION_MANAGEMENT_FIXTURE]),
    FAKE_SESSION_MANAGEMENT_REQUEST_LOG: requestLog,
  })

  t.after(async () => {
    await stopChild(child)
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(baseDir, { recursive: true, force: true })
  })

  await waitForHealthyHttp(port, child)

  const { token } = await login(port, password)
  const response = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      path: 'demo',
      shell_type: 'codex',
      profile: 'work',
    }),
  })

  assert.equal(response.status, 200)

  const requests = readFileSync(requestLog, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const createProject = requests.find((request) => request.method === 'createProject')
  assert.ok(createProject)
  assert.equal(createProject.params.cwd, '/workspace/demo')
  assert.match(createProject.params.shellCmd, /nexus-run-codex\.sh/)
  assert.deepEqual(createProject.params.launchPlan, {
    program: 'bash',
    args: [
      join(projectRoot, 'nexus-run-codex.sh'),
      'work',
      '/workspace/demo',
      '',
    ],
    env: {
      HTTPS_PROXY: 'http://proxy.local',
    },
    cwd: '/workspace/demo',
  })
})

test('rust nexus-server sends structured launch plans for native ordinary shell project creation', async (t) => {
  ensureRustServerBuilt()

  const projectRoot = createProjectFixture()
  const baseDir = mkdtempSync(join(tmpdir(), 'nexus-native-shell-plan-'))
  const requestLog = join(baseDir, 'session-requests.jsonl')
  const dataDir = join(baseDir, 'data')
  const port = await getFreePort()
  const password = 'native-shell-plan-password'
  const passwordHash = bcrypt.hashSync(password, 8)
  const { child } = spawnRustServer({
    NEXUS_PROJECT_ROOT: projectRoot,
    HOST: '127.0.0.1',
    PORT: String(port),
    JWT_SECRET: 'rust-server-secret',
    ACC_PASSWORD_HASH: passwordHash,
    WORKSPACE_ROOT: '/workspace',
    SHELL: '/bin/sh',
    HTTPS_PROXY: 'http://proxy.local',
    HTTP_PROXY: '',
    ALL_PROXY: '',
    http_proxy: '',
    https_proxy: '',
    NEXUS_DATA_DIR: dataDir,
    NEXUS_SESSION_BACKEND: 'native',
    NEXUS_SESSION_MANAGEMENT_RUST_EXECUTABLE: process.execPath,
    NEXUS_SESSION_MANAGEMENT_RUST_ARGS: JSON.stringify([SESSION_MANAGEMENT_FIXTURE]),
    FAKE_SESSION_MANAGEMENT_REQUEST_LOG: requestLog,
  })

  t.after(async () => {
    await stopChild(child)
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(baseDir, { recursive: true, force: true })
  })

  await waitForHealthyHttp(port, child)

  const { token } = await login(port, password)
  const response = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      path: 'demo',
      shell_type: 'bash',
    }),
  })

  assert.equal(response.status, 200)

  const requests = readFileSync(requestLog, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const createProject = requests.find((request) => request.method === 'createProject')
  assert.ok(createProject)
  assert.equal(createProject.params.cwd, '/workspace/demo')
  assert.deepEqual(createProject.params.launchPlan, {
    program: '/bin/sh',
    args: ['-i'],
    env: {
      HTTPS_PROXY: 'http://proxy.local',
    },
    cwd: '/workspace/demo',
  })
})

test('rust nexus-server plans project and channel creation through the real rust session runtime', async (t) => {
  ensureRustServerBuilt()

  const projectRoot = createProjectFixture()
  const tmuxFixture = createShellPlanningTmuxFixture()
  const port = await getFreePort()
  const password = 'session-create-password'
  const passwordHash = bcrypt.hashSync(password, 8)
  const { child } = spawnRustServer({
    NEXUS_PROJECT_ROOT: projectRoot,
    HOST: '127.0.0.1',
    PORT: String(port),
    JWT_SECRET: 'rust-server-secret',
    ACC_PASSWORD_HASH: passwordHash,
    TMUX_SESSION: 'nexus',
    WORKSPACE_ROOT: '/workspace',
    HTTPS_PROXY: 'http://proxy.local',
    HTTP_PROXY: '',
    ALL_PROXY: '',
    http_proxy: '',
    https_proxy: '',
    HOME: tmuxFixture.homeDir,
    PATH: `${tmuxFixture.baseDir}:${process.env.PATH || ''}`,
    NEXUS_DATA_DIR: tmuxFixture.dataDir,
    NEXUS_SESSION_MANAGEMENT_RUST_EXECUTABLE: RUST_SESSION_RUNTIME_BINARY,
    NEXUS_SESSION_MANAGEMENT_RUST_ARGS: JSON.stringify([]),
  })

  t.after(async () => {
    await stopChild(child)
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(tmuxFixture.baseDir, { recursive: true, force: true })
  })

  await waitForHealthyHttp(port, child)

  const { token } = await login(port, password)
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }

  const missingPathResponse = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  })
  const createProjectResponse = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      path: 'demo',
      shell_type: 'codex',
      profile: 'work',
    }),
  })
  const createChannelResponse = await fetch(`http://127.0.0.1:${port}/api/projects/demo-project/channels`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      path: 'apps/demo',
      shell_type: 'bash',
      profile: 'review',
    }),
  })

  assert.equal(missingPathResponse.status, 400)
  assert.deepEqual(await missingPathResponse.json(), { error: 'path required' })

  assert.equal(createProjectResponse.status, 200)
  assert.deepEqual(await createProjectResponse.json(), {
    name: 'workspace-demo-2',
    path: '/workspace/demo',
    shell_type: 'codex',
    profile: 'work',
  })

  assert.equal(createChannelResponse.status, 200)
  assert.deepEqual(await createChannelResponse.json(), {
    name: 'review-1',
    cwd: '/workspace/apps/demo',
    shell_type: 'bash',
    profile: 'review',
    project: 'demo-project',
  })

  const defaults = JSON.parse(readFileSync(join(tmuxFixture.dataDir, 'project-shell-defaults.json'), 'utf8'))
  assert.deepEqual(defaults['/workspace/demo'].shell_type, 'codex')
  assert.deepEqual(defaults['/workspace/demo'].profile, 'work')
  assert.deepEqual(defaults['/workspace/apps/demo'].shell_type, 'bash')
  assert.equal(defaults['/workspace/apps/demo'].profile, null)

  const log = readFileSync(tmuxFixture.logFile, 'utf8')
  assert.match(log, /list-sessions\|-F #\{session_name\}/)
  assert.match(log, /new-session\|-d -s workspace-demo-2 -n demo-work -c \/workspace\/demo export HTTPS_PROXY="http:\/\/proxy\.local"; unset HOST; bash ".*\/nexus-run-codex\.sh" "work" "\/workspace\/demo" ""/)
  assert.match(log, /set-environment\|-t workspace-demo-2 NEXUS_CWD \/workspace\/demo/)
  assert.match(log, /set-environment\|-t workspace-demo-2 HTTPS_PROXY http:\/\/proxy\.local/)
  assert.match(log, /set-environment\|-t workspace-demo-2 NEXUS_OWNER_SESSION nexus/)
  assert.match(log, /list-windows\|-t demo-project -F #\{window_index\}\|#\{window_name\}\|#\{window_active\}\|#\{pane_current_path\}/)
  assert.match(log, /new-window\|-t demo-project -c \/workspace\/apps\/demo -n review-1 export HTTPS_PROXY="http:\/\/proxy\.local"; unset HOST; exec zsh -i/)
  assert.match(log, /set-environment\|-t demo-project HTTPS_PROXY http:\/\/proxy\.local/)
  assert.match(log, /set-environment\|-t demo-project NEXUS_OWNER_SESSION nexus/)
})

test('rust nexus-server routes window launch through the real rust runtimes', async (t) => {
  ensureRustServerBuilt()

  const projectRoot = createProjectFixture()
  const tmuxFixture = createWindowLaunchTmuxFixture()
  const port = await getFreePort()
  const password = 'window-launch-password'
  const passwordHash = bcrypt.hashSync(password, 8)
  const { child } = spawnRustServer({
    NEXUS_PROJECT_ROOT: projectRoot,
    HOST: '127.0.0.1',
    PORT: String(port),
    JWT_SECRET: 'rust-server-secret',
    ACC_PASSWORD_HASH: passwordHash,
    TMUX_SESSION: 'nexus',
    WORKSPACE_ROOT: '/workspace',
    HTTPS_PROXY: 'http://proxy.local',
    HTTP_PROXY: '',
    ALL_PROXY: '',
    http_proxy: '',
    https_proxy: '',
    PATH: `${tmuxFixture.baseDir}:${process.env.PATH || ''}`,
    NEXUS_DATA_DIR: tmuxFixture.dataDir,
    NEXUS_WINDOW_LAUNCH_RUST_EXECUTABLE: RUST_WINDOW_LAUNCH_RUNTIME_BINARY,
    NEXUS_WINDOW_LAUNCH_RUST_ARGS: JSON.stringify([]),
    NEXUS_SESSION_MANAGEMENT_RUST_EXECUTABLE: RUST_SESSION_RUNTIME_BINARY,
    NEXUS_SESSION_MANAGEMENT_RUST_ARGS: JSON.stringify([]),
  })

  t.after(async () => {
    await stopChild(child)
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(tmuxFixture.baseDir, { recursive: true, force: true })
  })

  await waitForHealthyHttp(port, child)

  const { token } = await login(port, password)
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }

  const launchWindowResponse = await fetch(`http://127.0.0.1:${port}/api/windows?session=demo-project`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      rel_path: 'apps/demo',
      shell_type: 'codex',
      profile: 'work',
    }),
  })
  const launchWindowFromSessionCwdResponse = await fetch(`http://127.0.0.1:${port}/api/windows?session=demo-project`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      shell_type: 'codex',
      profile: 'work',
    }),
  })
  const missingPathResponse = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      session: 'demo-project',
    }),
  })
  const createSessionWindowResponse = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      rel_path: 'docs',
      shell_type: 'bash',
      profile: 'review',
      session: 'demo-project',
    }),
  })

  assert.equal(launchWindowResponse.status, 200)
  assert.deepEqual(await launchWindowResponse.json(), {
    name: 'workspace-apps-demo',
    cwd: '/workspace/apps/demo',
    shell_type: 'codex',
    profile: 'work',
    session: 'demo-project',
  })

  assert.equal(launchWindowFromSessionCwdResponse.status, 200)
  assert.deepEqual(await launchWindowFromSessionCwdResponse.json(), {
    name: 'workspace-apps-demo',
    cwd: '/workspace/apps/demo',
    shell_type: 'codex',
    profile: 'work',
    session: 'demo-project',
  })

  assert.equal(missingPathResponse.status, 400)
  assert.deepEqual(await missingPathResponse.json(), { error: 'rel_path required' })

  assert.equal(createSessionWindowResponse.status, 200)
  assert.deepEqual(await createSessionWindowResponse.json(), {
    name: 'workspace-docs',
    cwd: '/workspace/docs',
    shell_type: 'bash',
    profile: 'review',
    session: 'demo-project',
  })

  const defaults = JSON.parse(readFileSync(join(tmuxFixture.dataDir, 'project-shell-defaults.json'), 'utf8'))
  assert.deepEqual(defaults['/workspace/apps/demo'].shell_type, 'codex')
  assert.deepEqual(defaults['/workspace/apps/demo'].profile, 'work')
  assert.deepEqual(defaults['/workspace/docs'].shell_type, 'bash')
  assert.equal(defaults['/workspace/docs'].profile, null)

  const log = readFileSync(tmuxFixture.logFile, 'utf8')
  assert.equal(
    log
      .split('\n')
      .filter((line) => line === 'set-environment|-t demo-project NEXUS_CWD /workspace/apps/demo')
      .length,
    1,
  )
  assert.match(log, /show-environment\|-t demo-project NEXUS_CWD/)
  assert.match(log, /set-environment\|-t demo-project HTTPS_PROXY http:\/\/proxy\.local/)
  assert.match(log, /new-window\|-t demo-project -c \/workspace\/apps\/demo -n workspace-apps-demo export HTTPS_PROXY="http:\/\/proxy\.local"; unset HOST; bash ".*\/nexus-run-codex\.sh" "work" "\/workspace\/apps\/demo" ""/)
  assert.match(log, /new-window\|-t demo-project -c \/workspace\/docs -n workspace-docs export HTTPS_PROXY="http:\/\/proxy\.local"; unset HOST; exec zsh -i/)
})

test('rust nexus-server resumes codex history sessions through the real rust session runtime', async (t) => {
  ensureRustServerBuilt()

  const projectRoot = createProjectFixture()
  const tmuxFixture = createCodexResumeTmuxFixture()
  const codexHome = join(tmuxFixture.homeDir, '.codex')
  writeJsonl(join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({
      id: 'session-1',
      thread_name: 'Fix bug',
      updated_at: '2026-04-14T12:00:00.000Z',
    }),
  ])
  createCodexSessionFile(codexHome, {
    id: 'session-1',
    datePath: '2026/04/14',
    cwd: '/workspace/demo',
    metaFields: {
      originator: 'codex_cli_rs',
      cli_version: '0.117.0',
      source: 'cli',
      model_provider: 'openai',
    },
  })
  writeFileSync(
    join(tmuxFixture.dataDir, 'project-shell-defaults.json'),
    `${JSON.stringify({
      '/workspace/demo': {
        shell_type: 'codex',
        profile: 'daily',
        updated_at: '2026-04-18T00:00:00.000Z',
      },
    }, null, 2)}\n`,
    'utf8',
  )

  const port = await getFreePort()
  const password = 'codex-resume-password'
  const passwordHash = bcrypt.hashSync(password, 8)
  const { child } = spawnRustServer({
    NEXUS_PROJECT_ROOT: projectRoot,
    HOST: '127.0.0.1',
    PORT: String(port),
    JWT_SECRET: 'rust-server-secret',
    ACC_PASSWORD_HASH: passwordHash,
    WORKSPACE_ROOT: '/workspace',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    http_proxy: '',
    https_proxy: '',
    HOME: tmuxFixture.homeDir,
    PATH: `${tmuxFixture.baseDir}:${process.env.PATH || ''}`,
    NEXUS_DATA_DIR: tmuxFixture.dataDir,
    NEXUS_SESSION_MANAGEMENT_RUST_EXECUTABLE: RUST_SESSION_RUNTIME_BINARY,
    NEXUS_SESSION_MANAGEMENT_RUST_ARGS: JSON.stringify([]),
  })

  t.after(async () => {
    await stopChild(child)
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(tmuxFixture.baseDir, { recursive: true, force: true })
  })

  await waitForHealthyHttp(port, child)

  const { token } = await login(port, password)
  const legacyResponse = await fetch(`http://127.0.0.1:${port}/api/codex-sessions/session-1/resume?project=demo-project`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  const systemDefaultResponse = await fetch(`http://127.0.0.1:${port}/api/codex-sessions/session-1/resume?project=demo-project`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      project: 'demo-project',
      profile: '',
    }),
  })
  const explicitProfileResponse = await fetch(`http://127.0.0.1:${port}/api/codex-sessions/session-1/resume?project=demo-project`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      project: 'demo-project',
      profile: 'focus',
    }),
  })

  assert.equal(legacyResponse.status, 200)
  assert.deepEqual(await legacyResponse.json(), {
    ok: true,
    project: 'demo-project',
    channelIndex: 7,
    channelName: 'codex-history',
    sessionId: 'session-1',
  })
  assert.equal(systemDefaultResponse.status, 200)
  assert.deepEqual(await systemDefaultResponse.json(), {
    ok: true,
    project: 'demo-project',
    channelIndex: 7,
    channelName: 'codex-history',
    sessionId: 'session-1',
  })
  assert.equal(explicitProfileResponse.status, 200)
  assert.deepEqual(await explicitProfileResponse.json(), {
    ok: true,
    project: 'demo-project',
    channelIndex: 7,
    channelName: 'codex-history',
    sessionId: 'session-1',
  })

  const log = readFileSync(tmuxFixture.logFile, 'utf8')
  assert.match(log, /has-session\|-t demo-project/)
  assert.match(log, /show-environment\|-t demo-project NEXUS_CWD/)
  assert.match(
    log,
    /new-window\|-P -F #\{window_id\}\|#\{window_index\}\|#\{window_name\} -t demo-project -c \/workspace\/demo -n codex-history unset HOST; bash ".*\/nexus-run-codex\.sh" "daily" "\/workspace\/demo" "session-1"/,
  )
  assert.match(
    log,
    /new-window\|-P -F #\{window_id\}\|#\{window_index\}\|#\{window_name\} -t demo-project -c \/workspace\/demo -n codex-history unset HOST; bash ".*\/nexus-run-codex\.sh" "" "\/workspace\/demo" "session-1"/,
  )
  assert.match(
    log,
    /new-window\|-P -F #\{window_id\}\|#\{window_index\}\|#\{window_name\} -t demo-project -c \/workspace\/demo -n codex-history unset HOST; bash ".*\/nexus-run-codex\.sh" "focus" "\/workspace\/demo" "session-1"/,
  )
  assert.match(log, /set-option\|-w -t @9 @nexus_codex_resume_session_id session-1/)
  assert.match(log, /select-window\|-t demo-project:7/)
  assert.match(log, /set-environment\|-t demo-project NEXUS_LAST_CHANNEL 7/)
})

test('rust nexus-server wires session delete routes through the real rust session runtime', async (t) => {
  ensureRustServerBuilt()

  const projectRoot = createProjectFixture()
  const tmuxFixture = createDeleteTmuxFixture()
  const runtimeDir = join(tmuxFixture.dataDir, 'codex-runtime')
  mkdirSync(join(runtimeDir, '-7'), { recursive: true })
  mkdirSync(join(runtimeDir, '-3'), { recursive: true })
  mkdirSync(join(runtimeDir, '-4'), { recursive: true })
  writeFileSync(join(runtimeDir, '-7', 'marker.txt'), 'runtime', 'utf8')
  writeFileSync(join(runtimeDir, '-3', 'marker.txt'), 'runtime', 'utf8')
  writeFileSync(join(runtimeDir, '-4', 'marker.txt'), 'runtime', 'utf8')
  const port = await getFreePort()
  const password = 'session-delete-password'
  const passwordHash = bcrypt.hashSync(password, 8)
  const { child } = spawnRustServer({
    NEXUS_PROJECT_ROOT: projectRoot,
    HOST: '127.0.0.1',
    PORT: String(port),
    JWT_SECRET: 'rust-server-secret',
    ACC_PASSWORD_HASH: passwordHash,
    HOME: tmuxFixture.homeDir,
    PATH: `${tmuxFixture.baseDir}:${process.env.PATH || ''}`,
    NEXUS_DATA_DIR: tmuxFixture.dataDir,
    NEXUS_SESSION_MANAGEMENT_RUST_EXECUTABLE: RUST_SESSION_RUNTIME_BINARY,
    NEXUS_SESSION_MANAGEMENT_RUST_ARGS: JSON.stringify([]),
  })

  t.after(async () => {
    await stopChild(child)
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(tmuxFixture.baseDir, { recursive: true, force: true })
  })

  await waitForHealthyHttp(port, child)

  const { token } = await login(port, password)
  const deleteSessionResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/7?session=solo-project`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  const deleteProjectResponse = await fetch(`http://127.0.0.1:${port}/api/projects/demo-project`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })

  assert.equal(deleteSessionResponse.status, 200)
  assert.deepEqual(await deleteSessionResponse.json(), { ok: true })
  assert.equal(deleteProjectResponse.status, 200)
  assert.deepEqual(await deleteProjectResponse.json(), { ok: true })

  assert.equal(existsSync(join(runtimeDir, '-7')), false)
  assert.equal(existsSync(join(runtimeDir, '-3')), false)
  assert.equal(existsSync(join(runtimeDir, '-4')), false)

  const log = readFileSync(tmuxFixture.logFile, 'utf8')
  assert.match(log, /display-message\|-t solo-project:7 -p #\{window_id\}/)
  assert.match(log, /list-windows\|-t solo-project -F #\{window_index\}/)
  assert.match(log, /new-window\|-t solo-project -n shell unset HOST; exec zsh -i/)
  assert.match(log, /kill-window\|-t solo-project:7/)
  assert.match(log, /list-windows\|-t demo-project -F #\{window_id\}/)
  assert.match(log, /kill-session\|-t demo-project/)
})
