import test from 'node:test'
import assert from 'node:assert/strict'
import { connectTerminal } from '../frontend/src/terminal/terminalConnection.ts'

class FakeSocket {
  readyState = 0
  onopen = null
  onmessage = null
  onclose = null
  onerror = null
  sent = []
  closed = false

  send(data) {
    this.sent.push(JSON.parse(data))
  }

  close() {
    this.closed = true
  }
}

function createHarness() {
  const sockets = []
  const timers = new Map()
  const writes = []
  const states = []
  let nextTimer = 1
  let activeSocket = null
  const environment = {
    createSocket(url) {
      const socket = new FakeSocket()
      socket.url = url
      sockets.push(socket)
      return socket
    },
    clearTimer(timer) {
      timers.delete(timer)
    },
    setTimer(callback, delayMs) {
      const timer = nextTimer++
      timers.set(timer, { callback, delayMs })
      return timer
    },
    requestFrame(callback) {
      callback()
    },
    location: { protocol: 'https:', host: 'nexus.test' },
    openReadyState: 1,
  }
  const adapter = {
    setConnecting() {
      states.push(['connecting'])
    },
    setLive() {
      states.push(['live'])
    },
    setError(message) {
      states.push(['error', message])
    },
    reset() {
      states.push(['reset'])
    },
    fit() {},
    dimensions() {
      return { cols: 120, rows: 30 }
    },
    write(data, callback) {
      writes.push(data)
      callback?.()
    },
    shouldAutoScroll() {
      return true
    },
    scrollToBottom() {
      states.push(['scroll'])
    },
  }
  const connection = connectTerminal({
    adapter,
    environment,
    loadingDelayMs: 250,
    session: 'demo project',
    setSocket(socket) {
      activeSocket = socket
    },
    showLoadingImmediately: true,
    showLoadingOnReconnect: true,
    token: 'token value',
    windowIndex: 7,
  })

  return { connection, sockets, timers, writes, states, get activeSocket() { return activeSocket } }
}

test('terminal connection owns URL, open resize, data and cleanup behavior', () => {
  const harness = createHarness()
  const socket = harness.sockets[0]

  assert.match(socket.url, /^wss:\/\/nexus\.test\/ws\?/)
  assert.match(socket.url, /token=token%20value/)
  assert.match(socket.url, /window=7/)
  assert.match(socket.url, /session=demo%20project/)

  socket.readyState = 1
  socket.onopen()
  assert.deepEqual(socket.sent, [
    { type: 'resize', cols: 120, rows: 29 },
    { type: 'resize', cols: 120, rows: 30 },
  ])

  socket.onmessage({ data: 'hello' })
  assert.equal(harness.writes.at(-1), 'hello')
  assert.deepEqual(harness.states.at(-1), ['scroll'])

  harness.connection.dispose()
  assert.equal(socket.closed, true)
  assert.equal(harness.activeSocket, null)
})

test('terminal connection retries once then turns an unopened connection into a fatal error', () => {
  const harness = createHarness()
  const first = harness.sockets[0]

  first.onclose({ code: 1006, reason: '' })
  const retry = [...harness.timers.values()].find(({ delayMs }) => delayMs === 2000)
  assert.ok(retry)
  retry.callback()
  const second = harness.sockets[1]
  second.onclose({ code: 1006, reason: '' })

  assert.deepEqual(harness.states.at(-1), ['error', '连接失败，请重试'])
  assert.match(harness.writes.at(-1), /连接失败，请重试/)
})

test('terminal connection treats auth and application close codes as fatal without retry', () => {
  const authHarness = createHarness()
  authHarness.sockets[0].onclose({ code: 4001, reason: '' })
  assert.deepEqual(authHarness.states.at(-1), ['error', '认证失败，请刷新重新登录'])

  const appHarness = createHarness()
  appHarness.sockets[0].onclose({ code: 4400, reason: 'channel missing' })
  assert.deepEqual(appHarness.states.at(-1), ['error', '连接失败：channel missing'])
})
