import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createWindowLaunchRustClient } from './helpers/windowLaunchRustClient.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'fakeWindowLaunchRustRuntime.js')

function createClient(overrides = {}) {
  return createWindowLaunchRustClient({
    runtimeExecutable: process.execPath,
    runtimeArgs: [FIXTURE],
    env: {
      ...process.env,
      FAKE_WINDOW_LAUNCH_RUNTIME_MODE: 'normal',
      ...overrides.env,
    },
    readyTimeoutMs: overrides.readyTimeoutMs || 500,
    log: { log() {}, error() {} },
  })
}

test('rust window launch client waits for ready, launches windows, and exposes status', async (t) => {
  const events = []
  const client = createClient()
  t.after(async () => {
    await client.close()
  })

  client.onEvent((event) => {
    events.push(event)
  })

  const ready = await client.ready()
  assert.equal(ready.ready, true)
  assert.equal(ready.source, 'fake-window-launch-rust-runtime')
  assert.equal(ready.capabilities.launch, true)

  const launched = await client.launchWindow({
    sessionName: 'main',
    cwd: '/workspace/apps/demo',
    name: 'workspace-apps-demo',
    shellCmd: 'exec zsh -i',
    defaultShellCmd: 'exec zsh -i',
    proxyVars: { HTTPS_PROXY: 'http://proxy.local' },
    updateSessionCwd: true,
  })
  assert.deepEqual(launched, { ok: true })
  assert.deepEqual(events, [])

  const status = await client.getStatus()
  assert.equal(status.ready, true)
  assert.equal(status.launches, 1)
})

test('rust window launch client rejects pending ready and emits fatal when the runtime exits before readiness', async (t) => {
  const events = []
  const client = createClient({
    env: { FAKE_WINDOW_LAUNCH_RUNTIME_MODE: 'exit-before-ready' },
  })
  t.after(async () => {
    await client.close()
  })

  client.onEvent((event) => {
    events.push(event)
  })

  await assert.rejects(client.ready(), /window launch rust runtime exited/)
  assert.deepEqual(events, [{
    type: 'fatal',
    message: 'window launch rust runtime exited (code=9, signal=null)',
  }])
})
