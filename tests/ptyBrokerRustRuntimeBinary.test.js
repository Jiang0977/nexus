import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'

import { createPtyBrokerRustClient } from './helpers/ptyBrokerRustClient.js'
import { createSessionManagementRustClient } from './helpers/sessionManagementRustClient.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME = join(
  ROOT,
  'rust-runtime',
  'target',
  'release',
  process.platform === 'win32' ? 'nexus-pty-runtime.exe' : 'nexus-pty-runtime',
)
const SESSION_RUNTIME = join(
  ROOT,
  'rust-runtime',
  'target',
  'release',
  process.platform === 'win32' ? 'nexus-session-runtime.exe' : 'nexus-session-runtime',
)
let buildChecked = false
let sessionBuildChecked = false

function ensureBuilt() {
  if (buildChecked && existsSync(RUNTIME)) return
  const build = spawnSync('npm', ['run', 'build:rust-pty-runtime'], {
    cwd: ROOT,
    encoding: 'utf8',
  })

  assert.equal(build.status, 0, build.stderr || build.stdout)
  assert.equal(existsSync(RUNTIME), true)
  buildChecked = true
}

function ensureSessionRuntimeBuilt() {
  if (sessionBuildChecked && existsSync(SESSION_RUNTIME)) return
  const build = spawnSync('npm', ['run', 'build:rust-session-runtime'], {
    cwd: ROOT,
    encoding: 'utf8',
  })

  assert.equal(build.status, 0, build.stderr || build.stdout)
  assert.equal(existsSync(SESSION_RUNTIME), true)
  sessionBuildChecked = true
}

function createFakeTmuxBin() {
  const baseDir = mkdtempSync(join(tmpdir(), 'nexus-fake-rust-tmux-'))
  const logFile = join(baseDir, 'tmux.log')
  const tmuxPath = join(baseDir, 'tmux')
  writeFileSync(logFile, '', 'utf8')
  writeFileSync(tmuxPath, `#!/bin/sh
set -eu
cmd="$1"
shift || true
printf '%s|%s\\n' "$cmd" "$*" >> ${JSON.stringify(logFile)}
case "$cmd" in
  has-session)
    exit 0
    ;;
  list-windows)
    printf '0\n3\n'
    exit 0
    ;;
  attach-session|new-session|select-window|kill-session)
    while IFS= read -r line; do
      printf '%s\n' "$line"
    done
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
`, { mode: 0o755 })
  return { baseDir, logFile }
}

function resolveSystemTmux() {
  const which = spawnSync('sh', ['-lc', 'command -v tmux'], {
    encoding: 'utf8',
  })

  if (which.status !== 0) return ''
  return which.stdout.trim()
}

function createRealTmuxBin(realTmux) {
  const baseDir = mkdtempSync(join(tmpdir(), 'nexus-real-rust-tmux-'))
  const tmuxPath = join(baseDir, 'tmux')
  const socketName = `nexus-pty-runtime-${process.pid}-${Date.now()}`
  writeFileSync(tmuxPath, `#!/bin/sh
set -eu
exec "${realTmux}" -L "${socketName}" -f /dev/null "$@"
`, { mode: 0o755 })
  return { baseDir, tmuxPath }
}

function tmuxTestEnv(extra = {}) {
  return {
    ...process.env,
    NEXUS_SESSION_BACKEND: '',
    ...extra,
  }
}

function listRealTmuxSessions(tmuxPath, env) {
  const result = spawnSync(tmuxPath, ['list-sessions', '-F', '#{session_name}|#{session_attached}'], {
    encoding: 'utf8',
    env,
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
}

function latestNativeProcessInstance(dbPath, projectName, channelIndex) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return db
      .prepare(`
        SELECT project_name, channel_index, status, os_pid, platform_handle, started_at, ended_at, exit_code, start_fingerprint
        FROM process_instances
        WHERE project_name = ? AND channel_index = ?
        ORDER BY id DESC
        LIMIT 1
      `)
      .get(projectName, channelIndex)
  } catch (error) {
    if (String(error?.message || '').includes('database is locked')) return null
    throw error
  } finally {
    db.close()
  }
}

function nativeProcessInstanceCount(dbPath, projectName, channelIndex) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM process_instances
        WHERE project_name = ? AND channel_index = ?
      `)
      .get(projectName, channelIndex).count
  } catch (error) {
    if (String(error?.message || '').includes('database is locked')) return 0
    throw error
  } finally {
    db.close()
  }
}

function insertNativeProcessInstance(dbPath, {
  projectName,
  channelIndex,
  status = 'running',
  osPid = null,
  startedAt = '12345',
  startFingerprint = 'seeded',
}) {
  const db = new DatabaseSync(dbPath)
  try {
    db
      .prepare(`
        INSERT INTO process_instances
          (project_name, channel_index, status, os_pid, started_at, start_fingerprint)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(projectName, channelIndex, status, osPid, startedAt, startFingerprint)
  } finally {
    db.close()
  }
}

function processAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false
  if (process.platform !== 'win32') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const state = stat.split(' ')[2]
      if (state === 'Z') return false
    } catch {}
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function spawnRawPtyRuntime(env) {
  const child = spawn(RUNTIME, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  })

  const pending = new Map()
  let requestCounter = 0
  const stdoutReader = createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  })

  stdoutReader.on('line', (line) => {
    if (!line.trim()) return
    const message = JSON.parse(line)
    if (message.kind !== 'response') return
    const handler = pending.get(message.id)
    if (!handler) return
    pending.delete(message.id)
    handler(message)
  })

  child.stderr.on('data', () => {})

  function request(method, params = {}, timeoutMs = 2000) {
    const id = `raw-pty-runtime-${++requestCounter}`
    child.stdin.write(`${JSON.stringify({ kind: 'request', id, method, params })}\n`)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`timeout:${method}`))
      }, timeoutMs)
      pending.set(id, (message) => {
        clearTimeout(timer)
        if (message.ok) {
          resolve(message.result)
          return
        }
        reject(new Error(message.error?.message || `request failed: ${method}`))
      })
    })
  }

  return {
    child,
    ready() {
      return request('ready')
    },
    attachConnection(params) {
      return request('attachConnection', params)
    },
    shutdown() {
      return request('shutdown')
    },
  }
}

test('real rust pty runtime speaks the broker contract through a fake tmux backend', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()
  const { baseDir } = createFakeTmuxBin()
  const client = createPtyBrokerRustClient({
    runtimeExecutable: RUNTIME,
    env: tmuxTestEnv({
      PATH: `${baseDir}:${process.env.PATH || ''}`,
    }),
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })

  t.after(async () => {
    await client.close()
    rmSync(baseDir, { recursive: true, force: true })
  })

  const events = []
  client.onEvent((event) => {
    events.push(event)
  })

  const ready = await client.ready()
  assert.equal(ready.ready, true)
  assert.equal(ready.source, 'nexus-pty-runtime')
  assert.equal(ready.capabilities.terminal, true)

  const attached = await client.attachConnection({
    connectionId: 'conn-1',
    session: 'main',
    windowIndex: 3,
  })
  assert.deepEqual(attached, { key: 'main:3' })

  client.handleConnectionMessage({
    connectionId: 'conn-1',
    key: 'main:3',
    rawMessage: 'pwd\n',
  })

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (events.length > 0) break
    await delay(20)
  }

  assert.ok(events.length >= 1)
  assert.equal(events[0].type, 'output')
  assert.equal(events[0].connectionId, 'conn-1')
  assert.match(events[0].data, /pwd\r?\n/)

  const snapshot = await client.getOutputSnapshot({ session: 'main', windowIndex: 3 })
  assert.equal(snapshot.connected, true)
  assert.match(snapshot.output, /pwd\r?\n/)
  assert.equal(snapshot.clients, 1)

  client.closeConnection({ connectionId: 'conn-1', key: 'main:3' })

  let status = await client.getStatus()
  for (let attempt = 0; attempt < 20 && status.runningPtys !== 0; attempt += 1) {
    await delay(20)
    status = await client.getStatus()
  }
  assert.equal(status.runningPtys, 0)
})

test('real rust pty runtime can attach to an opt-in native foreground PTY', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()
  ensureSessionRuntimeBuilt()
  const baseDir = mkdtempSync(join(tmpdir(), 'nexus-native-opt-in-'))
  const dbPath = join(baseDir, 'session.db')
  const env = {
    ...process.env,
    NEXUS_SESSION_BACKEND: 'native',
    NEXUS_NATIVE_SESSION_DB: dbPath,
    NEXUS_NATIVE_PTY_SUPERVISOR_SOCKET: '',
    NEXUS_NATIVE_PTY_PROGRAM: 'cat',
  }
  const sessionClient = createSessionManagementRustClient({
    runtimeExecutable: SESSION_RUNTIME,
    env,
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })
  const client = createPtyBrokerRustClient({
    runtimeExecutable: RUNTIME,
    env,
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })

  t.after(async () => {
    await client.close()
    await sessionClient.close()
    rmSync(baseDir, { recursive: true, force: true })
  })

  const events = []
  client.onEvent((event) => {
    events.push(event)
  })

  await sessionClient.ready()
  await sessionClient.createProject({
    sessionName: 'native-opt-in-sentinel',
    cwd: ROOT,
    initialWindowName: 'shell',
    shellCmd: 'cat',
    proxyVars: {},
  })
  insertNativeProcessInstance(dbPath, {
    projectName: 'native-opt-in-sentinel',
    channelIndex: 0,
    osPid: process.pid,
    startFingerprint: 'must-not-reconcile-opt-in-program',
  })

  await client.ready()
  assert.equal(
    latestNativeProcessInstance(dbPath, 'native-opt-in-sentinel', 0).status,
    'running',
  )
  const first = await client.attachConnection({
    connectionId: 'native-conn-1',
    session: 'native-project',
    windowIndex: 0,
  })
  assert.deepEqual(first, { key: 'native-project:0' })

  client.handleConnectionMessage({
    connectionId: 'native-conn-1',
    key: 'native-project:0',
    rawMessage: 'native one\n',
  })

  let firstOutput = ''
  for (let attempt = 0; attempt < 30; attempt += 1) {
    firstOutput = events
      .filter((event) => event.type === 'output' && event.connectionId === 'native-conn-1')
      .map((event) => event.data)
      .join('')
    if (firstOutput.includes('native one')) break
    await delay(20)
  }
  assert.match(firstOutput, /native one\r?\n/)

  const snapshot = await client.getOutputSnapshot({ session: 'native-project', windowIndex: 0 })
  assert.equal(snapshot.connected, true)
  assert.match(snapshot.output, /native one\r?\n/)
  assert.equal(snapshot.clients, 1)

  const second = await client.attachConnection({
    connectionId: 'native-conn-2',
    session: 'native-project',
    windowIndex: 0,
  })
  assert.deepEqual(second, { key: 'native-project:0' })

  let replay = ''
  for (let attempt = 0; attempt < 30; attempt += 1) {
    replay = events
      .filter((event) => event.type === 'output' && event.connectionId === 'native-conn-2')
      .map((event) => event.data)
      .join('')
    if (replay.includes('native one')) break
    await delay(20)
  }
  assert.match(replay, /native one\r?\n/)

  client.handleConnectionMessage({
    connectionId: 'native-conn-1',
    key: 'native-project:0',
    rawMessage: 'native two\n',
  })

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const conn1 = events
      .filter((event) => event.type === 'output' && event.connectionId === 'native-conn-1')
      .map((event) => event.data)
      .join('')
    const conn2 = events
      .filter((event) => event.type === 'output' && event.connectionId === 'native-conn-2')
      .map((event) => event.data)
      .join('')
    if (conn1.includes('native two') && conn2.includes('native two')) break
    await delay(20)
  }

  const conn1Output = events
    .filter((event) => event.type === 'output' && event.connectionId === 'native-conn-1')
    .map((event) => event.data)
    .join('')
  const conn2Output = events
    .filter((event) => event.type === 'output' && event.connectionId === 'native-conn-2')
    .map((event) => event.data)
    .join('')
  assert.match(conn1Output, /native two\r?\n/)
  assert.match(conn2Output, /native two\r?\n/)

  client.closeConnection({ connectionId: 'native-conn-1', key: 'native-project:0' })
  client.closeConnection({ connectionId: 'native-conn-2', key: 'native-project:0' })

  let status = await client.getStatus()
  for (let attempt = 0; attempt < 20 && status.runningPtys !== 0; attempt += 1) {
    await delay(20)
    status = await client.getStatus()
  }
  assert.equal(status.runningPtys, 0)
})

test('real rust pty runtime gives native PTYs an xterm UTF-8 environment', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()

  const baseDir = mkdtempSync(join(tmpdir(), 'nexus-native-pty-env-'))
  const scriptPath = join(baseDir, 'print-env.sh')
  writeFileSync(scriptPath, `#!/bin/sh
printf 'TERM=%s\\n' "$TERM"
printf 'COLORTERM=%s\\n' "$COLORTERM"
printf 'LANG=%s\\n' "$LANG"
printf 'LC_ALL=%s\\n' "$LC_ALL"
printf 'LC_CTYPE=%s\\n' "$LC_CTYPE"
`, { mode: 0o755 })

  const client = createPtyBrokerRustClient({
    runtimeExecutable: RUNTIME,
    env: {
      ...process.env,
      NEXUS_SESSION_BACKEND: 'native',
      NEXUS_NATIVE_PTY_SUPERVISOR_SOCKET: '',
      NEXUS_NATIVE_PTY_PROGRAM: scriptPath,
      TERM: 'dumb',
      LANG: 'C',
      LC_ALL: 'C',
      LC_CTYPE: 'C',
    },
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })

  t.after(async () => {
    await client.close()
    rmSync(baseDir, { recursive: true, force: true })
  })

  const events = []
  client.onEvent((event) => {
    events.push(event)
  })

  await client.ready()
  const attached = await client.attachConnection({
    connectionId: 'native-env-conn',
    session: 'native-env-project',
    windowIndex: 0,
  })
  assert.deepEqual(attached, { key: 'native-env-project:0' })

  let output = ''
  for (let attempt = 0; attempt < 40; attempt += 1) {
    output = events
      .filter((event) => event.type === 'output' && event.connectionId === 'native-env-conn')
      .map((event) => event.data)
      .join('')
    if (output.includes('LC_CTYPE=')) break
    await delay(20)
  }

  assert.match(output, /^TERM=xterm-256color\r?$/m)
  assert.match(output, /^COLORTERM=truecolor\r?$/m)
  assert.match(output, /^LANG=C\.UTF-8\r?$/m)
  assert.match(output, /^LC_ALL=C\.UTF-8\r?$/m)
  assert.match(output, /^LC_CTYPE=C\.UTF-8\r?$/m)
})

test('real rust pty runtime launches an opt-in native channel from the session registry', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()
  ensureSessionRuntimeBuilt()
  const baseDir = mkdtempSync(join(tmpdir(), 'nexus-native-pty-registry-'))
  const dbPath = join(baseDir, 'session.db')
  const env = {
    ...process.env,
    NEXUS_SESSION_BACKEND: 'native',
    NEXUS_NATIVE_SESSION_DB: dbPath,
    NEXUS_NATIVE_PTY_SUPERVISOR_SOCKET: '',
  }
  const sessionClient = createSessionManagementRustClient({
    runtimeExecutable: SESSION_RUNTIME,
    env,
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })
  const ptyClient = createPtyBrokerRustClient({
    runtimeExecutable: RUNTIME,
    env,
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })

  t.after(async () => {
    await ptyClient.close()
    await sessionClient.close()
    rmSync(baseDir, { recursive: true, force: true })
  })

  await sessionClient.ready()
  await sessionClient.createProject({
    sessionName: 'native-registry-project',
    cwd: ROOT,
    initialWindowName: 'shell',
    shellCmd: 'cat',
    proxyVars: {},
  })

  const events = []
  ptyClient.onEvent((event) => {
    events.push(event)
  })

  await ptyClient.ready()
  const attached = await ptyClient.attachConnection({
    connectionId: 'native-registry-conn',
    session: 'native-registry-project',
    windowIndex: 0,
  })
  assert.deepEqual(attached, { key: 'native-registry-project:0' })

  ptyClient.handleConnectionMessage({
    connectionId: 'native-registry-conn',
    key: 'native-registry-project:0',
    rawMessage: 'registry native channel\n',
  })

  let output = ''
  for (let attempt = 0; attempt < 30; attempt += 1) {
    output = events
      .filter((event) => event.type === 'output')
      .map((event) => event.data)
      .join('')
    if (output.includes('registry native channel')) break
    await delay(20)
  }
  assert.match(output, /registry native channel\r?\n/)

  const snapshot = await ptyClient.getOutputSnapshot({
    session: 'native-registry-project',
    windowIndex: 0,
  })
  assert.equal(snapshot.connected, true)
  assert.match(snapshot.output, /registry native channel\r?\n/)
})

test('real rust pty runtime detaches native registry channels without exiting them', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()
  ensureSessionRuntimeBuilt()
  const baseDir = mkdtempSync(join(tmpdir(), 'nexus-native-pty-detach-'))
  const dbPath = join(baseDir, 'session.db')
  const env = {
    ...process.env,
    NEXUS_SESSION_BACKEND: 'native',
    NEXUS_NATIVE_SESSION_DB: dbPath,
    NEXUS_NATIVE_PTY_SUPERVISOR_SOCKET: '',
  }
  const sessionClient = createSessionManagementRustClient({
    runtimeExecutable: SESSION_RUNTIME,
    env,
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })
  const ptyClient = createPtyBrokerRustClient({
    runtimeExecutable: RUNTIME,
    env,
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })

  t.after(async () => {
    await ptyClient.close()
    await sessionClient.close()
    rmSync(baseDir, { recursive: true, force: true })
  })

  await sessionClient.ready()
  await sessionClient.createProject({
    sessionName: 'native-detach-project',
    cwd: ROOT,
    initialWindowName: 'shell',
    shellCmd: 'cat',
    proxyVars: {},
  })

  await ptyClient.ready()
  assert.deepEqual(await ptyClient.attachConnection({
    connectionId: 'native-detach-conn-1',
    session: 'native-detach-project',
    windowIndex: 0,
  }), { key: 'native-detach-project:0' })

  ptyClient.closeConnection({
    connectionId: 'native-detach-conn-1',
    key: 'native-detach-project:0',
  })

  let status = await ptyClient.getStatus()
  for (let attempt = 0; attempt < 20 && status.runningPtys !== 1; attempt += 1) {
    await delay(20)
    status = await ptyClient.getStatus()
  }
  assert.equal(status.runningPtys, 1)

  const instance = latestNativeProcessInstance(dbPath, 'native-detach-project', 0)
  assert.equal(instance.status, 'running')

  assert.deepEqual(await ptyClient.attachConnection({
    connectionId: 'native-detach-conn-2',
    session: 'native-detach-project',
    windowIndex: 0,
  }), { key: 'native-detach-project:0' })
})

test('real rust pty runtime launches native channels from a structured launch plan', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()
  ensureSessionRuntimeBuilt()
  const baseDir = mkdtempSync(join(tmpdir(), 'nexus-native-launch-plan-'))
  const dbPath = join(baseDir, 'session.db')
  const scriptPath = join(baseDir, 'print-launch-plan.js')
  writeFileSync(
    scriptPath,
    'process.stdout.write(`${process.argv[2]}|${process.env.NEXUS_PLAN_TOKEN}\\n`);\n',
  )
  const env = {
    ...process.env,
    NEXUS_SESSION_BACKEND: 'native',
    NEXUS_NATIVE_SESSION_DB: dbPath,
    NEXUS_NATIVE_PTY_SUPERVISOR_SOCKET: '',
  }
  const sessionClient = createSessionManagementRustClient({
    runtimeExecutable: SESSION_RUNTIME,
    env,
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })
  const ptyClient = createPtyBrokerRustClient({
    runtimeExecutable: RUNTIME,
    env,
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })

  t.after(async () => {
    await ptyClient.close()
    await sessionClient.close()
    rmSync(baseDir, { recursive: true, force: true })
  })

  await sessionClient.ready()
  await sessionClient.createProject({
    sessionName: 'native-launch-plan',
    cwd: ROOT,
    initialWindowName: 'shell',
    shellCmd: 'cat',
    launchPlan: {
      program: process.execPath,
      args: [scriptPath, 'two words'],
      env: {
        NEXUS_PLAN_TOKEN: 'env value',
      },
      cwd: ROOT,
    },
    proxyVars: {},
  })

  await ptyClient.ready()
  await ptyClient.attachConnection({
    connectionId: 'native-launch-plan-conn',
    session: 'native-launch-plan',
    windowIndex: 0,
  })

  let snapshot = null
  for (let attempt = 0; attempt < 30; attempt += 1) {
    snapshot = await ptyClient.getOutputSnapshot({
      session: 'native-launch-plan',
      windowIndex: 0,
    })
    if (snapshot.output.includes('two words|env value')) break
    await delay(20)
  }

  assert.match(snapshot.output, /two words\|env value\r?\n/)
})

test('real rust pty runtime records native process lifecycle in the registry', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()
  ensureSessionRuntimeBuilt()
  const baseDir = mkdtempSync(join(tmpdir(), 'nexus-native-process-lifecycle-'))
  const dbPath = join(baseDir, 'session.db')
  const exitScript = join(baseDir, 'exit-seven.sh')
  writeFileSync(exitScript, '#!/bin/sh\nprintf lifecycle-ready\nexit 7\n', { mode: 0o755 })
  const env = {
    ...process.env,
    NEXUS_SESSION_BACKEND: 'native',
    NEXUS_NATIVE_SESSION_DB: dbPath,
    NEXUS_NATIVE_PTY_SUPERVISOR_SOCKET: '',
  }
  const sessionClient = createSessionManagementRustClient({
    runtimeExecutable: SESSION_RUNTIME,
    env,
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })
  const ptyClient = createPtyBrokerRustClient({
    runtimeExecutable: RUNTIME,
    env,
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })

  t.after(async () => {
    await ptyClient.close()
    await sessionClient.close()
    rmSync(baseDir, { recursive: true, force: true })
  })

  await sessionClient.ready()
  await sessionClient.createProject({
    sessionName: 'native-process-project',
    cwd: ROOT,
    initialWindowName: 'shell',
    shellCmd: exitScript,
    proxyVars: {},
  })

  await ptyClient.ready()
  await ptyClient.attachConnection({
    connectionId: 'native-process-conn',
    session: 'native-process-project',
    windowIndex: 0,
  })

  let instance = null
  for (let attempt = 0; attempt < 50; attempt += 1) {
    instance = latestNativeProcessInstance(dbPath, 'native-process-project', 0)
    if (instance?.status === 'exited') break
    await delay(20)
  }

  assert.equal(instance.project_name, 'native-process-project')
  assert.equal(instance.channel_index, 0)
  assert.equal(instance.status, 'exited')
  assert.equal(instance.exit_code, 7)
  assert.equal(typeof instance.os_pid, 'number')
  assert.notEqual(instance.started_at, '')
  assert.notEqual(instance.ended_at, '')
  assert.notEqual(instance.start_fingerprint, '')
  const initialInstanceCount = nativeProcessInstanceCount(dbPath, 'native-process-project', 0)

  const reopened = await ptyClient.attachConnection({
    connectionId: 'native-process-conn-again',
    session: 'native-process-project',
    windowIndex: 0,
  })
  assert.deepEqual(reopened, { key: 'native-process-project:0' })

  let nextInstanceCount = 0
  for (let attempt = 0; attempt < 50; attempt += 1) {
    nextInstanceCount = nativeProcessInstanceCount(dbPath, 'native-process-project', 0)
    if (nextInstanceCount > initialInstanceCount) break
    await delay(20)
  }
  assert.ok(nextInstanceCount > initialInstanceCount)
})

test('real rust session runtime terminates native channel process before deleting the channel', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()
  ensureSessionRuntimeBuilt()
  const baseDir = mkdtempSync(join(tmpdir(), 'nexus-native-delete-process-'))
  const dbPath = join(baseDir, 'session.db')
  const runScript = join(baseDir, 'run-until-term.sh')
  writeFileSync(runScript, '#!/bin/sh\nexec sleep 1000\n', { mode: 0o755 })
  const env = {
    ...process.env,
    NEXUS_SESSION_BACKEND: 'native',
    NEXUS_NATIVE_SESSION_DB: dbPath,
    NEXUS_NATIVE_PTY_SUPERVISOR_SOCKET: '',
  }
  const sessionClient = createSessionManagementRustClient({
    runtimeExecutable: SESSION_RUNTIME,
    env,
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })
  const ptyClient = createPtyBrokerRustClient({
    runtimeExecutable: RUNTIME,
    env,
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })

  t.after(async () => {
    await ptyClient.close()
    await sessionClient.close()
    rmSync(baseDir, { recursive: true, force: true })
  })

  await sessionClient.ready()
  await sessionClient.createProject({
    sessionName: 'native-delete-process',
    cwd: ROOT,
    initialWindowName: 'shell',
    shellCmd: runScript,
    proxyVars: {},
  })
  await sessionClient.createProjectChannel({
    sessionName: 'native-delete-process',
    cwd: ROOT,
    channelName: 'spare',
    shellCmd: 'cat',
    defaultShellCmd: 'cat',
    proxyVars: {},
  })

  await ptyClient.ready()
  await ptyClient.attachConnection({
    connectionId: 'native-delete-process-conn',
    session: 'native-delete-process',
    windowIndex: 0,
  })

  let instance = null
  for (let attempt = 0; attempt < 50; attempt += 1) {
    instance = latestNativeProcessInstance(dbPath, 'native-delete-process', 0)
    if (instance?.status === 'running' && typeof instance.os_pid === 'number') break
    await delay(20)
  }
  assert.equal(instance.status, 'running')
  assert.equal(processAlive(instance.os_pid), true)

  await sessionClient.deleteSessionWindow({
    sessionName: 'native-delete-process',
    index: 0,
    defaultShellCmd: 'cat',
  })

  let stillAlive = true
  for (let attempt = 0; attempt < 50; attempt += 1) {
    stillAlive = processAlive(instance.os_pid)
    if (!stillAlive) break
    await delay(20)
  }
  assert.equal(stillAlive, false)
})

test('real rust pty runtime does not reuse an in-memory native entry after the channel was deleted and recreated', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()
  ensureSessionRuntimeBuilt()
  const baseDir = mkdtempSync(join(tmpdir(), 'nexus-native-recreate-entry-'))
  const dbPath = join(baseDir, 'session.db')
  const env = {
    ...process.env,
    NEXUS_SESSION_BACKEND: 'native',
    NEXUS_NATIVE_SESSION_DB: dbPath,
    NEXUS_NATIVE_PTY_SUPERVISOR_SOCKET: '',
  }
  const sessionClient = createSessionManagementRustClient({
    runtimeExecutable: SESSION_RUNTIME,
    env,
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })
  const ptyClient = createPtyBrokerRustClient({
    runtimeExecutable: RUNTIME,
    env,
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })

  t.after(async () => {
    await ptyClient.close()
    await sessionClient.close()
    rmSync(baseDir, { recursive: true, force: true })
  })

  await sessionClient.ready()
  await ptyClient.ready()
  await sessionClient.createProject({
    sessionName: 'native-recreate-entry',
    cwd: ROOT,
    initialWindowName: 'shell',
    shellCmd: 'cat',
    proxyVars: {},
  })
  await sessionClient.createProjectChannel({
    sessionName: 'native-recreate-entry',
    cwd: ROOT,
    channelName: 'channel',
    shellCmd: 'cat',
    defaultShellCmd: 'cat',
    proxyVars: {},
  })

  assert.deepEqual(await ptyClient.attachConnection({
    connectionId: 'native-recreate-old',
    session: 'native-recreate-entry',
    windowIndex: 1,
  }), { key: 'native-recreate-entry:1' })

  const oldInstance = latestNativeProcessInstance(dbPath, 'native-recreate-entry', 1)
  assert.equal(oldInstance.status, 'running')

  await sessionClient.deleteSessionWindow({
    sessionName: 'native-recreate-entry',
    index: 1,
    defaultShellCmd: 'cat',
  })
  await sessionClient.createProjectChannel({
    sessionName: 'native-recreate-entry',
    cwd: ROOT,
    channelName: 'channel',
    shellCmd: 'cat',
    defaultShellCmd: 'cat',
    proxyVars: {},
  })

  assert.deepEqual(await ptyClient.attachConnection({
    connectionId: 'native-recreate-new',
    session: 'native-recreate-entry',
    windowIndex: 1,
  }), { key: 'native-recreate-entry:1' })

  const newInstance = latestNativeProcessInstance(dbPath, 'native-recreate-entry', 1)
  assert.equal(newInstance.status, 'running')
  assert.notEqual(newInstance.start_fingerprint, oldInstance.start_fingerprint)
})

test('real rust pty runtime reconciles old native running processes on startup and can cold-reattach orphaned channels', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()
  ensureSessionRuntimeBuilt()
  const baseDir = mkdtempSync(join(tmpdir(), 'nexus-native-reconcile-'))
  const dbPath = join(baseDir, 'session.db')
  const env = {
    ...process.env,
    NEXUS_SESSION_BACKEND: 'native',
    NEXUS_NATIVE_SESSION_DB: dbPath,
    NEXUS_NATIVE_PTY_SUPERVISOR_SOCKET: '',
  }
  const sessionClient = createSessionManagementRustClient({
    runtimeExecutable: SESSION_RUNTIME,
    env,
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })
  let ptyClient = null

  t.after(async () => {
    await ptyClient?.close()
    await sessionClient.close()
    rmSync(baseDir, { recursive: true, force: true })
  })

  await sessionClient.ready()
  await sessionClient.createProject({
    sessionName: 'native-reconcile',
    cwd: ROOT,
    initialWindowName: 'live-old',
    shellCmd: 'cat',
    proxyVars: {},
  })
  await sessionClient.createProjectChannel({
    sessionName: 'native-reconcile',
    cwd: ROOT,
    channelName: 'dead-old',
    shellCmd: 'cat',
    defaultShellCmd: 'cat',
    proxyVars: {},
  })

  insertNativeProcessInstance(dbPath, {
    projectName: 'native-reconcile',
    channelIndex: 0,
    osPid: process.pid,
    startFingerprint: 'live-old',
  })
  insertNativeProcessInstance(dbPath, {
    projectName: 'native-reconcile',
    channelIndex: 1,
    osPid: 99999999,
    startFingerprint: 'dead-old',
  })

  ptyClient = createPtyBrokerRustClient({
    runtimeExecutable: RUNTIME,
    env,
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })
  await ptyClient.ready()

  assert.equal(latestNativeProcessInstance(dbPath, 'native-reconcile', 0).status, 'orphaned')
  assert.equal(latestNativeProcessInstance(dbPath, 'native-reconcile', 1).status, 'stale')

  const attached = await ptyClient.attachConnection({
    connectionId: 'native-reconcile-conn',
    session: 'native-reconcile',
    windowIndex: 0,
  })
  assert.deepEqual(attached, { key: 'native-reconcile:0' })

  const latest = latestNativeProcessInstance(dbPath, 'native-reconcile', 0)
  assert.equal(latest.status, 'running')
  assert.notEqual(latest.start_fingerprint, 'live-old')
})

test('real rust pty runtime returns native cold snapshot from durable scrollback', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()
  ensureSessionRuntimeBuilt()
  const baseDir = mkdtempSync(join(tmpdir(), 'nexus-native-scrollback-'))
  const dbPath = join(baseDir, 'session.db')
  const env = {
    ...process.env,
    NEXUS_SESSION_BACKEND: 'native',
    NEXUS_NATIVE_SESSION_DB: dbPath,
    NEXUS_NATIVE_PTY_SUPERVISOR_SOCKET: '',
    NEXUS_NATIVE_SCROLLBACK_DIR: join(baseDir, 'scrollback'),
  }
  const sessionClient = createSessionManagementRustClient({
    runtimeExecutable: SESSION_RUNTIME,
    env,
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })
  const firstPtyClient = createPtyBrokerRustClient({
    runtimeExecutable: RUNTIME,
    env,
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })
  let secondPtyClient = null

  t.after(async () => {
    await secondPtyClient?.close()
    await firstPtyClient.close()
    await sessionClient.close()
    rmSync(baseDir, { recursive: true, force: true })
  })

  await sessionClient.ready()
  await sessionClient.createProject({
    sessionName: 'native-scrollback',
    cwd: ROOT,
    initialWindowName: 'shell',
    shellCmd: 'cat',
    proxyVars: {},
  })

  await firstPtyClient.ready()
  await firstPtyClient.attachConnection({
    connectionId: 'native-scrollback-writer',
    session: 'native-scrollback',
    windowIndex: 0,
  })
  firstPtyClient.handleConnectionMessage({
    connectionId: 'native-scrollback-writer',
    key: 'native-scrollback:0',
    rawMessage: 'durable native line\n',
  })

  let warmSnapshot = null
  for (let attempt = 0; attempt < 30; attempt += 1) {
    warmSnapshot = await firstPtyClient.getOutputSnapshot({
      session: 'native-scrollback',
      windowIndex: 0,
    })
    if (warmSnapshot.output.includes('durable native line')) break
    await delay(20)
  }
  assert.match(warmSnapshot.output, /durable native line\r?\n/)

  await firstPtyClient.close()

  secondPtyClient = createPtyBrokerRustClient({
    runtimeExecutable: RUNTIME,
    env,
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })
  await secondPtyClient.ready()

  const coldSnapshot = await secondPtyClient.getOutputSnapshot({
    session: 'native-scrollback',
    windowIndex: 0,
  })
  assert.equal(coldSnapshot.connected, false)
  assert.match(coldSnapshot.output, /durable native line\r?\n/)
  assert.equal(coldSnapshot.clients, 0)
})

test('real rust pty runtime isolates same-session windows with grouped tmux sessions', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()
  const { baseDir, logFile } = createFakeTmuxBin()
  const client = createPtyBrokerRustClient({
    runtimeExecutable: RUNTIME,
    env: tmuxTestEnv({
      PATH: `${baseDir}:${process.env.PATH || ''}`,
    }),
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })

  t.after(async () => {
    await client.close()
    rmSync(baseDir, { recursive: true, force: true })
  })

  await client.ready()

  const first = await client.attachConnection({
    connectionId: 'conn-main-window-0',
    session: 'main',
    windowIndex: 0,
  })
  const second = await client.attachConnection({
    connectionId: 'conn-main-window-3',
    session: 'main',
    windowIndex: 3,
  })

  assert.deepEqual(first, { key: 'main:0' })
  assert.deepEqual(second, { key: 'main:3' })

  const log = readFileSync(logFile, 'utf8')
  assert.doesNotMatch(log, /attach-session\|-t main:/)
  assert.match(log, /new-session\|-d -s nexus-pty-[^ ]+ -t main/)
  assert.match(log, /select-window\|-t nexus-pty-[^ ]+:0/)
  assert.match(log, /select-window\|-t nexus-pty-[^ ]+:3/)
  assert.match(log, /attach-session\|-t nexus-pty-[^\n]+/)
})

test('real rust pty runtime refuses missing requested windows instead of reusing another pane', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()
  const { baseDir, logFile } = createFakeTmuxBin()
  const client = createPtyBrokerRustClient({
    runtimeExecutable: RUNTIME,
    env: tmuxTestEnv({
      PATH: `${baseDir}:${process.env.PATH || ''}`,
    }),
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })

  t.after(async () => {
    await client.close()
    rmSync(baseDir, { recursive: true, force: true })
  })

  await client.ready()

  await assert.rejects(
    client.attachConnection({
      connectionId: 'conn-main-window-9',
      session: 'main',
      windowIndex: 9,
    }),
    /window_missing/,
  )

  const log = readFileSync(logFile, 'utf8')
  assert.doesNotMatch(log, /select-window\|-t nexus-pty-[^ ]+:0/)
  assert.doesNotMatch(log, /attach-session\|-t nexus-pty-/)
})

test('real rust pty runtime forces an xterm TERM when parent env is dumb', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()

  const realTmux = resolveSystemTmux()
  if (!realTmux) {
    t.skip('tmux is not installed')
    return
  }

  const { baseDir, tmuxPath } = createRealTmuxBin(realTmux)
  const createSession = spawnSync(tmuxPath, ['new-session', '-d', '-s', 'main', '-n', 'shell', 'cat'], {
    encoding: 'utf8',
    env: tmuxTestEnv({
      TERM: 'xterm-256color',
    }),
  })
  assert.equal(createSession.status, 0, createSession.stderr || createSession.stdout)

  const client = createPtyBrokerRustClient({
    runtimeExecutable: RUNTIME,
    env: tmuxTestEnv({
      PATH: `${baseDir}:${process.env.PATH || ''}`,
      TERM: 'dumb',
    }),
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })

  t.after(async () => {
    await client.close()
    spawnSync(tmuxPath, ['kill-server'], { encoding: 'utf8' })
    rmSync(baseDir, { recursive: true, force: true })
  })

  const events = []
  client.onEvent((event) => {
    events.push(event)
  })

  await client.ready()
  const attached = await client.attachConnection({
    connectionId: 'conn-dumb-term',
    session: 'main',
    windowIndex: 0,
  })
  assert.deepEqual(attached, { key: 'main:0' })

  client.handleConnectionMessage({
    connectionId: 'conn-dumb-term',
    key: 'main:0',
    rawMessage: 'hello from dumb parent\n',
  })

  let combinedOutput = ''
  for (let attempt = 0; attempt < 40; attempt += 1) {
    combinedOutput = events
      .filter((event) => event.type === 'output')
      .map((event) => event.data)
      .join('')
    if (combinedOutput.includes('hello from dumb parent')) break
    await delay(50)
  }

  assert.match(combinedOutput, /hello from dumb parent\r?\n/)
  assert.doesNotMatch(combinedOutput, /open terminal failed: terminal does not support clear/)

  client.closeConnection({ connectionId: 'conn-dumb-term', key: 'main:0' })

  let status = await client.getStatus()
  for (let attempt = 0; attempt < 20 && status.runningPtys !== 0; attempt += 1) {
    await delay(20)
    status = await client.getStatus()
  }
  assert.equal(status.runningPtys, 0)
})

test('real rust pty runtime clears stale grouped tmux sessions left by an ungraceful prior broker exit', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()

  const realTmux = resolveSystemTmux()
  if (!realTmux) {
    t.skip('tmux is not installed')
    return
  }

  const { baseDir, tmuxPath } = createRealTmuxBin(realTmux)
  const env = tmuxTestEnv({
    PATH: `${baseDir}:${process.env.PATH || ''}`,
    TERM: 'xterm-256color',
  })

  const createSession = spawnSync(tmuxPath, ['new-session', '-d', '-s', 'main', '-n', 'shell', 'cat'], {
    encoding: 'utf8',
    env,
  })
  assert.equal(createSession.status, 0, createSession.stderr || createSession.stdout)

  t.after(() => {
    spawnSync(tmuxPath, ['kill-server'], { encoding: 'utf8', env })
    rmSync(baseDir, { recursive: true, force: true })
  })

  const firstRuntime = spawnRawPtyRuntime(env)
  t.after(() => {
    firstRuntime.child.kill('SIGKILL')
  })

  await firstRuntime.ready()
  await firstRuntime.attachConnection({
    connectionId: 'conn-stale-cleanup',
    session: 'main',
    windowIndex: 0,
  })

  const beforeExit = listRealTmuxSessions(tmuxPath, env)
  assert.ok(beforeExit.some((session) => session.startsWith('nexus-pty-')))

  firstRuntime.child.kill('SIGTERM')
  await new Promise((resolve) => firstRuntime.child.once('exit', resolve))

  const secondRuntime = spawnRawPtyRuntime(env)
  t.after(() => {
    secondRuntime.child.kill('SIGKILL')
  })

  await secondRuntime.ready()

  const afterRestart = listRealTmuxSessions(tmuxPath, env)
  assert.deepEqual(afterRestart, ['main|0'])

  await secondRuntime.shutdown()
  await new Promise((resolve) => secondRuntime.child.once('exit', resolve))
})
