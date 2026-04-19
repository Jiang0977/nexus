import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

import { createWindowLaunchRustClient } from './helpers/windowLaunchRustClient.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME = join(
  ROOT,
  'rust-runtime',
  'target',
  'release',
  process.platform === 'win32' ? 'nexus-window-launch-runtime.exe' : 'nexus-window-launch-runtime',
)
let buildChecked = false

function ensureBuilt() {
  if (buildChecked && existsSync(RUNTIME)) return
  const build = spawnSync('npm', ['run', 'build:rust-launch-runtime'], {
    cwd: ROOT,
    encoding: 'utf8',
  })

  assert.equal(build.status, 0, build.stderr || build.stdout)
  assert.equal(existsSync(RUNTIME), true)
  buildChecked = true
}

function createFakeTmuxBin() {
  const baseDir = mkdtempSync(join(tmpdir(), 'nexus-fake-launch-tmux-'))
  const logFile = join(baseDir, 'tmux.log')
  const tmuxPath = join(baseDir, 'tmux')
  writeFileSync(tmuxPath, `#!/bin/sh
set -eu
log_file="${logFile}"
cmd="$1"
shift || true
printf '%s|%s\n' "$cmd" "$*" >> "$log_file"
case "$cmd" in
  has-session)
    if [ "\${FAKE_TMUX_HAS_SESSION:-1}" = "1" ]; then
      exit 0
    fi
    exit 1
    ;;
  set-environment|new-window|new-session)
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
`, { mode: 0o755 })
  return { baseDir, logFile }
}

function createClient(baseDir, extraEnv = {}) {
  return createWindowLaunchRustClient({
    runtimeExecutable: RUNTIME,
    env: {
      ...process.env,
      PATH: `${baseDir}:${process.env.PATH || ''}`,
      ...extraEnv,
    },
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })
}

test('real rust launch runtime updates tmux env and opens a window when the session exists', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()
  const { baseDir, logFile } = createFakeTmuxBin()
  const client = createClient(baseDir, { FAKE_TMUX_HAS_SESSION: '1' })

  t.after(async () => {
    await client.close()
    rmSync(baseDir, { recursive: true, force: true })
  })

  const ready = await client.ready()
  assert.equal(ready.ready, true)

  const result = await client.launchWindow({
    sessionName: 'main',
    cwd: '/workspace/apps/demo',
    name: 'workspace-apps-demo',
    shellCmd: 'shell:codex:work:/workspace/apps/demo',
    defaultShellCmd: 'exec zsh -i',
    proxyVars: { HTTPS_PROXY: 'http://proxy.local' },
    updateSessionCwd: true,
  })
  assert.deepEqual(result, { ok: true })

  const status = await client.getStatus()
  assert.equal(status.launches, 1)

  const log = readFileSync(logFile, 'utf8')
  assert.match(log, /has-session\|-t main/)
  assert.match(log, /set-environment\|-t main NEXUS_CWD \/workspace\/apps\/demo/)
  assert.match(log, /set-environment\|-t main HTTPS_PROXY http:\/\/proxy\.local/)
  assert.match(log, /new-window\|-t main -c \/workspace\/apps\/demo -n workspace-apps-demo shell:codex:work:\/workspace\/apps\/demo/)
})

test('real rust launch runtime creates a missing tmux session before opening a window', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()
  const { baseDir, logFile } = createFakeTmuxBin()
  const client = createClient(baseDir, { FAKE_TMUX_HAS_SESSION: '0' })

  t.after(async () => {
    await client.close()
    rmSync(baseDir, { recursive: true, force: true })
  })

  await client.ready()
  const result = await client.launchWindow({
    sessionName: 'missing-session',
    cwd: '/workspace/current',
    name: 'workspace-current',
    shellCmd: 'exec zsh -i',
    defaultShellCmd: 'exec zsh -i',
    proxyVars: {},
    updateSessionCwd: false,
  })
  assert.deepEqual(result, { ok: true })

  const log = readFileSync(logFile, 'utf8')
  assert.match(log, /has-session\|-t missing-session/)
  assert.match(log, /new-session\|-d -s missing-session -n shell exec zsh -i/)
  assert.match(log, /new-window\|-t missing-session -c \/workspace\/current -n workspace-current exec zsh -i/)
})
