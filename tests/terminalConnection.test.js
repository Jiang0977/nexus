import test from 'node:test'
import assert from 'node:assert/strict'
import { connectTerminal } from '../frontend/src/terminal/terminalConnection.ts'

const stateControl = (overrides = {}) => new TextEncoder().encode(JSON.stringify({
  type: 'terminal-state', version: 1, replayPolicy: 'tmux-redraw', ...overrides,
})).buffer

const nativeControl = (overrides = {}) => stateControl({ type: 'native-state', replayPolicy: 'native-snapshot', unicodeVersion: '11', cols: 80, rows: 24, ...overrides })

test('native checkpoints serialize geometry and snapshots behind pending writes', () => {
  const h = createHarness(), socket = h.sockets[0]
  socket.readyState = 1
  socket.onopen()
  socket.onmessage({ data: nativeControl() })
  socket.onmessage({ data: '\x1bcsnapshot' })
  socket.onmessage({ data: 'delta' })
  socket.onmessage({ data: nativeControl({ cols: 60, rows: 20 }) })
  socket.onmessage({ data: '\x1bcresized' })
  assert.deepEqual(h.writes, ['\x1bcsnapshot'])
  assert.deepEqual(h.states.filter(s => s[0] === 'dimensions'), [['dimensions', 80, 24]])
  h.runWriteCallback(0)
  assert.deepEqual(h.writes, ['\x1bcsnapshot', 'delta'])
  h.runWriteCallback(1)
  assert.deepEqual(h.writes, ['\x1bcsnapshot', 'delta', '\x1bcresized'])
  assert.deepEqual(h.states.filter(s => s[0] === 'dimensions'), [['dimensions', 80, 24], ['dimensions', 60, 20]])
  socket.onmessage({ data: 'stale queued output' })
  socket.onclose({ code: 1006, reason: '' })
  h.runWriteCallback(2)
  assert.equal(h.writes.includes('stale queued output'), false)
  h.connection.dispose()
})

test('invalid, duplicate pending and mixed native controls fail closed', () => {
  for (const frames of [[nativeControl({ unicodeVersion: '6' })], [nativeControl({ cols: 501 })], [nativeControl({ rows: 0 })], [nativeControl(), nativeControl()], [stateControl(), nativeControl()], ['text', nativeControl()]]) {
    const h = createHarness(), socket = h.sockets[0]
    socket.readyState = 1
    socket.onopen()
    frames.forEach(data => socket.onmessage({ data }))
    assert.equal(socket.closeCode, 4002)
    h.connection.dispose()
  }
})

test('native render overload is bounded and stale queued output is discarded', () => {
  const h = createHarness(), socket = h.sockets[0]
  socket.readyState = 1
  socket.onopen()
  socket.onmessage({ data: nativeControl({ scrollProfile: 'application-sgr' }) })
  socket.onmessage({ data: 'pending' })
  socket.onmessage({ data: 'x'.repeat(32 * 1024 * 1024) })
  assert.equal(socket.closeCode, 1013)
  socket.onmessage({ data: 'must be discarded' })
  h.runWriteCallback(0)
  assert.deepEqual(h.writes, ['pending'])
  assert.ok(h.states.some(state => state[0] === 'profile' && state[1] === 'application-sgr'))
  h.connection.dispose()
})

test('unknown channel capability is rejected rather than guessed', () => {
  const h = createHarness(), socket = h.sockets[0]
  socket.readyState = 1
  socket.onopen()
  socket.onmessage({ data: nativeControl({ scrollProfile: 'grok' }) })
  assert.equal(socket.closeCode, 4002)
  h.connection.dispose()
})

test('tmux reconnect resets before redraw, preserves JSON-looking output and rejects stale metadata', () => {
  let geometry = { cols: 100, rows: 36 }
  const harness = createHarness({ dimensions: () => geometry })
  const first = harness.sockets[0]
  first.readyState = 1
  first.onopen()
  first.onmessage({ data: stateControl() })
  first.onmessage({ data: 'old screen' })
  first.onclose({ code: 1006, reason: '' })
  geometry = { cols: 81, rows: 24 }
  const retry = [...harness.timers.values()].find(({ delayMs }) => delayMs === 2000)
  retry.callback()
  const second = harness.sockets[1]
  assert.match(second.url, /cols=81&rows=24/)
  second.readyState = 1
  second.onopen()
  const before = harness.states.length
  first.onmessage({ data: stateControl() })
  assert.equal(harness.states.length, before)
  second.onmessage({ data: stateControl() })
  assert.deepEqual(harness.states.at(-1), ['reset'])
  const text = JSON.stringify({ type: 'terminal-state', version: 1 })
  second.onmessage({ data: text })
  assert.deepEqual(harness.writes, ['old screen', text])
  harness.connection.dispose()
})

test('unknown, malformed, duplicate and late binary controls fail closed without writing metadata', () => {
  for (const frames of [
    [stateControl({ version: 2 })],
    [new Uint8Array([255]).buffer],
    [stateControl({ replayPolicy: 'unknown' })],
    [new TextEncoder().encode('null').buffer],
    [stateControl(), stateControl()],
    ['already output', stateControl()],
  ]) {
    const harness = createHarness()
    const socket = harness.sockets[0]
    socket.readyState = 1
    socket.onopen()
    frames.forEach((data) => socket.onmessage({ data }))
    assert.equal(socket.closeCode, 4002)
    assert.deepEqual(harness.writes, frames.filter((data) => typeof data === 'string'))
    const count = harness.writes.length
    socket.onmessage({ data: 'after failure' })
    socket.onclose({ code: 4002, reason: '' })
    assert.equal(harness.writes.length, count)
    assert.equal(harness.timers.size, 0)
    harness.connection.dispose()
  }
})

test('legacy server reconnect accepts text without requiring a state control', () => {
  const harness = createHarness({ dimensions: () => ({ cols: 0, rows: 65536 }) })
  const socket = harness.sockets[0]
  assert.doesNotMatch(socket.url, /[?&](cols|rows)=/)
  socket.readyState = 1
  socket.onopen()
  socket.onmessage({ data: 'legacy terminal' })
  assert.deepEqual(harness.writes, ['legacy terminal'])
  assert.equal(socket.closed, false)
  harness.connection.dispose()
})

class FakeSocket {
  readyState = 0
  onopen = null
  onmessage = null
  onclose = null
  onerror = null
  sent = []
  closed = false
  failSend = false

  send(data) {
    if (this.failSend) {
      throw new Error('send failed')
    }
    this.sent.push(JSON.parse(data))
  }

  close(code, reason) {
    this.closed = true
    this.closeCode = code
    this.closeReason = reason
  }
}

function createHarness({ dimensions = () => ({ cols: 120, rows: 30 }) } = {}) {
  const sockets = []
  const timers = new Map()
  const writes = []
  const states = []
  const frames = []
  const writeCallbacks = []
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
      frames.push(callback)
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
    restoreDimensions(cols, rows) {
      states.push(['dimensions', cols, rows])
    },
    setScrollProfile(profile) {
      if (profile) states.push(['profile', profile])
    },
    fit() {},
    dimensions,
    write(data, callback) {
      writes.push(data)
      if (callback) writeCallbacks.push(callback)
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

  return {
    connection,
    sockets,
    timers,
    writes,
    states,
    frames,
    writeCallbacks,
    get activeSocket() {
      return activeSocket
    },
    runFrame(index) {
      const callback = frames[index]
      if (callback) callback()
    },
    runWriteCallback(index) {
      const callback = writeCallbacks[index]
      if (callback) callback()
    },
  }
}

test('terminal connection sends valid resize once per socket and resends same geometry after reconnect', () => {
  const harness = createHarness()
  const first = harness.sockets[0]

  assert.match(first.url, /^wss:\/\/nexus\.test\/ws\?/)
  assert.match(first.url, /token=token%20value/)
  assert.match(first.url, /window=7/)
  assert.match(first.url, /session=demo%20project/)
  assert.match(first.url, /terminalProtocol=2&cols=120&rows=30/)
  assert.equal(first.binaryType, 'arraybuffer')

  first.readyState = 1
  first.onopen()
  assert.deepEqual(first.sent, [
    { type: 'resize', cols: 120, rows: 30 },
  ])

  harness.runFrame(0)
  assert.deepEqual(first.sent, [
    { type: 'resize', cols: 120, rows: 30 },
  ])

  first.onclose({ code: 1006, reason: '' })
  const retry = [...harness.timers.values()].find(({ delayMs }) => delayMs === 2000)
  assert.ok(retry)
  retry.callback()

  const second = harness.sockets[1]
  second.readyState = 1
  second.onopen()
  assert.deepEqual(second.sent, [
    { type: 'resize', cols: 120, rows: 30 },
  ])

  harness.runFrame(1)
  assert.deepEqual(second.sent, [
    { type: 'resize', cols: 120, rows: 30 },
  ])
})

test('terminal connection ignores stale frame, message, error, close, timer and write callbacks after replacement or dispose', () => {
  const harness = createHarness()
  const first = harness.sockets[0]

  const initialLoadingTimer = harness.timers.get(1)
  assert.ok(initialLoadingTimer)

  first.readyState = 1
  first.onopen()
  first.onmessage({ data: 'first' })
  first.onmessage({ data: 'second' })
  harness.runWriteCallback(0)
  assert.deepEqual(harness.states.at(-1), ['scroll'])

  first.onclose({ code: 1006, reason: '' })
  const retry = [...harness.timers.values()].find(({ delayMs }) => delayMs === 2000)
  assert.ok(retry)
  retry.callback()

  const second = harness.sockets[1]
  second.readyState = 1
  second.onopen()

  // Frame 0 was from first socket; harness calls unconditionally, production code must guard it
  harness.runFrame(0)
  assert.deepEqual(second.sent, [
    { type: 'resize', cols: 120, rows: 30 },
  ])

  const writeCount = harness.writes.length
  first.onmessage({ data: 'late' })
  assert.equal(harness.writes.length, writeCount)

  const stateCount = harness.states.length
  first.onerror()
  first.onclose({ code: 1006, reason: '' })
  first.onopen()
  harness.runWriteCallback(1)
  assert.equal(harness.states.length, stateCount)

  harness.runFrame(1)
  assert.deepEqual(second.sent, [
    { type: 'resize', cols: 120, rows: 30 },
  ])

  // Dispose connection and verify queued callbacks are safely ignored
  harness.connection.dispose()
  const postDisposeStatesLength = harness.states.length
  initialLoadingTimer.callback()
  assert.equal(harness.states.length, postDisposeStatesLength)

  second.onmessage({ data: 'after dispose' })
  assert.equal(harness.writes.length, writeCount)
  second.onerror()
  second.onclose({ code: 1006, reason: '' })
  assert.equal(harness.states.length, postDisposeStatesLength)
})

test('terminal connection retries once then turns an unopened connection into a fatal error without ANSI writes', () => {
  const harness = createHarness()
  const first = harness.sockets[0]

  first.onclose({ code: 1006, reason: '' })
  const retry = [...harness.timers.values()].find(({ delayMs }) => delayMs === 2000)
  assert.ok(retry)
  retry.callback()
  const second = harness.sockets[1]
  second.onclose({ code: 1006, reason: '' })

  assert.deepEqual(harness.states.at(-1), ['error', '连接失败，请重试'])
  assert.equal(harness.writes.length, 0)
})

test('terminal connection validates integer bounds and retries resize after send failure', () => {
  const invalidCases = [null, { cols: NaN, rows: 30 }, { cols: 120.5, rows: 30 }, { cols: 0, rows: 30 }, { cols: 65536, rows: 30 }]
  for (const dims of invalidCases) {
    const harness = createHarness({ dimensions: () => dims })
    const socket = harness.sockets[0]
    socket.readyState = 1
    socket.onopen()
    assert.deepEqual(socket.sent, [])
  }

  // Failed send should not update lastResize dedup; next send should succeed
  let currentDims = { cols: 100, rows: 40 }
  const harness = createHarness({ dimensions: () => currentDims })
  const socket = harness.sockets[0]
  socket.readyState = 1
  socket.failSend = true
  socket.onopen()
  assert.deepEqual(socket.sent, [])

  socket.failSend = false
  harness.runFrame(0)
  assert.deepEqual(socket.sent, [{ type: 'resize', cols: 100, rows: 40 }])
})

test('terminal connection reports websocket error via setError and handles fatal close codes', () => {
  const errorHarness = createHarness()
  const errorSocket = errorHarness.sockets[0]
  errorSocket.onerror()
  assert.deepEqual(errorHarness.states.at(-1), ['error', 'WebSocket 错误，请等待重连'])
  assert.equal(errorHarness.writes.length, 0)

  const authHarness = createHarness()
  authHarness.sockets[0].onclose({ code: 4001, reason: '' })
  assert.deepEqual(authHarness.states.at(-1), ['error', '认证失败，请刷新重新登录'])
  assert.deepEqual(authHarness.writes, [])

  const appHarness = createHarness()
  appHarness.sockets[0].onclose({ code: 4400, reason: 'channel missing' })
  assert.deepEqual(appHarness.states.at(-1), ['error', '连接失败：channel missing'])
  assert.deepEqual(appHarness.writes, [])
})
