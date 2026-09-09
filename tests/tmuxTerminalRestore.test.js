import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'
import { createPtyBrokerRustClient } from './helpers/ptyBrokerRustClient.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`

async function waitFor(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return
    await delay(30)
  }
  assert.fail('tmux condition did not settle')
}

test('real tmux redraw restores a full TUI into fresh xterm clients without restarting the application', {
  skip: process.platform === 'win32', timeout: 120000,
}, async (t) => {
  const found = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' })
  if (found.status !== 0) return t.skip('tmux is not installed')
  const realTmux = found.stdout.trim()
  const build = spawnSync('cargo', ['build', '--manifest-path', 'rust-runtime/Cargo.toml', '--release', '--bin', 'nexus-pty-runtime'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(build.status, 0, build.stderr)
  const base = mkdtempSync(join(tmpdir(), 'nexus-tmux-restore-'))
  const socket = join(base, 'tmux.sock')
  const tmuxArgs = ['-S', socket, '-f', '/dev/null']
  const env = { ...process.env, TMUX: '', NEXUS_SESSION_BACKEND: '', NEXUS_DATA_DIR: base, PATH: `${base}:${process.env.PATH}` }
  writeFileSync(join(base, 'tmux'), `#!/bin/sh\nexec ${quote(realTmux)} -S ${quote(socket)} -f /dev/null "$@"\n`, { mode: 0o755 })
  let browser
  let broker
  let outputQueue = Promise.resolve()
  let outputError
  const closedClients = []
  t.after(async () => {
    await broker?.close()
    await outputQueue
    await browser?.close()
    spawnSync(realTmux, [...tmuxArgs, 'kill-server'], { env })
    rmSync(base, { recursive: true, force: true })
  })
  const tmux = (...args) => {
    const result = spawnSync(realTmux, [...tmuxArgs, ...args], { env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  tmux('new-session', '-d', '-s', 'restore', '-x', '100', '-y', '36', process.execPath, join(ROOT, 'tests/fixtures/tmux-tui-state.cjs'))
  tmux('set-option', '-g', 'status', 'off')
  const appPid = tmux('display-message', '-p', '-t', 'restore:0', '#{pane_pid}')
  const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium'].find((path) => path && existsSync(path))
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  const page = await browser.newPage({ viewport: { width: 1280, height: 1800 } })
  await page.setContent('<div id="a"></div><div id="b"></div><div id="c"></div>')
  await page.addStyleTag({ path: join(ROOT, 'frontend/node_modules/@xterm/xterm/css/xterm.css') })
  await page.addScriptTag({ path: join(ROOT, 'frontend/node_modules/@xterm/xterm/lib/xterm.js') })
  const keys = new Map()
  await page.exposeFunction('terminalInput', (id, data) => {
    const key = keys.get(id)
    if (key) broker.handleConnectionMessage({ connectionId: id, key, rawMessage: data })
  })
  await page.evaluate(() => {
    window.terminals = {}
    for (const id of ['a', 'b', 'c']) {
      const element = document.getElementById(id)
      element.style.cssText = 'width:1000px;height:550px'
      const term = new window.Terminal({ cols: 100, rows: 36, fontSize: 10, allowProposedApi: true })
      term.open(element)
      term.onData((data) => window.terminalInput(id, data))
      window.terminals[id] = term
    }
  })
  broker = createPtyBrokerRustClient({ env, log: { log() {}, error() {} } })
  broker.onEvent((event) => {
    if (event.type === 'connectionClosed') closedClients.push(event.connectionId)
    if (event.type !== 'output') return
    outputQueue = outputQueue.then(() => page.evaluate(({ id, data }) => new Promise((done) => {
      window.terminals[id].write(data, done)
    }), { id: event.connectionId, data: event.data })).catch((error) => { outputError = error })
  })
  await broker.ready()
  const attach = async (id) => {
    const attached = await broker.attachConnection({ connectionId: id, session: 'restore', windowIndex: 0, cols: 100, rows: 36 })
    keys.set(id, attached.key)
    assert.equal(attached.replayPolicy, 'tmux-redraw')
    await page.waitForFunction((id) => window.terminals[id].buffer.active.getLine(0)?.translateToString().includes('FRAME_READY_0'), id)
    return attached.key
  }
  const snapshot = (id) => page.evaluate((id) => {
    const term = window.terminals[id]
    const buffer = term.buffer.active
    return {
      lines: Array.from({ length: term.rows }, (_, row) => buffer.getLine(row)?.translateToString(true)),
      colors: Array.from({ length: term.rows }, (_, row) => buffer.getLine(row)?.getCell(0)?.getFgColor()),
      cursor: [buffer.cursorX, buffer.cursorY],
      mouse: term.modes.mouseTrackingMode,
      bracketedPaste: term.modes.bracketedPasteMode,
      type: buffer.type,
    }
  }, id)
  const firstKey = await attach('a')
  const secondKey = await attach('b')
  assert.notEqual(firstKey, secondKey)
  await outputQueue
  assert.ifError(outputError)
  const before = await snapshot('a')
  assert.ok(before.lines.at(-1).includes('END_FRAME'))
  assert.notEqual(before.mouse, 'none', 'tmux restores the running application mouse mode')
  assert.equal(before.bracketedPaste, true)
  assert.ok(before.lines.every((line) => !line.includes('\ufffd')), 'Unicode cells are intact')
  assert.deepEqual(await snapshot('b'), before, 'new client redraw includes every row, color, cursor and public mode')
  assert.equal((await broker.getOutputSnapshot({ session: 'restore', windowIndex: 0 })).clients, 2)
  broker.closeConnection({ connectionId: 'a', key: firstKey })
  await broker.getStatus() // ordered RPC barrier after the close notification
  assert.equal(tmux('display-message', '-p', '-t', 'restore:0', '#{pane_pid}'), appPid)
  const thirdKey = await attach('c')
  assert.notEqual(thirdKey, secondKey)
  await outputQueue
  assert.deepEqual(await snapshot('c'), await snapshot('b'))
  broker.handleConnectionMessage({ connectionId: 'c', key: thirdKey, rawMessage: 'n' })
  for (const id of ['b', 'c']) {
    await page.waitForFunction((id) => window.terminals[id].buffer.active.getLine(2)?.translateToString().includes('CONTINUED_1'), id)
  }
  await outputQueue
  assert.deepEqual(await snapshot('c'), await snapshot('b'), 'saved cursor continuation remains authoritative in tmux')
  const clientSizes = () => tmux('list-clients', '-F', '#{client_width}x#{client_height}').split('\n').sort()
  assert.deepEqual(clientSizes(), ['100x36', '100x36'])
  await page.evaluate(() => window.terminals.b.resize(71, 25))
  broker.handleConnectionMessage({ connectionId: 'b', key: secondKey, rawMessage: JSON.stringify({ type: 'resize', cols: 71, rows: 25 }) })
  await waitFor(() => clientSizes().includes('71x25'))
  for (const cols of [0, -1, 65536, 1.5, '99']) {
    broker.handleConnectionMessage({ connectionId: 'b', key: secondKey, rawMessage: JSON.stringify({ type: 'resize', cols, rows: 20 }) })
  }
  await broker.getStatus()
  assert.deepEqual(clientSizes(), ['100x36', '71x25'], 'resize is per client and invalid dimensions never wrap')
  broker.handleConnectionMessage({ connectionId: 'c', key: thirdKey, rawMessage: 'e' })
  for (const id of ['b', 'c']) {
    await page.waitForFunction((id) => window.terminals[id].modes.mouseTrackingMode === 'none', id)
  }
  assert.equal(tmux('display-message', '-p', '-t', 'restore:0', '#{pane_pid}'), appPid)
  // Unexpected tmux client exit produces one targeted close, not a hung socket.
  const smallerClient = tmux('list-clients', '-F', '#{client_width}|#{client_name}').split('\n').find((line) => line.startsWith('71|')).split('|')[1]
  tmux('detach-client', '-t', smallerClient)
  await waitFor(() => closedClients.includes('b'))
  assert.ok(!closedClients.includes('c'))
  await waitFor(async () => (await broker.getOutputSnapshot({ session: 'restore', windowIndex: 0 })).clients === 1)
  // Production mouse=on delegates normal history scrolling to tmux copy mode.
  tmux('set-option', '-g', 'mouse', 'on')
  broker.handleConnectionMessage({ connectionId: 'c', key: thirdKey, rawMessage: 'h' })
  await page.waitForFunction(() => window.terminals.c.modes.mouseTrackingMode !== 'none'
    && Array.from({ length: window.terminals.c.rows }, (_, row) => window.terminals.c.buffer.active.getLine(row)?.translateToString()).some((line) => line?.includes('HISTORY_149')))
  await page.locator('#c .xterm-screen').scrollIntoViewIfNeeded()
  const screen = await page.locator('#c .xterm-screen').boundingBox()
  const historyTop = (await snapshot('c')).lines[0]
  await page.mouse.move(screen.x + 30, screen.y + 30)
  await page.mouse.wheel(0, -600)
  await waitFor(() => tmux('display-message', '-p', '-t', 'restore:0', '#{pane_in_mode}') === '1')
  // With tmux's default bindings the first wheel enters copy mode; subsequent
  // wheel input moves history. This is distinct from xterm's own scrollback.
  await page.mouse.wheel(0, -600)
  await page.waitForFunction((previous) => {
    const firstLine = window.terminals.c.buffer.active.getLine(0)?.translateToString(true)
    const before = previous.match(/HISTORY_(\d+)/)
    const after = firstLine?.match(/HISTORY_(\d+)/)
    return before && after && Number(after[1]) < Number(before[1])
  }, historyTop, { timeout: 5000 }).catch(async (error) => {
    throw new Error(`${error.message}; before=${historyTop}; after=${JSON.stringify((await snapshot('c')).lines)}; pane=${tmux('display-message', '-p', '-t', 'restore:0', '#{history_size}|#{pane_height}|#{scroll_position}')}`)
  })
  broker.errorConnection({ connectionId: 'c', key: thirdKey })
  await waitFor(async () => (await broker.getStatus()).runningPtys === 0)
  assert.equal(tmux('display-message', '-p', '-t', 'restore:0', '#{pane_pid}'), appPid)
  assert.equal(tmux('list-sessions', '-F', '#{session_name}'), 'restore', 'all private groups cleaned, original session survives')
  assert.ifError(outputError)
})
