import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { createPtyBrokerRustClient, createPtyBrokerSocketClient } from './helpers/ptyBrokerRustClient.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SUPERVISOR = join(
  ROOT,
  'rust-runtime',
  'target',
  'release',
  process.platform === 'win32' ? 'nexus-native-pty-supervisor.exe' : 'nexus-native-pty-supervisor',
)
const PTY_RUNTIME = join(
  ROOT,
  'rust-runtime',
  'target',
  'release',
  process.platform === 'win32' ? 'nexus-pty-runtime.exe' : 'nexus-pty-runtime',
)
const NATIVE_SESSION_CLI = join(
  ROOT,
  'rust-runtime',
  'target',
  'release',
  process.platform === 'win32' ? 'nexus-native-session.exe' : 'nexus-native-session',
)

let built = false

function ensureBuilt() {
  if (built) return
  const build = spawnSync('cargo', [
    'build',
    '--manifest-path',
    'rust-runtime/Cargo.toml',
    '--release',
    '--bin',
    'nexus-native-pty-supervisor',
    '--bin',
    'nexus-pty-runtime',
    '--bin',
    'nexus-native-session',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
  })

  assert.equal(build.status, 0, build.stderr || build.stdout)
  assert.equal(existsSync(SUPERVISOR), true)
  assert.equal(existsSync(PTY_RUNTIME), true)
  assert.equal(existsSync(NATIVE_SESSION_CLI), true)
  built = true
}

async function waitForSocket(path) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (existsSync(path)) return
    await delay(20)
  }
  throw new Error(`socket was not created: ${path}`)
}

function isolatedNativeEnv(baseDir, overrides = {}) {
  return {
    ...process.env,
    NEXUS_SESSION_BACKEND: 'native',
    NEXUS_DATA_DIR: baseDir,
    NEXUS_NATIVE_SESSION_DB: join(baseDir, 'native-sessions', 'session.db'),
    NEXUS_NATIVE_SCROLLBACK_DIR: join(baseDir, 'scrollback'),
    ...overrides,
  }
}

test('native pty supervisor keeps a native PTY alive across socket clients', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()

  const baseDir = mkdtempSync(join(tmpdir(), 'nexus-native-pty-supervisor-'))
  const socketPath = join(baseDir, 'supervisor.sock')
  const env = isolatedNativeEnv(baseDir, {
    NEXUS_NATIVE_PTY_PROGRAM: 'cat',
    NEXUS_NATIVE_PTY_SUPERVISOR_SOCKET: socketPath,
  })
  const supervisor = spawn(SUPERVISOR, [], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
    env,
  })
  let stderr = ''
  supervisor.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })

  t.after(() => {
    supervisor.kill('SIGTERM')
    rmSync(baseDir, { recursive: true, force: true })
  })

  await waitForSocket(socketPath)

  const firstEvents = []
  const first = createPtyBrokerSocketClient({
    socketPath,
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })
  first.onEvent((event) => firstEvents.push(event))
  t.after(() => first.close())

  await first.ready()
  assert.deepEqual(await first.attachConnection({
    connectionId: 'supervisor-client-1',
    session: 'native-supervisor-project',
    windowIndex: 0,
  }), { key: 'native-supervisor-project:0' })

  first.handleConnectionMessage({
    connectionId: 'supervisor-client-1',
    key: 'native-supervisor-project:0',
    rawMessage: 'supervisor one\n',
  })

  let firstOutput = ''
  for (let attempt = 0; attempt < 30; attempt += 1) {
    firstOutput = firstEvents
      .filter((event) => event.type === 'output')
      .map((event) => event.data)
      .join('')
    if (firstOutput.includes('supervisor one')) break
    await delay(20)
  }
  assert.match(firstOutput, /supervisor one\r?\n/)

  first.close()

  const secondEvents = []
  const second = createPtyBrokerSocketClient({
    socketPath,
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })
  second.onEvent((event) => secondEvents.push(event))
  t.after(() => second.close())

  await second.ready()
  assert.deepEqual(await second.attachConnection({
    connectionId: 'supervisor-client-2',
    session: 'native-supervisor-project',
    windowIndex: 0,
  }), { key: 'native-supervisor-project:0' })

  let replay = ''
  for (let attempt = 0; attempt < 30; attempt += 1) {
    replay = secondEvents
      .filter((event) => event.type === 'output')
      .map((event) => event.data)
      .join('')
    if (replay.includes('supervisor one')) break
    await delay(20)
  }
  assert.match(replay, /supervisor one\r?\n/)

  second.handleConnectionMessage({
    connectionId: 'supervisor-client-2',
    key: 'native-supervisor-project:0',
    rawMessage: 'supervisor two\n',
  })

  let secondOutput = ''
  for (let attempt = 0; attempt < 30; attempt += 1) {
    secondOutput = secondEvents
      .filter((event) => event.type === 'output')
      .map((event) => event.data)
      .join('')
    if (secondOutput.includes('supervisor two')) break
    await delay(20)
  }
  assert.match(secondOutput, /supervisor two\r?\n/)

  assert.equal(supervisor.exitCode, null, stderr)
})

test('pty runtime forwards native connections through the supervisor socket', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()

  const baseDir = mkdtempSync(join(tmpdir(), 'nexus-native-pty-forward-'))
  const socketPath = join(baseDir, 'supervisor.sock')
  const env = isolatedNativeEnv(baseDir, {
    NEXUS_NATIVE_PTY_PROGRAM: 'cat',
    NEXUS_NATIVE_PTY_SUPERVISOR_SOCKET: socketPath,
  })
  const supervisor = spawn(SUPERVISOR, [], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
    env,
  })
  let stderr = ''
  supervisor.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })

  t.after(() => {
    supervisor.kill('SIGTERM')
    rmSync(baseDir, { recursive: true, force: true })
  })

  await waitForSocket(socketPath)

  const firstEvents = []
  const firstRuntime = createPtyBrokerRustClient({
    runtimeExecutable: PTY_RUNTIME,
    env,
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })
  firstRuntime.onEvent((event) => firstEvents.push(event))
  t.after(async () => firstRuntime.close())

  await firstRuntime.ready()
  assert.deepEqual(await firstRuntime.attachConnection({
    connectionId: 'forward-client-1',
    session: 'forward-project',
    windowIndex: 0,
  }), { key: 'forward-project:0' })

  firstRuntime.handleConnectionMessage({
    connectionId: 'forward-client-1',
    key: 'forward-project:0',
    rawMessage: 'forward one\n',
  })

  let firstOutput = ''
  for (let attempt = 0; attempt < 30; attempt += 1) {
    firstOutput = firstEvents
      .filter((event) => event.type === 'output')
      .map((event) => event.data)
      .join('')
    if (firstOutput.includes('forward one')) break
    await delay(20)
  }
  assert.match(firstOutput, /forward one\r?\n/)

  await firstRuntime.close()

  const secondEvents = []
  const secondRuntime = createPtyBrokerRustClient({
    runtimeExecutable: PTY_RUNTIME,
    env,
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })
  secondRuntime.onEvent((event) => secondEvents.push(event))
  t.after(async () => secondRuntime.close())

  await secondRuntime.ready()
  assert.deepEqual(await secondRuntime.attachConnection({
    connectionId: 'forward-client-2',
    session: 'forward-project',
    windowIndex: 0,
  }), { key: 'forward-project:0' })

  const snapshotAfterReattach = await secondRuntime.getOutputSnapshot({
    session: 'forward-project',
    windowIndex: 0,
  })
  assert.match(snapshotAfterReattach.output, /forward one\r?\n/)

  let replay = ''
  for (let attempt = 0; attempt < 30; attempt += 1) {
    replay = secondEvents
      .filter((event) => event.type === 'output')
      .map((event) => event.data)
      .join('')
    if (replay.includes('forward one')) break
    await delay(20)
  }
  assert.match(replay, /forward one\r?\n/)

  secondRuntime.handleConnectionMessage({
    connectionId: 'forward-client-2',
    key: 'forward-project:0',
    rawMessage: 'forward two\n',
  })

  let secondOutput = ''
  for (let attempt = 0; attempt < 30; attempt += 1) {
    secondOutput = secondEvents
      .filter((event) => event.type === 'output')
      .map((event) => event.data)
      .join('')
    if (secondOutput.includes('forward two')) break
    await delay(20)
  }
  assert.match(secondOutput, /forward two\r?\n/)
  assert.equal(supervisor.exitCode, null, stderr)
})

test('pty runtime discovers the default native supervisor socket when env is unset', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()

  const baseDir = mkdtempSync(join(tmpdir(), 'nexus-native-pty-default-socket-'))
  const socketPath = join(baseDir, 'native-sessions', 'supervisor.sock')
  const env = isolatedNativeEnv(baseDir, {
    NEXUS_NATIVE_PTY_PROGRAM: 'cat',
  })
  delete env.NEXUS_NATIVE_PTY_SUPERVISOR_SOCKET
  const supervisor = spawn(SUPERVISOR, [], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
    env,
  })
  let stderr = ''
  supervisor.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })

  t.after(() => {
    supervisor.kill('SIGTERM')
    rmSync(baseDir, { recursive: true, force: true })
  })

  await waitForSocket(socketPath)

  const events = []
  const runtime = createPtyBrokerRustClient({
    runtimeExecutable: PTY_RUNTIME,
    env,
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })
  runtime.onEvent((event) => events.push(event))
  t.after(async () => runtime.close())

  await runtime.ready()
  assert.deepEqual(await runtime.attachConnection({
    connectionId: 'default-socket-client',
    session: 'default-socket-project',
    windowIndex: 0,
  }), { key: 'default-socket-project:0' })

  runtime.handleConnectionMessage({
    connectionId: 'default-socket-client',
    key: 'default-socket-project:0',
    rawMessage: 'default socket one\n',
  })

  let output = ''
  for (let attempt = 0; attempt < 30; attempt += 1) {
    output = events
      .filter((event) => event.type === 'output')
      .map((event) => event.data)
      .join('')
    if (output.includes('default socket one')) break
    await delay(20)
  }
  assert.match(output, /default socket one\r?\n/)
  assert.equal(supervisor.exitCode, null, stderr)
})

test('native session CLI lists and attaches to supervisor sessions', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()

  const baseDir = mkdtempSync(join(tmpdir(), 'nexus-native-session-cli-'))
  const socketPath = join(baseDir, 'supervisor.sock')
  const registryPath = join(baseDir, 'native-sessions', 'session.db')
  mkdirSync(join(baseDir, 'native-sessions'), { recursive: true })
  const env = {
    ...process.env,
    NEXUS_SESSION_BACKEND: 'native',
    NEXUS_DATA_DIR: baseDir,
    NEXUS_NATIVE_SESSION_DB: registryPath,
    NEXUS_NATIVE_PTY_SUPERVISOR_SOCKET: socketPath,
    NEXUS_NATIVE_SCROLLBACK_DIR: join(baseDir, 'scrollback'),
  }
  const db = new DatabaseSync(registryPath)
  t.after(() => db.close())
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE native_projects (
        name TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        active_channel_index INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE native_channels (
        project_name TEXT NOT NULL,
        channel_index INTEGER NOT NULL,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        shell_cmd TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        launch_program TEXT,
        launch_args_json TEXT,
        launch_env_json TEXT,
        launch_cwd TEXT,
        shell_type TEXT,
        profile TEXT,
        PRIMARY KEY(project_name, channel_index),
        FOREIGN KEY(project_name) REFERENCES native_projects(name) ON DELETE CASCADE
    );
    CREATE TABLE process_instances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_name TEXT NOT NULL,
        channel_index INTEGER NOT NULL,
        status TEXT NOT NULL,
        os_pid INTEGER,
        platform_handle TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        exit_code INTEGER,
        start_fingerprint TEXT NOT NULL,
        FOREIGN KEY(project_name, channel_index)
          REFERENCES native_channels(project_name, channel_index)
          ON DELETE CASCADE
    );
    CREATE TABLE channel_metadata (
        project_name TEXT NOT NULL,
        channel_index INTEGER NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY(project_name, channel_index, key),
        FOREIGN KEY(project_name, channel_index)
          REFERENCES native_channels(project_name, channel_index)
          ON DELETE CASCADE
    );
  `)
  db.prepare(`
    INSERT INTO native_projects (name, cwd, active_channel_index, created_at, updated_at)
    VALUES (?, ?, 0, ?, ?)
  `).run('cli-project', baseDir, '2026-05-13T00:00:00Z', '2026-05-13T00:00:00Z')
  db.prepare(`
    INSERT INTO native_channels (
      project_name,
      channel_index,
      name,
      cwd,
      shell_cmd,
      created_at,
      updated_at,
      launch_program,
      launch_args_json,
      launch_env_json,
      launch_cwd
    )
    VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'cli-project',
    'shell',
    baseDir,
    'cat',
    '2026-05-13T00:00:00Z',
    '2026-05-13T00:00:00Z',
    'cat',
    '[]',
    '{}',
    baseDir,
  )

  const supervisor = spawn(SUPERVISOR, [], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
    env,
  })
  let stderr = ''
  supervisor.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })

  t.after(() => {
    supervisor.kill('SIGTERM')
    rmSync(baseDir, { recursive: true, force: true })
  })

  await waitForSocket(socketPath)

  const first = createPtyBrokerSocketClient({
    socketPath,
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })
  t.after(() => first.close())

  await first.ready()
  assert.deepEqual(await first.attachConnection({
    connectionId: 'cli-seed',
    session: 'cli-project',
    windowIndex: 0,
  }), { key: 'cli-project:0' })
  first.close()

  const list = spawnSync(NATIVE_SESSION_CLI, ['list'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  })
  assert.equal(list.status, 0, list.stderr || list.stdout)
  assert.match(list.stdout, /cli-project\tchannels=1/)
  assert.match(list.stdout, /0\t/)

  const attach = spawn(NATIVE_SESSION_CLI, ['attach', 'cli-project', '0'], {
    cwd: ROOT,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let attachStdout = ''
  let attachStderr = ''
  attach.stdout.on('data', (chunk) => {
    attachStdout += String(chunk)
  })
  attach.stderr.on('data', (chunk) => {
    attachStderr += String(chunk)
  })
  t.after(() => attach.kill('SIGTERM'))

  attach.stdin.write('cli one\n')
  await delay(100)
  attach.stdin.end()

  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (attachStdout.includes('cli one')) break
    await delay(20)
  }
  assert.match(attachStdout, /cli one\r?\n/, attachStderr)
  assert.equal(supervisor.exitCode, null, stderr)
})

test('native pty supervisor refuses a second owner for the same socket', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()

  const baseDir = mkdtempSync(join(tmpdir(), 'nexus-native-pty-lock-'))
  const socketPath = join(baseDir, 'supervisor.sock')
  const env = isolatedNativeEnv(baseDir, {
    NEXUS_NATIVE_PTY_PROGRAM: 'cat',
    NEXUS_NATIVE_PTY_SUPERVISOR_SOCKET: socketPath,
  })
  const first = spawn(SUPERVISOR, [], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
    env,
  })
  let firstStderr = ''
  first.stderr.on('data', (chunk) => {
    firstStderr += String(chunk)
  })

  t.after(() => {
    first.kill('SIGTERM')
    rmSync(baseDir, { recursive: true, force: true })
  })

  await waitForSocket(socketPath)

  const second = spawnSync(SUPERVISOR, [], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  })
  assert.notEqual(second.status, 0)
  assert.match(second.stderr, /native pty supervisor lock already exists/)

  const client = createPtyBrokerSocketClient({
    socketPath,
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })
  t.after(() => client.close())
  await client.ready()
  assert.deepEqual(await client.attachConnection({
    connectionId: 'lock-client',
    session: 'lock-project',
    windowIndex: 0,
  }), { key: 'lock-project:0' })
  assert.equal(first.exitCode, null, firstStderr)
})
