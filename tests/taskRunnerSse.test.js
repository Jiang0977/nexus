import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { streamTaskToSse } from '../taskRunnerSse.js'

function createFakeResponse() {
  const response = new EventEmitter()
  response.headers = new Map()
  response.writes = []
  response.ended = false
  response.setHeader = (name, value) => {
    response.headers.set(name, value)
  }
  response.write = (chunk) => {
    response.writes.push(chunk)
  }
  response.end = () => {
    response.ended = true
  }
  return response
}

test('streamTaskToSse writes start/output/error/done frames and does not kill after normal completion', () => {
  const response = createFakeResponse()
  let capturedOptions = null
  let killCalls = 0

  const result = streamTaskToSse({
    res: response,
    taskRunner: {
      runTask(prompt, cwd, options) {
        capturedOptions = { prompt, cwd, options }
        return {
          taskId: 'task-1',
          kill() {
            killCalls += 1
          },
        }
      },
    },
    prompt: 'ship it',
    cwd: '/workspace/demo',
    sessionName: 'shell',
    tmuxSession: 'alt',
    profile: 'ops',
    now: () => '2026-04-15T14:30:00.000Z',
  })

  assert.equal(result.taskId, 'task-1')
  assert.equal(typeof result.kill, 'function')
  assert.equal(response.headers.get('Content-Type'), 'text/event-stream')
  assert.equal(response.headers.get('Cache-Control'), 'no-cache')
  assert.equal(response.headers.get('Connection'), 'keep-alive')
  assert.equal(capturedOptions.prompt, 'ship it')
  assert.equal(capturedOptions.cwd, '/workspace/demo')
  assert.equal(capturedOptions.options.sessionName, 'shell')
  assert.equal(capturedOptions.options.tmuxSession, 'alt')
  assert.equal(capturedOptions.options.profile, 'ops')

  capturedOptions.options.onChunk('partial out', false)
  capturedOptions.options.onChunk('partial err', true)
  capturedOptions.options.onDone({ taskId: 'task-1', status: 'success', exitCode: 0 })
  response.emit('close')

  assert.equal(killCalls, 0)
  assert.equal(response.ended, true)
  assert.deepEqual(response.writes, [
    'event: start\ndata: {"taskId":"task-1","session_name":"shell","prompt":"ship it","createdAt":"2026-04-15T14:30:00.000Z"}\n\n',
    'event: output\ndata: {"chunk":"partial out"}\n\n',
    'event: error\ndata: {"chunk":"partial err"}\n\n',
    'event: done\ndata: {"taskId":"task-1","status":"success","exitCode":0}\n\n',
  ])
})

test('streamTaskToSse kills on response close before completion and stops writing after disconnect', () => {
  const response = createFakeResponse()
  let capturedOptions = null
  let killCalls = 0

  streamTaskToSse({
    res: response,
    taskRunner: {
      runTask(_prompt, _cwd, options) {
        capturedOptions = options
        return {
          taskId: 'task-2',
          kill() {
            killCalls += 1
          },
        }
      },
    },
    prompt: 'kill me',
    cwd: '/workspace/demo',
    now: () => '2026-04-15T00:00:00.000Z',
  })

  response.emit('close')
  capturedOptions.onChunk('ignored out', false)
  capturedOptions.onDone({ taskId: 'task-2', status: 'error', exitCode: null })

  assert.equal(killCalls, 1)
  assert.equal(response.ended, false)
  assert.deepEqual(response.writes, [
    expectStartFrame('task-2', 'kill me'),
  ])
})

function expectStartFrame(taskId, prompt) {
  return `event: start\ndata: ${JSON.stringify({
    taskId,
    session_name: '',
    prompt,
    createdAt: responseTimeString(),
  })}\n\n`
}

function responseTimeString() {
  return '2026-04-15T00:00:00.000Z'
}
