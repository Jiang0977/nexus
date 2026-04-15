import test from 'node:test'
import assert from 'node:assert/strict'

import { createPtyBrokerController } from '../ptyBrokerController.js'

function createWs() {
  return {
    readyState: 1,
    sent: [],
    closed: [],
    send(value) {
      this.sent.push(value)
    },
    close(code, reason) {
      this.closed.push({ code, reason })
      this.readyState = 3
    },
  }
}

function createControllerHarness(options = {}) {
  const backendEventHandlers = []
  const attachCalls = []
  const messageCalls = []
  const closeCalls = []
  const errorCalls = []
  const snapshotCalls = []
  let closeCallCount = 0

  const backend = {
    onEvent(handler) {
      backendEventHandlers.push(handler)
    },
    async attachConnection(params) {
      attachCalls.push(params)
      if (typeof options.attachConnection === 'function') {
        return options.attachConnection(params)
      }
      return { key: 'main:3' }
    },
    handleConnectionMessage(params) {
      messageCalls.push(params)
    },
    closeConnection(params) {
      closeCalls.push(params)
    },
    errorConnection(params) {
      errorCalls.push(params)
    },
    async getOutputSnapshot(params) {
      snapshotCalls.push(params)
      return options.snapshotResult || { connected: false, output: '', clients: 0 }
    },
    async close() {
      closeCallCount += 1
    },
  }

  const controller = createPtyBrokerController({
    mode: options.mode || 'local',
    createLocalBackend: () => backend,
    createSidecarBackend: () => backend,
    log: { log() {}, error() {} },
  })

  return {
    controller,
    backend,
    attachCalls,
    messageCalls,
    closeCalls,
    errorCalls,
    snapshotCalls,
    get closeCallCount() {
      return closeCallCount
    },
    emit(event) {
      for (const handler of backendEventHandlers) handler(event)
    },
  }
}

test('attachClient routes backend output to the correct websocket and tracks client counts', async () => {
  const harness = createControllerHarness()
  const first = createWs()
  const second = createWs()

  const firstAttached = await harness.controller.attachClient('main', 99, first)
  const secondAttached = await harness.controller.attachClient('main', 3, second)

  harness.emit({ type: 'output', connectionId: harness.attachCalls[0].connectionId, data: 'hello' })
  harness.emit({ type: 'output', connectionId: harness.attachCalls[1].connectionId, data: 'world' })

  assert.equal(firstAttached.key, 'main:3')
  assert.equal(firstAttached.clientsCount, 1)
  assert.equal(secondAttached.key, 'main:3')
  assert.equal(secondAttached.clientsCount, 2)
  assert.deepEqual(first.sent, ['hello'])
  assert.deepEqual(second.sent, ['world'])
})

test('handleClientMessage, close, and error forward the stored connection identity', async () => {
  const harness = createControllerHarness()
  const ws = createWs()
  const attached = await harness.controller.attachClient('main', 3, ws)

  harness.controller.handleClientMessage(attached.key, ws, 'pwd')
  const closeResult = harness.controller.handleClientClose(attached.key, ws)
  harness.controller.handleClientError(attached.key, ws)

  assert.deepEqual(harness.messageCalls, [{
    connectionId: harness.attachCalls[0].connectionId,
    key: 'main:3',
    rawMessage: 'pwd',
  }])
  assert.deepEqual(harness.closeCalls, [{
    connectionId: harness.attachCalls[0].connectionId,
    key: 'main:3',
  }])
  assert.deepEqual(harness.errorCalls, [])
  assert.deepEqual(closeResult, { clientsCount: 0 })
})

test('getOutputSnapshot, close, and fatal backend events use the shared controller contract', async () => {
  const harness = createControllerHarness({
    mode: 'sidecar',
    snapshotResult: {
      connected: true,
      output: 'tail',
      clients: 2,
      idleMs: 1500,
    },
  })
  const ws = createWs()
  await harness.controller.attachClient('main', 3, ws)

  const snapshot = await harness.controller.getOutputSnapshot('main', 3)
  harness.emit({ type: 'fatal', message: 'broker sidecar exited' })
  await harness.controller.close()

  assert.deepEqual(snapshot, {
    connected: true,
    output: 'tail',
    clients: 2,
    idleMs: 1500,
  })
  assert.deepEqual(harness.snapshotCalls, [{ session: 'main', windowIndex: 3 }])
  assert.equal(harness.closeCallCount, 1)
  assert.deepEqual(ws.closed, [{ code: 1011, reason: 'broker unavailable' }])
})
