import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { installRuntimeGuards } from '../runtimeGuards.js'

class FakeProcess extends EventEmitter {}

test('signal handlers invoke shutdown and only exit when shutdown fails', async () => {
  const processLike = new FakeProcess()
  const server = new EventEmitter()
  const calls = []
  let rejectShutdown = false

  installRuntimeGuards({
    processLike,
    server,
    signals: ['SIGTERM'],
    shutdown: async (signal) => {
      calls.push(['shutdown', signal])
      if (rejectShutdown) throw new Error('boom')
    },
    exit: (code) => calls.push(['exit', code]),
    log: { error: (...args) => calls.push(['error', ...args]), log: () => {} },
  })

  processLike.emit('SIGTERM')
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(calls, [['shutdown', 'SIGTERM']])

  rejectShutdown = true
  processLike.emit('SIGTERM')
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(calls.filter(([kind]) => kind === 'shutdown').length, 2)
  assert.deepEqual(calls.at(-1), ['exit', 1])
})

test('process-level errors exit the process with code 1', () => {
  const processLike = new FakeProcess()
  const server = new EventEmitter()
  const exits = []
  const errors = []

  installRuntimeGuards({
    processLike,
    server,
    shutdown: async () => {},
    exit: (code) => exits.push(code),
    log: { error: (...args) => errors.push(args), log: () => {} },
  })

  processLike.emit('uncaughtException', new Error('uncaught'))
  processLike.emit('unhandledRejection', new Error('rejected'))
  server.emit('error', new Error('listen-failed'))

  assert.deepEqual(exits, [1, 1, 1])
  assert.equal(errors.length, 3)
})
