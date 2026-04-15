import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { createTaskRunner, createTaskStore } from '../taskRunner.js'

test('task store trims history, deletes tasks, and marks running tasks as interrupted', () => {
  const files = new Map()
  const tasksFile = '/tmp/tasks.json'

  const store = createTaskStore({
    tasksFile,
    maxTasks: 2,
    existsSyncImpl: (path) => files.has(path),
    readFileSyncImpl: (path) => files.get(path),
    writeFileSyncImpl: (path, value) => files.set(path, value),
  })

  store.saveTasks([{ id: '1' }, { id: '2' }, { id: '3' }])
  assert.deepEqual(store.loadTasks().map(task => task.id), ['2', '3'])

  store.deleteTask('2')
  assert.deepEqual(store.loadTasks().map(task => task.id), ['3'])

  store.saveTasks([{ id: 'run', status: 'running' }, { id: 'done', status: 'success' }])
  const changed = store.markRunningTasksInterrupted('(服务重启，任务中断)')
  const tasks = store.loadTasks()

  assert.equal(changed, true)
  assert.equal(tasks[0].status, 'error')
  assert.equal(tasks[0].error, '(服务重启，任务中断)')
  assert.equal(tasks[1].status, 'success')
})

test('task runner persists lifecycle and streams output through callbacks', async () => {
  const taskUpdates = new Map()
  const taskStore = {
    appendTask(task) {
      taskUpdates.set(task.id, { ...task })
    },
    updateTask(id, updates) {
      taskUpdates.set(id, { ...taskUpdates.get(id), ...updates })
    },
  }

  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killCalls = []
  child.kill = function(signal) {
    this.killCalls.push(signal ?? 'default')
    this.killed = true
  }

  const activeTaskChildren = new Set()
  const chunks = []
  let donePayload = null

  const runner = createTaskRunner({
    taskStore,
    taskChildren: activeTaskChildren,
    spawnImpl: () => child,
    sanitizeEnv: (env, overrides) => ({ ...env, ...overrides }),
    envSource: { BASE: '1' },
    claudeProxy: 'http://127.0.0.1:6789',
    now: () => '2026-04-15T14:30:00.000Z',
    random: () => 0.123456,
    defaultTmuxSession: 'main',
  })

  const { taskId, kill } = runner.runTask('hello world', '/workspace/demo', {
    sessionName: 'shell',
    source: 'telegram',
    tmuxSession: 'alt',
    profile: 'ops',
    onChunk: (chunk, isErr) => chunks.push([chunk, isErr]),
    onDone: (payload) => {
      donePayload = payload
    },
  })

  assert.equal(activeTaskChildren.size, 1)
  assert.equal(taskUpdates.get(taskId).status, 'running')
  assert.equal(taskUpdates.get(taskId).tmux_session, 'alt')

  child.stdout.emit('data', Buffer.from('partial out'))
  child.stderr.emit('data', Buffer.from('partial err'))
  child.emit('close', 0)
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(chunks, [
    ['partial out', false],
    ['partial err', true],
  ])
  assert.equal(activeTaskChildren.size, 0)
  assert.equal(taskUpdates.get(taskId).status, 'success')
  assert.equal(taskUpdates.get(taskId).output, 'partial out')
  assert.equal(taskUpdates.get(taskId).error, 'partial err')
  assert.deepEqual(donePayload, {
    taskId,
    status: 'success',
    output: 'partial out',
    errorOutput: 'partial err',
    exitCode: 0,
  })

  kill()
  assert.deepEqual(child.killCalls, ['default'])
})
