import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { chromium } from 'playwright'
import { createPtyBrokerRustClient } from './helpers/ptyBrokerRustClient.js'

const ROOT = resolve(import.meta.dirname, '..')

test('native full snapshot restores fresh xterm and saved-cursor continuation without restarting PTY', { timeout: 120000 }, async t => {
  const build = spawnSync('cargo', ['build', '--manifest-path', 'rust-runtime/Cargo.toml', '--release', '--bin', 'nexus-pty-runtime'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(build.status, 0, build.stderr)
  const base = mkdtempSync(join(tmpdir(), 'nexus-native-restore-'))
  let browser, broker
  let queue = Promise.resolve()
  let outputError
  const closed = new Set()
  t.after(async () => {
    await broker?.close()
    await queue
    await browser?.close()
    rmSync(base, { recursive: true, force: true })
  })
  const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => p && existsSync(p))
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  const page = await browser.newPage()
  await page.setContent('<div id="a"></div><div id="b"></div><div id="c"></div><div id="d"></div>')
  await page.addScriptTag({ path: join(ROOT, 'frontend/node_modules/@xterm/xterm/lib/xterm.js') })
  await page.addScriptTag({ path: join(ROOT, 'frontend/node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js') })
  await page.evaluate(() => {
    window.terminals = {}
    for (const id of ['a', 'b', 'c', 'd']) {
      const term = new window.Terminal({ cols: 120, rows: 30, allowProposedApi: true })
      term.loadAddon(new window.Unicode11Addon.Unicode11Addon())
      term.unicode.activeVersion = '11'
      term.open(document.getElementById(id))
      window.terminals[id] = term
    }
  })
  broker = createPtyBrokerRustClient({ env: { ...process.env, NEXUS_SESSION_BACKEND: 'native', NEXUS_DATA_DIR: base, NEXUS_NATIVE_SESSION_DB: join(base, 'session.db'), NEXUS_NATIVE_SCROLLBACK_DIR: join(base, 'history'), NEXUS_NATIVE_PTY_SUPERVISOR_SOCKET: '', NEXUS_NATIVE_PTY_PROGRAM: process.execPath, NEXUS_NATIVE_PTY_ARGS: join(ROOT, 'tests/fixtures/native-tui-state.cjs') }, log: { log() {}, error() {} } })
  broker.onEvent(event => {
    if (event.type === 'connectionClosed') closed.add(event.connectionId)
    if (event.type !== 'output') return
    queue = queue.then(() => page.evaluate(({ id, data, nativeState }) => new Promise(done => {
      const term = window.terminals[id]
      if (nativeState) { term.reset(); term.resize(nativeState.cols, nativeState.rows) }
      term.write(data, done)
    }), { id: event.connectionId, data: event.data, nativeState: event.nativeState })).catch(error => { outputError = error })
  })
  await broker.ready()
  const target = { session: 'restore', windowIndex: 0, cols: 120, rows: 30 }
  const snapshot = id => page.evaluate(id => {
    const t = window.terminals[id], b = t.buffer.active
    // Compare physical cells, not translateToString: xterm skips an orphaned
    // wide-tail cell after overwriting half a CJK character, while a snapshot
    // correctly paints that same blank column as a space.
    return { lines: Array.from({ length: t.rows }, (_, r) => Array.from({ length: t.cols }, (_, c) => b.getLine(b.baseY + r)?.getCell(c)?.getChars() || ' ').join('').trimEnd()), colors: Array.from({ length: t.rows }, (_, r) => b.getLine(b.baseY + r)?.getCell(0)?.getFgColor()), cursor: [b.cursorX, b.cursorY], type: b.type, mouse: t.modes.mouseTrackingMode, paste: t.modes.bracketedPasteMode }
  }, id)
  const first = await broker.attachConnection({ ...target, connectionId: 'a' })
  await page.waitForFunction(() => window.terminals.a.buffer.active.getLine(29)?.translateToString().includes('END_FRAME'))
  broker.handleConnectionMessage({ connectionId: 'a', key: first.key, rawMessage: 'u' })
  await page.waitForFunction(() => window.terminals.a.buffer.active.getLine(3)?.translateToString().includes('UNICODE_READY'))
  const second = await broker.attachConnection({ ...target, connectionId: 'b' })
  await queue
  assert.ifError(outputError)
  assert.deepEqual(await snapshot('b'), await snapshot('a'), 'reconnect must recover the complete grid, modes and cursor, not the last 2000 bytes')
  assert.equal(second.replayPolicy, 'native-snapshot')
  assert.equal(first.key, second.key)
  broker.closeConnection({ connectionId: 'a', key: first.key })
  broker.handleConnectionMessage({ connectionId: 'b', key: second.key, rawMessage: 'v' })
  // Wait for the partial CSI to reach the observer before attaching a new view.
  await new Promise(resolve => setTimeout(resolve, 100))
  await broker.getStatus()
  const third = await broker.attachConnection({ ...target, connectionId: 'c' })
  await queue
  assert.deepEqual(await snapshot('c'), await snapshot('b'))
  broker.handleConnectionMessage({ connectionId: 'c', key: third.key, rawMessage: 'w' })
  await page.waitForFunction(() => ['b', 'c'].every(id => window.terminals[id].buffer.active.getLine(4)?.translateToString().includes('PARSER_CONTINUED')))
  await queue
  assert.deepEqual(await snapshot('c'), await snapshot('b'), 'an unfinished CSI must resume on the fresh browser')
  assert.deepEqual(await page.evaluate(() => ['b', 'c'].map(id => window.terminals[id].buffer.active.getLine(4).getCell(14).getFgColor())), [0x0c2238, 0x0c2238])
  broker.handleConnectionMessage({ connectionId: 'c', key: third.key, rawMessage: 'j' })
  await page.waitForFunction(() => window.terminals.c.buffer.active.getLine(6)?.translateToString().includes('COMBINE_e'))
  const fourth = await broker.attachConnection({ ...target, connectionId: 'd' })
  await queue
  broker.handleConnectionMessage({ connectionId: 'd', key: fourth.key, rawMessage: 'k' })
  await page.waitForFunction(() => ['c', 'd'].every(id => window.terminals[id].buffer.active.getLine(6)?.translateToString().includes('_JOINED')))
  await queue
  assert.deepEqual(await snapshot('d'), await snapshot('c'), 'combining character arriving after a checkpoint must join the previous cell')
  assert.equal(await page.evaluate(() => window.terminals.d.buffer.active.getLine(4).getCell(14).getFgColor()), 0x0c2238, 'checkpoint preserves truecolor attributes')
  broker.closeConnection({ connectionId: 'd', key: fourth.key })
  broker.handleConnectionMessage({ connectionId: 'c', key: third.key, rawMessage: 'i' })
  await page.waitForFunction(() => window.terminals.c.buffer.active.getLine(8)?.translateToString().includes('中INSERT_TAIL'))
  const inserted = await broker.attachConnection({ ...target, connectionId: 'd' })
  await queue
  assert.deepEqual(await snapshot('d'), await snapshot('c'), 'wide-character insert checkpoint preserves the shifted row')
  const [restoredInsert, originalInsert] = await page.evaluate(() => {
    const row = id => Array.from({ length: 120 }, (_, col) => {
      const cell = window.terminals[id].buffer.active.getLine(8).getCell(col)
      return [cell.getChars(), cell.isBold(), cell.getFgColor()]
    })
    return [row('d'), row('c')]
  })
  assert.deepEqual(restoredInsert, originalInsert, 'wide insert must preserve cell attributes as well as text')
  broker.closeConnection({ connectionId: 'd', key: inserted.key })
  broker.handleConnectionMessage({ connectionId: 'c', key: third.key, rawMessage: 'o' })
  broker.handleConnectionMessage({ connectionId: 'c', key: third.key, rawMessage: 'n' })
  await page.waitForFunction(() => ['b', 'c'].every(id => window.terminals[id].buffer.active.getLine(2)?.translateToString().includes('CONTINUED_1')))
  await queue
  assert.deepEqual(await snapshot('c'), await snapshot('b'), 'restored saved cursor must accept identical subsequent raw output')
  broker.handleConnectionMessage({ connectionId: 'b', key: second.key, rawMessage: JSON.stringify({ type: 'resize', cols: 80, rows: 20 }) })
  await page.waitForFunction(() => ['b', 'c'].every(id => window.terminals[id].cols === 80 && window.terminals[id].rows === 20 && window.terminals[id].buffer.active.getLine(19)?.translateToString().includes('END_FRAME')))
  await queue
  assert.deepEqual(await snapshot('c'), await snapshot('b'), 'shared PTY minimum geometry must converge both views')
  await page.evaluate(() => window.terminals.c.resize(140, 40))
  broker.handleConnectionMessage({ connectionId: 'c', key: third.key, rawMessage: JSON.stringify({ type: 'resize', cols: 140, rows: 40 }) })
  await page.waitForFunction(() => window.terminals.c.cols === 80 && window.terminals.c.rows === 20)
  await queue
  assert.deepEqual(await snapshot('c'), await snapshot('b'), 'a fit on the larger client must restore the unchanged shared dimensions')
  broker.handleConnectionMessage({ connectionId: 'c', key: third.key, rawMessage: 'e' })
  await page.waitForFunction(() => ['b', 'c'].every(id => window.terminals[id].buffer.active.type === 'normal' && window.terminals[id].modes.mouseTrackingMode === 'none'))
  await queue
  assert.deepEqual(await snapshot('c'), await snapshot('b'))
  assert.ifError(outputError)
  broker.handleConnectionMessage({ connectionId: 'c', key: third.key, rawMessage: 'x' })
  for (let tries = 0; tries < 100 && !closed.has('c'); tries++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(closed.has('c'), 'native EOF must notify the browser after draining output')
})

test('native and browser Unicode width tables match', () => {
  const result = spawnSync(process.execPath, ['scripts/generate-native-unicode-width.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})
