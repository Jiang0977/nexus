import test from 'node:test'
import assert from 'node:assert/strict'

import { createTaskRunnerController } from '../taskRunnerController.js'

function createHarness(overrides = {}) {
  const startCalls = []
  const killCalls = []
  const appendCalls = []
  const updateCalls = []
  const tasks = new Map()
  const eventHandlers = []
  let closeCount = 0

  const backend = {
    onEvent(handler) {
      eventHandlers.push(handler)
    },
    startTask(params) {
      startCalls.push(params)
      if (typeof overrides.startTask === 'function') {
        return overrides.startTask(params)
      }
      return { ok: true }
    },
    killTask(params) {
      killCalls.push(params)
    },
    async close() {
      closeCount += 1
    },
  }

  const taskStore = {
    appendTask(task) {
      appendCalls.push(task)
      tasks.set(task.id, { ...task })
    },
    updateTask(id, updates) {
      updateCalls.push({ id, updates })
      tasks.set(id, { ...tasks.get(id), ...updates })
    },
  }

  const controller = createTaskRunnerController({
    taskStore,
    defaultTmuxSession: 'main',
    now: () => '2026-04-15T18:30:00.000Z',
    dateNow: () => 1713205800000,
    random: () => 0.123456,
    mode: overrides.mode || 'local',
    createLocalBackend: () => backend,
    createSidecarBackend: () => backend,
    log: { log() {}, error() {} },
  })

  return {
    controller,
    startCalls,
    killCalls,
    appendCalls,
    updateCalls,
    tasks,
    get closeCount() {
      return closeCount
    },
    emit(event) {
      for (const handler of eventHandlers) handler(event)
    },
  }
}

test('runTask persists lifecycle in the main process and routes chunk/done events through callbacks', async () => {
  const harness = createHarness()
  const chunks = []
  let donePayload = null

  const taskResult = harness.controller.runTask('hello world', '/workspace/demo', {
    sessionName: 'shell',
    source: 'telegram',
    tmuxSession: 'alt',
    profile: 'ops',
    onChunk: (chunk, isErr) => chunks.push([chunk, isErr]),
    onDone: (payload) => {
      donePayload = payload
    },
  })

  assert.equal(harness.appendCalls.length, 1)
  assert.equal(harness.appendCalls[0].status, 'running')
  assert.equal(harness.appendCalls[0].tmux_session, 'alt')
  assert.deepEqual(harness.startCalls, [{
    taskId: taskResult.taskId,
    prompt: 'hello world',
    cwd: '/workspace/demo',
    profile: 'ops',
  }])

  harness.emit({ type: 'chunk', taskId: taskResult.taskId, chunk: 'partial out', isErr: false })
  harness.emit({ type: 'chunk', taskId: taskResult.taskId, chunk: 'partial err', isErr: true })
  harness.emit({ type: 'done', taskId: taskResult.taskId, exitCode: 0 })

  assert.deepEqual(chunks, [
    ['partial out', false],
    ['partial err', true],
  ])
  assert.equal(harness.tasks.get(taskResult.taskId).status, 'success')
  assert.equal(harness.tasks.get(taskResult.taskId).output, 'partial out')
  assert.equal(harness.tasks.get(taskResult.taskId).error, 'partial err')
  assert.deepEqual(donePayload, {
    taskId: taskResult.taskId,
    status: 'success',
    output: 'partial out',
    errorOutput: 'partial err',
    exitCode: 0,
  })
})

test('runTask handles backend start failures in the main-process task store', async () => {
  const harness = createHarness({
    startTask: async () => {
      throw new Error('spawn failed')
    },
  })
  let donePayload = null

  const taskResult = harness.controller.runTask('will fail', '/workspace/demo', {
    onDone: (payload) => {
      donePayload = payload
    },
  })

  await new Promise(resolve => setImmediate(resolve))

  assert.equal(harness.tasks.get(taskResult.taskId).status, 'error')
  assert.equal(harness.tasks.get(taskResult.taskId).error, 'spawn failed')
  assert.deepEqual(donePayload, {
    taskId: taskResult.taskId,
    status: 'error',
    output: '',
    errorOutput: 'spawn failed',
    exitCode: null,
  })
})

test('kill forwards to the backend and sidecar fatal events fail all running tasks', async () => {
  const harness = createHarness({ mode: 'sidecar' })
  let donePayload = null

  const taskResult = harness.controller.runTask('long running', '/workspace/demo', {
    onDone: (payload) => {
      donePayload = payload
    },
  })

  taskResult.kill()
  assert.deepEqual(harness.killCalls, [{ taskId: taskResult.taskId }])

  harness.emit({ type: 'fatal', message: 'task runner sidecar exited' })
  assert.equal(harness.tasks.get(taskResult.taskId).status, 'error')
  assert.equal(harness.tasks.get(taskResult.taskId).error, 'task runner sidecar exited')
  assert.deepEqual(donePayload, {
    taskId: taskResult.taskId,
    status: 'error',
    output: '',
    errorOutput: 'task runner sidecar exited',
    exitCode: null,
  })

  await harness.controller.close()
  assert.equal(harness.closeCount, 1)
})
