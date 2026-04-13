import test from 'node:test'
import assert from 'node:assert/strict'

import { createGracefulShutdown } from '../gracefulShutdown.js'

test('graceful shutdown kills tracked children, closes servers, and exits once', async () => {
  const calls = []

  const ptyMap = new Map([
    ['main:1', { pty: { kill: (signal) => calls.push(['pty', signal]) } }],
    ['main:2', { pty: { kill: (signal) => calls.push(['pty', signal]) } }],
  ])

  const taskChildren = new Set([
    { kill: (signal) => calls.push(['task', signal]) },
    { kill: (signal) => calls.push(['task', signal]) },
  ])

  const wss = {
    clients: new Set([
      { close: (code, reason) => calls.push(['client-close', code, reason]) },
      { close: (code, reason) => calls.push(['client-close', code, reason]) },
    ]),
    close: (callback) => {
      calls.push(['wss-close'])
      callback()
    },
  }

  const server = {
    close: (callback) => {
      calls.push(['server-close'])
      callback()
    },
  }

  const exitCodes = []
  const shutdown = createGracefulShutdown({
    server,
    wss,
    ptyMap,
    taskChildren,
    exit: (code) => exitCodes.push(code),
    forceExitTimeoutMs: 0,
    log: { log: () => {}, error: () => {} },
  })

  await shutdown('SIGTERM')
  await shutdown('SIGINT')

  assert.equal(ptyMap.size, 0)
  assert.equal(taskChildren.size, 0)
  assert.equal(
    calls.filter(([kind]) => kind === 'pty').length,
    2,
  )
  assert.equal(
    calls.filter(([kind]) => kind === 'task').length,
    2,
  )
  assert.equal(
    calls.filter(([kind]) => kind === 'client-close').length,
    2,
  )
  assert.equal(
    calls.filter(([kind]) => kind === 'wss-close').length,
    1,
  )
  assert.equal(
    calls.filter(([kind]) => kind === 'server-close').length,
    1,
  )
  assert.deepEqual(exitCodes, [0])
})
