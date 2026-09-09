import test from 'node:test'
import assert from 'node:assert/strict'
import { bindTerminalInput, terminalBinaryToBytes } from '../frontend/src/terminal/terminalInput.ts'

const OPEN = typeof WebSocket !== 'undefined' ? WebSocket.OPEN : 1

function makeTerm() {
  const state = { data: null, binary: null }
  return {
    onData(cb) {
      state.data = cb
      return { dispose() { state.data = null } }
    },
    onBinary(cb) {
      state.binary = cb
      return { dispose() { state.binary = null } }
    },
    _state: state,
  }
}

test('bindTerminalInput sends text via onData when socket is open', () => {
  const sent = []
  const term = makeTerm()
  const socket = { readyState: OPEN, send(data) { sent.push(data) } }
  const dispose = bindTerminalInput(term, () => socket)
  term._state.data('hello')
  assert.deepEqual(sent, ['hello'])
  dispose()
})

test('bindTerminalInput sends binary as Uint8Array via onBinary when socket is open', () => {
  const sent = []
  const term = makeTerm()
  const socket = { readyState: OPEN, send(data) { sent.push(data) } }
  const dispose = bindTerminalInput(term, () => socket)
  term._state.binary('\x80\x81\xfe\xff')
  assert.equal(sent.length, 1)
  assert.ok(sent[0] instanceof Uint8Array)
  assert.deepEqual(sent[0], new Uint8Array([0x80, 0x81, 0xfe, 0xff]))
  dispose()
})

test('bindTerminalInput does not send when socket is closed', () => {
  const sent = []
  const term = makeTerm()
  const socket = { readyState: 3, send(data) { sent.push(data) } }
  const dispose = bindTerminalInput(term, () => socket)
  term._state.data('hello')
  term._state.binary('\x80')
  assert.equal(sent.length, 0)
  dispose()
})

test('dispose unregisters both onData and onBinary handlers', () => {
  const term = makeTerm()
  const socket = { readyState: OPEN, send() {} }
  const dispose = bindTerminalInput(term, () => socket)
  assert.equal(typeof term._state.data, 'function')
  assert.equal(typeof term._state.binary, 'function')
  dispose()
  assert.equal(term._state.data, null)
  assert.equal(term._state.binary, null)
})

test('terminalBinaryToBytes preserves every possible byte including NUL and high bytes', () => {
  const values = Array.from({ length: 256 }, (_, index) => index)
  const bytes = terminalBinaryToBytes(String.fromCharCode(...values))
  assert.ok(bytes instanceof Uint8Array)
  assert.deepEqual(bytes, new Uint8Array(values))
})
