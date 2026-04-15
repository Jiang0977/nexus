import test from 'node:test'
import assert from 'node:assert/strict'

import { createPtyTmuxBroker } from '../ptyTmuxBroker.js'

function createWs() {
  return {
    readyState: 1,
    sent: [],
    send(value) {
      this.sent.push(value)
    },
  }
}

function createBroker(overrides = {}) {
  const commands = []
  const timeouts = []
  let onDataHandler = null
  let onExitHandler = null
  const ptyWrites = []
  const ptyResizes = []
  const ptyKills = []

  const ptyProc = {
    write(value) {
      ptyWrites.push(value)
    },
    resize(cols, rows) {
      ptyResizes.push([cols, rows])
    },
    kill(signal) {
      ptyKills.push(signal)
    },
    onData(handler) {
      onDataHandler = handler
    },
    onExit(handler) {
      onExitHandler = handler
    },
  }

  const broker = createPtyTmuxBroker({
    execSyncImpl: (command) => {
      commands.push(command)
      if (command.includes('has-session')) return ''
      if (command.includes('list-windows')) return '3\n7\n'
      return ''
    },
    ptyImpl: {
      spawn: () => ptyProc,
    },
    sanitizeEnv: (env, overridesEnv) => ({ ...env, ...overridesEnv }),
    resolveAttachTarget: overrides.resolveAttachTarget || ((input) => {
      if (!input.sessionExists) return { ok: false, reason: 'session_missing' }
      if (input.existingWindows.includes(input.requestedWindowIndex)) {
        return { ok: true, windowIndex: input.requestedWindowIndex }
      }
      return { ok: true, windowIndex: input.existingWindows[0] }
    }),
    setTimeoutImpl: (handler, delay) => {
      timeouts.push({ handler, delay })
      return { delay }
    },
    clearTimeoutImpl: () => {},
    log: { log: () => {}, error: () => {} },
    ...overrides,
  })

  return {
    broker,
    commands,
    timeouts,
    emitData: (value) => onDataHandler?.(value),
    emitExit: (payload) => onExitHandler?.(payload),
    ptyWrites,
    ptyResizes,
    ptyKills,
  }
}

test('attachClient falls back to the first available window and replays recent output', () => {
  const { broker, emitData } = createBroker()
  const first = createWs()

  const attached = broker.attachClient('main', 99, first)
  emitData('hello world')

  const second = createWs()
  const reused = broker.attachClient('main', 99, second)

  assert.equal(attached.key, 'main:3')
  assert.equal(reused.key, 'main:3')
  assert.deepEqual(second.sent, ['hello world'])
})

test('handleClientMessage resizes on resize payload and writes plain input to the pty', () => {
  const { broker, ptyWrites, ptyResizes } = createBroker()
  const ws = createWs()
  const { key } = broker.attachClient('main', 3, ws)

  broker.handleClientMessage(key, ws, JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))
  broker.handleClientMessage(key, ws, 'ls -la')

  assert.deepEqual(ptyResizes, [[120, 40]])
  assert.deepEqual(ptyWrites, ['ls -la'])
})

test('handleClientClose recomputes remaining size and cleans up idle ptys', () => {
  const { broker, timeouts, ptyResizes, ptyKills } = createBroker()
  const first = createWs()
  const second = createWs()
  const { key } = broker.attachClient('main', 3, first)
  broker.attachClient('main', 3, second)

  broker.handleClientMessage(key, first, JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))
  broker.handleClientMessage(key, second, JSON.stringify({ type: 'resize', cols: 90, rows: 30 }))

  broker.handleClientClose(key, first)
  assert.deepEqual(ptyResizes.at(-1), [90, 30])

  broker.handleClientClose(key, second)
  assert.equal(timeouts.length, 1)

  broker.getEntry(key).lastActivity = Date.now() - 301000
  timeouts[0].handler()
  assert.deepEqual(ptyKills, ['SIGTERM'])
  assert.equal(broker.getEntry(key), undefined)
})

test('exited ptys are removed and recreated when the tmux window still exists', () => {
  const { broker, emitExit, timeouts } = createBroker()

  broker.attachClient('main', 3, createWs())
  emitExit({ exitCode: 0 })

  assert.equal(timeouts.length, 1)
  timeouts[0].handler()

  assert.ok(broker.getEntry('main:3'))
})
