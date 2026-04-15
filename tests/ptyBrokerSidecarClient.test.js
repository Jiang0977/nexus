import test from 'node:test'
import assert from 'node:assert/strict'

import { createPtyBrokerSidecarClient } from '../ptyBrokerSidecarClient.js'

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
      const exitHandler = listeners.get('exit')
      exitHandler?.(0, 'SIGTERM')
    },
    on(event, handler) {
      listeners.set(event, handler)
    },
    emit(event, ...args) {
      listeners.get(event)?.(...args)
    },
  }
}

test('sidecar client maps requests, notifications, and output events onto the broker contract', async () => {
  const child = createFakeChild()
  const events = []
  const client = createPtyBrokerSidecarClient({
    spawnChildImpl: () => child,
    log: { log() {}, error() {} },
  })

  client.onEvent((event) => {
    events.push(event)
  })

  const attachedPromise = client.attachConnection({
    connectionId: 'conn-1',
    session: 'main',
    windowIndex: 3,
  })
  const attachRequest = child.sent[0]
  assert.equal(attachRequest.kind, 'request')
  assert.equal(attachRequest.method, 'attachConnection')

  child.emit('message', {
    kind: 'response',
    id: attachRequest.id,
    ok: true,
    result: { key: 'main:3' },
  })

  assert.deepEqual(await attachedPromise, { key: 'main:3' })

  client.handleConnectionMessage({
    connectionId: 'conn-1',
    key: 'main:3',
    rawMessage: 'ls',
  })
  assert.deepEqual(child.sent[1], {
    kind: 'notify',
    method: 'handleConnectionMessage',
    params: {
      connectionId: 'conn-1',
      key: 'main:3',
      rawMessage: 'ls',
    },
  })

  child.emit('message', {
    kind: 'event',
    event: 'output',
    params: { connectionId: 'conn-1', data: 'hello' },
  })

  assert.deepEqual(events, [{ type: 'output', connectionId: 'conn-1', data: 'hello' }])
})

test('sidecar client rejects pending requests and emits fatal when the sidecar exits unexpectedly', async () => {
  const child = createFakeChild()
  const events = []
  const client = createPtyBrokerSidecarClient({
    spawnChildImpl: () => child,
    log: { log() {}, error() {} },
  })

  client.onEvent((event) => {
    events.push(event)
  })

  const pendingSnapshot = client.getOutputSnapshot({ session: 'main', windowIndex: 3 })
  child.emit('exit', 1, 'SIGTERM')

  await assert.rejects(pendingSnapshot, /broker sidecar exited/)
  assert.deepEqual(events, [{ type: 'fatal', message: 'broker sidecar exited (code=1, signal=SIGTERM)' }])
})
