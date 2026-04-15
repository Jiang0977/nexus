import test from 'node:test'
import assert from 'node:assert/strict'

import { createTaskRunnerSidecarClient } from '../taskRunnerSidecarClient.js'

function createFakeChild() {
  const listeners = new Map()
  const sent = []
  let killed = false

  return {
    sent,
    get killed() {
      return killed
    },
    send(message) {
      sent.push(message)
    },
    kill() {
      killed = true
      listeners.get('exit')?.(0, 'SIGTERM')
    },
    on(event, handler) {
      listeners.set(event, handler)
    },
    emit(event, ...args) {
      listeners.get(event)?.(...args)
    },
  }
}

test('sidecar client maps startTask, killTask, and task events onto the runner contract', async () => {
  const child = createFakeChild()
  const events = []
  const client = createTaskRunnerSidecarClient({
    spawnChildImpl: () => child,
    log: { log() {}, error() {} },
  })

  client.onEvent((event) => {
    events.push(event)
  })

  const startPromise = client.startTask({
    taskId: 'task-1',
    prompt: 'hello',
    cwd: '/workspace/demo',
    profile: 'ops',
  })
  const startRequest = child.sent[0]
  assert.equal(startRequest.kind, 'request')
  assert.equal(startRequest.method, 'startTask')

  child.emit('message', {
    kind: 'response',
    id: startRequest.id,
    ok: true,
    result: { ok: true },
  })

  assert.deepEqual(await startPromise, { ok: true })

  client.killTask({ taskId: 'task-1' })
  assert.deepEqual(child.sent[1], {
    kind: 'notify',
    method: 'killTask',
    params: { taskId: 'task-1' },
  })

  child.emit('message', {
    kind: 'event',
    event: 'chunk',
    params: { taskId: 'task-1', chunk: 'partial out', isErr: false },
  })
  child.emit('message', {
    kind: 'event',
    event: 'done',
    params: { taskId: 'task-1', exitCode: 0 },
  })

  assert.deepEqual(events, [
    { type: 'chunk', taskId: 'task-1', chunk: 'partial out', isErr: false },
    { type: 'done', taskId: 'task-1', exitCode: 0 },
  ])
})

test('sidecar client rejects pending startTask requests and emits fatal when the sidecar exits unexpectedly', async () => {
  const child = createFakeChild()
  const events = []
  const client = createTaskRunnerSidecarClient({
    spawnChildImpl: () => child,
    log: { log() {}, error() {} },
  })

  client.onEvent((event) => {
    events.push(event)
  })

  const pendingStart = client.startTask({
    taskId: 'task-1',
    prompt: 'hello',
    cwd: '/workspace/demo',
  })

  child.emit('exit', 1, 'SIGTERM')

  await assert.rejects(pendingStart, /task runner sidecar exited/)
  assert.deepEqual(events, [{
    type: 'fatal',
    message: 'task runner sidecar exited (code=1, signal=SIGTERM)',
  }])
})
