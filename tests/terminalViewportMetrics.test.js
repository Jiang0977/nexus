import test from 'node:test'
import assert from 'node:assert/strict'
import { bindTerminalViewportMetrics } from '../frontend/src/terminal/terminalViewportMetrics.ts'

test('terminal metrics follow public buffer writes, scrolling and resize, then dispose', () => {
  const listeners = new Map()
  const subscribe = (name) => (listener) => {
    listeners.set(name, listener)
    return { dispose() { listeners.delete(name) } }
  }
  const term = {
    rows: 24,
    buffer: { active: { viewportY: 80, baseY: 80 } },
    onScroll: subscribe('scroll'),
    onWriteParsed: subscribe('write'),
    onResize: subscribe('resize'),
  }
  let writes = 0
  const container = { dataset: new Proxy({}, {
    set(target, key, value) { writes++; target[key] = value; return true },
  }) }
  const dispose = bindTerminalViewportMetrics(term, container)
  assert.deepEqual({ ...container.dataset }, {
    terminalViewportY: '80', terminalBaseY: '80', terminalRows: '24',
  })
  listeners.get('write')()
  assert.equal(writes, 3, 'unchanged output does not mutate the DOM')
  term.buffer.active.viewportY = 60
  listeners.get('scroll')()
  assert.equal(container.dataset.terminalViewportY, '60')
  term.buffer.active.baseY = 100
  listeners.get('write')()
  assert.equal(container.dataset.terminalBaseY, '100')
  assert.equal(container.dataset.terminalViewportY, '60')
  term.rows = 32
  listeners.get('resize')()
  assert.equal(container.dataset.terminalRows, '32')
  dispose()
  assert.equal(listeners.size, 0)
  assert.deepEqual({ ...container.dataset }, {})
})
