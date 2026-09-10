// Real native supervisor/server/browser acceptance. Default isolated; --live
// uses the local e2e secret and creates/deletes only its own temporary project.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import bcrypt from 'bcrypt'
import { chromium } from 'playwright'
import WebSocket from 'ws'
import { DatabaseSync } from 'node:sqlite'

const root = resolve(import.meta.dirname, '..')
const live = process.argv.includes('--live')
if (live && !process.env.NEXUS_ACCEPTANCE_NATIVE_DB) throw new Error('Set NEXUS_ACCEPTANCE_NATIVE_DB to the live native session database path')
const evidence = mkdtempSync(join(tmpdir(), 'nexus-native-acceptance-'))
const workspaceParent = live ? join(root, '.context/tasks/native-final-acceptance') : evidence
mkdirSync(workspaceParent, { recursive: true })
const workspace = mkdtempSync(join(workspaceParent, 'native-acceptance-'))
const password = live
  ? readFileSync(join(root, '.context/secrets/e2e.env'), 'utf8').split(/\r?\n/).find(line => line.startsWith('NEXUS_E2E_PASSWORD=')).slice(19).trim().replace(/^(['"])(.*)\1$/, '$2')
  : randomBytes(24).toString('hex')
let base = process.env.NEXUS_E2E_BASE_URL || 'http://127.0.0.1:59000'
let server, supervisor, browser, project, client, env, auth
const checks = []
const pageErrors = []
let clientClose
const log = []
const waitFor = async (check, label, timeout = 20000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await delay(100) }
  throw new Error(`Timed out: ${label}`)
}
const start = (name, environment) => {
  const child = spawn(join(root, 'rust-runtime/target/release', name), [], { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', data => { if (log.length < 500) log.push(String(data)) })
  child.stderr.on('data', data => { if (log.length < 500) log.push(String(data)) })
  return child
}
const stop = async child => {
  if (!child || child.exitCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  await Promise.race([exited, delay(5000)])
  if (child.exitCode === null) { child.kill('SIGKILL'); await exited }
}
const api = async (path, method = 'GET', body) => {
  const response = await fetch(`${base}${path}`, { method, headers: { ...auth, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  assert.equal(response.status, 200, `${method} ${path} status`)
  return response.json()
}
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
const dismissSetup = async page => {
  const later = page.getByRole('button', { name: '稍后设置', exact: true })
  if (await later.isVisible()) await later.click()
}
const processPid = () => {
  const path = live ? process.env.NEXUS_ACCEPTANCE_NATIVE_DB : env.NEXUS_NATIVE_SESSION_DB
  const db = new DatabaseSync(path, { readOnly: true })
  try { return db.prepare('SELECT os_pid FROM process_instances WHERE project_name = ? AND channel_index = 0 AND status = ? ORDER BY id DESC LIMIT 1').get(project, 'running')?.os_pid }
  finally { db.close() }
}

try {
  if (!live) {
    const listener = createServer().listen(0, '127.0.0.1')
    await once(listener, 'listening')
    const port = listener.address().port
    await new Promise(resolve => listener.close(resolve))
    base = `http://127.0.0.1:${port}`
    const data = join(evidence, 'data')
    mkdirSync(data)
    env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), NEXUS_PROJECT_ROOT: root, WORKSPACE_ROOT: evidence, NEXUS_DATA_DIR: data,
      NEXUS_SESSION_BACKEND: 'native', NEXUS_NATIVE_SESSION_DB: join(data, 'session.db'), NEXUS_NATIVE_SCROLLBACK_DIR: join(data, 'history'),
      NEXUS_NATIVE_PTY_SUPERVISOR_SOCKET: join(data, 'supervisor.sock'),
      NEXUS_CODEX_HISTORY_ENABLED: '0', JWT_SECRET: randomBytes(32).toString('hex'), ACC_PASSWORD_HASH: await bcrypt.hash(password, 8),
      NEXUS_PTY_BROKER_RUST_EXECUTABLE: join(root, 'rust-runtime/target/release/nexus-pty-runtime'),
      NEXUS_SESSION_MANAGEMENT_RUST_EXECUTABLE: join(root, 'rust-runtime/target/release/nexus-session-runtime'),
      NEXUS_WINDOW_LAUNCH_RUST_EXECUTABLE: join(root, 'rust-runtime/target/release/nexus-window-launch-runtime'),
    }
    delete env.NEXUS_NATIVE_PTY_PROGRAM
    delete env.NEXUS_NATIVE_PTY_ARGS
    supervisor = start('nexus-native-pty-supervisor', env)
    server = start('nexus-server', env)
  }
  await waitFor(async () => { try { return (await fetch(`${base}/api/health`)).ok } catch { return false } }, 'server health')
  assert.equal((await fetch(`${base}/api/version`)).status, 401)
  const login = await api('/api/auth/login', 'POST', { password })
  auth = { Authorization: `Bearer ${login.token}` }
  const backend = await api('/api/config')
  assert.equal(backend.sessionBackend, 'native')
  checks.push('health_auth_native_backend')
  const existingProjectNames = new Set((await api('/api/projects')).map(item => item.name))
  const created = await api('/api/projects', 'POST', { path: relative(backend.workspaceRoot, workspace), shell_type: 'bash' })
  assert.equal(resolve(created.path), workspace, 'acceptance project must point at the owned temporary directory')
  assert.ok(created.name && !existingProjectNames.has(created.name), 'acceptance must create a new project, never reuse an existing one')
  project = created.name
  const url = new URL('/ws', base.replace(/^http/, 'ws'))
  url.search = new URLSearchParams({ token: login.token, session: project, window: '0', terminalProtocol: '2', cols: '120', rows: '30' })
  client = new WebSocket(url)
  client.on('close', (code, reason) => { clientClose = { code, reason: reason.toString() } })
  const controls = []
  client.on('message', (data, binary) => { if (binary) controls.push(JSON.parse(data.toString())) })
  await once(client, 'open')
  await waitFor(() => controls.some(control => control.replayPolicy === 'native-snapshot'), 'native checkpoint handshake')
  const legacyUrl = new URL(url)
  legacyUrl.searchParams.delete('terminalProtocol')
  const legacy = new WebSocket(legacyUrl)
  const [legacyCode] = await once(legacy, 'close')
  assert.equal(legacyCode, 4002, 'old clients must not render a dimensionless native checkpoint')
  checks.push('old_native_protocol_fails_closed')
  const originalPid = processPid()
  assert.ok(originalPid > 0)
  await delay(500)
  client.send(`${quote(process.execPath)} ${quote(join(root, 'tests/fixtures/native-tui-state.cjs'))}\r`)
  browser = await chromium.launch({ ...(process.env.NEXUS_BROWSER_EXECUTABLE ? { executablePath: process.env.NEXUS_BROWSER_EXECUTABLE } : {}), headless: true })
  async function openPage(mobile) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 950 }, isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block' })
    let layout = { version: 1, mode: 'vertical', focusedPaneId: 'pane-1', panes: [{ id: 'pane-1', target: { session: project, windowIndex: 0 } }, { id: 'pane-2', target: { session: project, windowIndex: 0 } }], updatedAt: new Date().toISOString() }
    // Only personal layout storage is isolated. Auth/catalog/PTY/assets are real.
    await context.route('**/api/workspace-layouts/active', async route => {
      if (route.request().method() === 'PUT') layout = route.request().postDataJSON()
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(layout) })
    })
    await context.addInitScript(({ project }) => {
      localStorage.setItem('nexus_session', project)
      localStorage.setItem('nexus_session_source', 'user')
      localStorage.setItem('nexus_window', '0')
      localStorage.setItem('nexus_guide_seen', 'true')
      localStorage.setItem('nexus_sidebar_collapsed', 'true')
      window.__nativeSockets = []
      const Original = window.WebSocket
      window.WebSocket = new Proxy(Original, { construct(target, args) {
        const socket = Reflect.construct(target, args)
        socket.__controls = []
        socket.addEventListener('message', event => {
          if (event.data instanceof ArrayBuffer) socket.__controls.push(JSON.parse(new TextDecoder().decode(event.data)))
        })
        window.__nativeSockets.push(socket)
        return socket
      } })
    }, { project })
    const page = await context.newPage()
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.goto(base)
    await page.locator('input[type=password]').fill(password)
    await page.locator('button[type=submit]').click()
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('FRAME_READY_0'))
    await dismissSetup(page)
    return page
  }
  const desktop = await openPage(false)
  const mobile = await openPage(true)
  await waitFor(async () => (await desktop.locator('.xterm-rows').allTextContents()).every(text => text.includes('FRAME_READY_0')), 'split panes and mobile redraw')
  checks.push('real_desktop_split_and_mobile_native_render')
  client.send('n')
  for (const page of [desktop, mobile]) await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('FRAME_READY_1'))
  await mobile.reload()
  if (await mobile.locator('input[type=password]').isVisible()) {
    await mobile.locator('input[type=password]').fill(password)
    await mobile.locator('button[type=submit]').click()
  }
  await mobile.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('FRAME_READY_1'))
  await dismissSetup(mobile)
  checks.push('refresh_preserves_application_process_and_counter')
  const count = await desktop.evaluate(() => window.__nativeSockets.length)
  await desktop.evaluate(() => window.__nativeSockets.find(socket => socket.readyState === 1).close())
  await desktop.waitForFunction(count => window.__nativeSockets.length > count && window.__nativeSockets.some(socket => socket.readyState === 1 && socket.__controls.some(c => c.replayPolicy === 'native-snapshot')), count)
  await desktop.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('FRAME_READY_1'))
  checks.push('websocket_reconnect_without_application_restart')
  if (!live) {
    const beforeRestart = await desktop.evaluate(() => window.__nativeSockets.length)
    await stop(server)
    server = start('nexus-server', env)
    await waitFor(async () => { try { return (await fetch(`${base}/api/health`)).ok } catch { return false } }, 'server restart')
    await desktop.waitForFunction(count => window.__nativeSockets.length > count && window.__nativeSockets.some(socket => socket.readyState === 1 && socket.__controls.length > 0), beforeRestart)
    await desktop.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('FRAME_READY_1'))
    checks.push('server_restart_keeps_supervised_native_application')
  }
  assert.equal(processPid(), originalPid, 'native PTY PID must survive browser and server reconnects')
  checks.push('registry_process_pid_unchanged')
  const timings = []
  for (let batch = 0; batch < 20; batch++) {
    await Promise.all(Array.from({ length: 3 }, async () => {
      const started = performance.now()
      const ws = new WebSocket(url)
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('native churn timeout')), 10000)
          let metadata = false
          ws.on('error', () => { clearTimeout(timer); reject(new Error('native churn connection failed')) })
          ws.on('message', (data, binary) => {
            if (binary) metadata = JSON.parse(data.toString()).replayPolicy === 'native-snapshot'
            else if (metadata) { clearTimeout(timer); resolve() }
          })
        })
        timings.push(performance.now() - started)
      } finally {
        if (ws.readyState !== WebSocket.CLOSED) {
          const closed = once(ws, 'close')
          ws.close()
          await Promise.race([closed, delay(2000)])
          if (ws.readyState !== WebSocket.CLOSED) ws.terminate()
        }
      }
    }))
  }
  assert.equal(processPid(), originalPid)
  timings.sort((a, b) => a - b)
  writeFileSync(join(evidence, 'churn.json'), JSON.stringify({ connections: timings.length, p95Ms: timings[56], maxMs: timings.at(-1), originalPid }))
  checks.push('sixty_native_handshakes_pid_stable')
  writeFileSync(join(evidence, 'viewport-styles.json'), JSON.stringify(await desktop.evaluate(() => [...document.querySelectorAll('.xterm, .xterm-viewport, .xterm-scrollable-element, .xterm-screen')].map(el => ({ selector: el.className, background: getComputedStyle(el).backgroundColor, width: el.clientWidth, height: el.clientHeight }))), null, 2))
  await desktop.screenshot({ path: join(evidence, 'desktop.png'), fullPage: true })
  await mobile.screenshot({ path: join(evidence, 'mobile.png'), fullPage: true })
  assert.deepEqual(pageErrors, [])
  checks.push('no_browser_errors')
  await api(`/api/projects/${encodeURIComponent(project)}/channels`, 'POST', { path: relative(backend.workspaceRoot, workspace), shell_type: 'bash' })
  const shellChannels = (await api(`/api/sessions?session=${encodeURIComponent(project)}`)).windows.filter(window => window.index !== 0)
  assert.equal(shellChannels.length, 1, 'native shell channel created')
  const upload = spawn(process.execPath, [join(root, 'scripts/login-upload-smoke.mjs')], { cwd: root, env: { ...process.env, NEXUS_E2E_BASE_URL: base, NEXUS_E2E_PASSWORD: password, NEXUS_E2E_SESSION: project, NEXUS_E2E_WINDOW: String(shellChannels[0].index) }, stdio: ['ignore', 'pipe', 'pipe'] })
  let uploadOutput = ''
  upload.stdout.on('data', data => { if (uploadOutput.length < 10000) uploadOutput += String(data) })
  upload.stderr.on('data', data => { if (uploadOutput.length < 10000) uploadOutput += String(data) })
  const [uploadExit] = await once(upload, 'exit')
  writeFileSync(join(evidence, 'login-upload.log'), uploadOutput)
  assert.equal(uploadExit, 0, 'real login/upload/terminal path smoke')
  checks.push('real_login_upload_native_shell_websocket')
  if (process.argv.includes('--clipboard-smoke')) {
    await desktop.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base })
    await desktop.bringToFront()
    await desktop.evaluate(() => navigator.clipboard.writeText('NEXUS_CLIPBOARD_BEFORE_COPY'))
    await desktop.evaluate(() => {
      window.__osc52Writes = 0
      const write = navigator.clipboard.writeText.bind(navigator.clipboard)
      navigator.clipboard.writeText = text => { window.__osc52Writes++; return write(text) }
    })
    const box = await desktop.locator('.xterm-screen').first().boundingBox()
    await desktop.mouse.click(box.x + 20, box.y + 20)
    await desktop.keyboard.press('b')
    const expected = 'Clipboard 中文🙂 e\u0301\n'.repeat(400)
    await desktop.waitForFunction(async expected => await navigator.clipboard.readText() === expected, expected)
    await desktop.waitForFunction(() => window.__osc52Writes > 0)
    assert.equal(await desktop.evaluate(() => window.__osc52Writes), 1, 'only the locally focused pane may write automatically')
    const before = await desktop.evaluate(() => window.__nativeSockets.length)
    await desktop.evaluate(() => window.__nativeSockets.find(socket => socket.readyState === 1).close())
    await desktop.waitForFunction(count => window.__nativeSockets.length > count && window.__nativeSockets.some(socket => socket.readyState === 1 && socket.__controls.some(control => control.replayPolicy === 'native-snapshot')), before)
    await desktop.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('FRAME_READY_1'))
    assert.equal(await desktop.evaluate(() => window.__osc52Writes), 1, 'native reconnect must not execute completed clipboard effects')
    await desktop.evaluate(() => navigator.clipboard.writeText('NEXUS_CLIPBOARD_SENTINEL'))
    await desktop.reload()
    if (await desktop.locator('input[type=password]').isVisible()) {
      await desktop.locator('input[type=password]').fill(password)
      await desktop.locator('button[type=submit]').click()
    }
    await desktop.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('FRAME_READY_1'))
    assert.equal(await desktop.evaluate(() => navigator.clipboard.readText()), 'NEXUS_CLIPBOARD_SENTINEL', 'refresh must not repeat history copies')
    assert.equal(await desktop.locator('[data-terminal-clipboard]').count(), 0)
    await dismissSetup(desktop)
    checks.push('real_native_osc52_utf8_long_copy_no_replay_or_split_duplicate')
  }
  if (process.argv.includes('--cli-smoke')) {
    // Startup/render only: no prompt, inference, login or provider mutation.
    await mobile.context().close()
    const sendCliInput = data => desktop.evaluate(data => {
      const socket = window.__nativeSockets.find(socket => socket.readyState === 1)
      if (!socket) throw new Error('No live browser terminal for CLI input')
      socket.send(data)
    }, data)
    await sendCliInput('x')
    await delay(1000)
    for (const cli of ['codex', 'grok']) {
      const marker = `NEXUS_${cli.toUpperCase()}_STARTUP_DONE`
      const command = cli === 'grok' ? `env GROK_COPY_FILE=${quote(join(evidence, 'grok-copy.txt'))} grok` : cli
      await sendCliInput(`clear; timeout --signal=INT --kill-after=3s 60s ${command}; printf '\\n${marker}\\n'\r`)
      await desktop.waitForFunction(cli => {
        const text = document.querySelector('.xterm-rows')?.textContent || ''
        return cli === 'codex' ? /OpenAI Codex|Do you trust the contents/i.test(text) : /Grok Build|Welcome to Grok|grok[ -]1\./i.test(text)
      }, cli, { timeout: 20000 })
      await desktop.screenshot({ path: join(evidence, `${cli}-startup.png`), fullPage: true })
      let copiedGrokId = null
      if (cli === 'grok' && process.argv.includes('--clipboard-smoke')) {
        await sendCliInput('/session-info\r')
        await desktop.waitForFunction(() => /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(document.querySelector('.xterm-rows')?.textContent || ''))
        const copiedId = await desktop.evaluate(() => document.querySelector('.xterm-rows').textContent.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)[0])
        await desktop.evaluate(() => navigator.clipboard.writeText('NEXUS_BEFORE_GROK_COPY'))
        await desktop.evaluate(() => {
          window.__grokClipboardWrites = []
          const write = navigator.clipboard.writeText.bind(navigator.clipboard)
          navigator.clipboard.writeText = text => { window.__grokClipboardWrites.push(text); return write(text) }
        })
        const point = await desktop.evaluate(id => {
          const row = [...document.querySelector('.xterm-rows').children].find(row => row.textContent.includes(id))
          const box = row.getBoundingClientRect()
          const cols = window.__nativeSockets.filter(socket => socket.readyState === 1).flatMap(socket => socket.__controls).filter(control => control.cols).at(-1).cols
          return { x: box.x + (row.textContent.indexOf(id) + 4) * box.width / cols, y: box.y + box.height / 2 }
        }, copiedId)
        await desktop.mouse.click(point.x, point.y)
        await desktop.waitForFunction(async id => await navigator.clipboard.readText() === id, copiedId, { timeout: 10000 })
        await desktop.waitForFunction(() => window.__grokClipboardWrites.length > 0, null, { timeout: 10000 })
        assert.deepEqual(await desktop.evaluate(() => window.__grokClipboardWrites), [copiedId], 'copy must pass through browser OSC52 handler, not the server OS clipboard')
        await desktop.screenshot({ path: join(evidence, 'grok-osc52-copy.png'), fullPage: true })
        checks.push('real_grok_session_info_mouse_copy_to_browser_clipboard')
        copiedGrokId = copiedId
      }
      const beforeCliReconnect = await desktop.evaluate(() => window.__nativeSockets.length)
      await desktop.evaluate(() => window.__nativeSockets.find(socket => socket.readyState === 1).close())
      await desktop.waitForFunction(count => window.__nativeSockets.length > count && window.__nativeSockets.some(socket => socket.readyState === 1 && socket.__controls.some(control => control.replayPolicy === 'native-snapshot')), beforeCliReconnect)
      await desktop.waitForFunction(({ cli, copiedGrokId }) => {
        const text = document.querySelector('.xterm-rows')?.textContent || ''
        if (copiedGrokId) return text.includes(copiedGrokId)
        return cli === 'codex' ? /OpenAI Codex|Do you trust the contents/i.test(text) : /Grok Build|Welcome to Grok|grok[ -]1\./i.test(text)
      }, { cli, copiedGrokId })
      await sendCliInput('\x03\x03')
      await desktop.waitForFunction(marker => document.querySelector('.xterm-rows')?.textContent?.includes(marker), marker, { timeout: 65000 })
      checks.push(`${cli}_real_startup_screen_and_reconnect_without_inference`)
    }
  }
  assert.deepEqual(pageErrors, [], 'including optional CLI startup screens')
} catch (error) {
  if (browser) {
    const pages = await Promise.all(browser.contexts().flatMap(context => context.pages()).map(async (page, i) => {
      await page.screenshot({ path: join(evidence, `failure-${i}.png`), fullPage: true }).catch(() => {})
      return page.evaluate(() => ({ terminal: [...document.querySelectorAll('.xterm-rows')].map(node => node.textContent), sockets: window.__nativeSockets?.map(socket => ({ state: socket.readyState, controls: socket.__controls })) })).catch(() => null)
    }))
    writeFileSync(join(evidence, 'failure.json'), JSON.stringify({ pages, clientClose, clientState: client?.readyState }, null, 2))
  }
  console.error('Acceptance evidence:', evidence)
  throw error
} finally {
  client?.close()
  await browser?.close()
  if (project) {
    try { await api(`/api/projects/${encodeURIComponent(project)}`, 'DELETE'); project = null }
    catch { console.error('Acceptance project cleanup failed; inspect', project); process.exitCode = 1 }
  }
  await stop(server)
  await stop(supervisor)
  if (!project) rmSync(workspace, { recursive: true, force: true })
  // Output contains no authentication values; raw server logs are not persisted.
  writeFileSync(join(evidence, 'result.json'), JSON.stringify({ live, checks, pageErrors }, null, 2))
}
console.log(JSON.stringify({ result: process.exitCode ? 'FAIL' : 'PASS', live, checks, evidence }))
