import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { createPtyBrokerRustClient } from './helpers/ptyBrokerRustClient.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME = join(
  ROOT,
  'rust-runtime',
  'target',
  'release',
  process.platform === 'win32' ? 'nexus-pty-runtime.exe' : 'nexus-pty-runtime',
)
let buildChecked = false

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

function createFakeTmuxBin() {
  const baseDir = mkdtempSync(join(tmpdir(), 'nexus-fake-rust-tmux-'))
  const tmuxPath = join(baseDir, 'tmux')
  writeFileSync(tmuxPath, `#!/bin/sh
set -eu
cmd="$1"
shift || true
case "$cmd" in
  has-session)
    exit 0
    ;;
  list-windows)
    printf '3\n'
    exit 0
    ;;
  attach-session)
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
  return { baseDir }
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

test('real rust pty runtime speaks the broker contract through a fake tmux backend', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()
  const { baseDir } = createFakeTmuxBin()
  const client = createPtyBrokerRustClient({
    runtimeExecutable: RUNTIME,
    env: {
      ...process.env,
      PATH: `${baseDir}:${process.env.PATH || ''}`,
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
    env: {
      ...process.env,
      TERM: 'xterm-256color',
    },
  })
  assert.equal(createSession.status, 0, createSession.stderr || createSession.stdout)

  const client = createPtyBrokerRustClient({
    runtimeExecutable: RUNTIME,
    env: {
      ...process.env,
      PATH: `${baseDir}:${process.env.PATH || ''}`,
      TERM: 'dumb',
    },
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
