import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createTaskRunnerRustClient } from './helpers/taskRunnerRustClient.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'fakeTaskRustRuntime.js')

function createClient(overrides = {}) {
  return createTaskRunnerRustClient({
    runtimeExecutable: process.execPath,
    runtimeArgs: [FIXTURE],
    env: {
      ...process.env,
      FAKE_TASK_RUNTIME_MODE: 'normal',
      ...overrides.env,
    },
    readyTimeoutMs: overrides.readyTimeoutMs || 500,
    log: { log() {}, error() {} },
  })
}

test('rust task client waits for ready, exposes status, and maps task events onto the runner contract', async (t) => {
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
  assert.equal(ready.source, 'fake-task-rust-runtime')
  assert.equal(ready.capabilities.tasks, true)

  const started = await client.startTask({
    taskId: 'task-1',
    prompt: 'hello',
    cwd: '/workspace/demo',
    profile: 'ops',
  })
  assert.deepEqual(started, { ok: true })

  await new Promise((resolve) => setTimeout(resolve, 40))

  assert.deepEqual(events, [
    { type: 'chunk', taskId: 'task-1', chunk: 'fake:hello', isErr: false },
    { type: 'done', taskId: 'task-1', exitCode: 0 },
  ])

  const status = await client.getStatus()
  assert.equal(status.ready, true)
  assert.equal(status.runningTasks, 0)
})

test('rust task client rejects pending ready and emits fatal when the runtime exits before readiness', async (t) => {
  const events = []
  const client = createClient({
    env: { FAKE_TASK_RUNTIME_MODE: 'exit-before-ready' },
  })
  t.after(async () => {
    await client.close()
  })

  client.onEvent((event) => {
    events.push(event)
  })

  await assert.rejects(client.ready(), /task runner rust runtime exited/)
  assert.deepEqual(events, [{
    type: 'fatal',
    message: 'task runner rust runtime exited (code=9, signal=null)',
  }])
})
