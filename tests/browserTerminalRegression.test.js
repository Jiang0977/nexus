import test from 'node:test'
import assert from 'node:assert/strict'
import bcrypt from 'bcrypt'
import { once } from 'node:events'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { chromium } from 'playwright'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PTY_FIXTURE = join(ROOT, 'tests', 'fixtures', 'fakePtyRustRuntime.js')
const SESSION_MANAGEMENT_FIXTURE = join(ROOT, 'tests', 'fixtures', 'fakeSessionManagementRustRuntime.js')
const RUST_SERVER_BINARY = join(
  ROOT,
  'rust-runtime',
  'target',
  'debug',
  process.platform === 'win32' ? 'nexus-server.exe' : 'nexus-server',
)

let buildChecked = false

function resolveChromiumLaunchOptions() {
  const executablePath = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].find((candidate) => candidate && existsSync(candidate))

  return executablePath
    ? { headless: true, executablePath }
    : { headless: true }
}

function ensureRustServerBuilt() {
  if (buildChecked) return

  const build = spawnSync(
    'cargo',
    ['build', '--manifest-path', 'rust-runtime/Cargo.toml', '--bin', 'nexus-server'],
    {
      cwd: ROOT,
      encoding: 'utf8',
    },
  )

  assert.equal(build.status, 0, build.stderr || build.stdout)
  buildChecked = true
}

async function getFreePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  server.close()
  await once(server, 'close')
  return port
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  const exitPromise = once(child, 'exit')
  const timeoutPromise = delay(5000).then(() => {
    if (child.exitCode === null) child.kill('SIGKILL')
  })
  await Promise.race([exitPromise, timeoutPromise])
}

async function waitForHealthyHttp(port, child) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`rust nexus-server exited early with code ${child.exitCode}`)
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (response.ok) return
    } catch {}

    await delay(250)
  }

  throw new Error(`rust nexus-server did not become healthy on port ${port}`)
}

function spawnRustServer(envOverrides = {}) {
  let logs = ''
  const child = spawn(RUST_SERVER_BINARY, {
    cwd: ROOT,
    env: {
      ...process.env,
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout.on('data', (chunk) => {
    logs += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    logs += chunk.toString()
  })

  return { child, getLogs: () => logs }
}

function createBrowserProjectFixture() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'nexus-browser-regression-'))
  const frontendDist = join(ROOT, 'frontend', 'dist')
  assert.equal(existsSync(join(frontendDist, 'index.html')), true, 'vendored frontend/dist is missing')

  mkdirSync(join(projectRoot, 'frontend'), { recursive: true })
  cpSync(frontendDist, join(projectRoot, 'frontend', 'dist'), { recursive: true })

  const publicDir = join(ROOT, 'public')
  if (existsSync(publicDir)) {
    cpSync(publicDir, join(projectRoot, 'public'), { recursive: true })
  }

  const dataDir = join(projectRoot, 'data')
  mkdirSync(join(dataDir, 'configs'), { recursive: true })
  mkdirSync(join(dataDir, 'codex-configs'), { recursive: true })
  writeFileSync(
    join(dataDir, 'configs', 'browser-fixture.json'),
    `${JSON.stringify({
      label: 'Browser Fixture Claude',
      BASE_URL: '',
      AUTH_TOKEN: '',
      API_KEY: '',
      DEFAULT_MODEL: 'claude-sonnet-4-6',
      THINK_MODEL: 'claude-opus-4-6',
      LONG_CONTEXT_MODEL: 'claude-opus-4-6',
      DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5-20251001',
      API_TIMEOUT_MS: '3000000',
    }, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(
    join(dataDir, 'codex-configs', 'daily.json'),
    `${JSON.stringify({
      label: 'Daily Codex',
      OPENAI_API_KEY: 'sk-daily',
      model: 'gpt-5-codex',
      reasoning_effort: 'medium',
    }, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(
    join(dataDir, 'codex-configs', 'focus.json'),
    `${JSON.stringify({
      label: 'Focus Codex',
      OPENAI_API_KEY: 'sk-focus',
      model: 'gpt-5-codex',
      reasoning_effort: 'high',
    }, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(
    join(dataDir, 'project-shell-defaults.json'),
    `${JSON.stringify({
      '/workspace/demo': {
        shell_type: 'codex',
        profile: 'daily',
        updated_at: '2026-04-24T00:00:00.000Z',
      },
    }, null, 2)}\n`,
    'utf8',
  )

  return { dataDir, projectRoot }
}

async function launchBrowserApp(t, { extraChannels = [], mobile = false, ptySnapshots = {} } = {}) {
  ensureRustServerBuilt()

  const { dataDir, projectRoot } = createBrowserProjectFixture()
  const port = await getFreePort()
  const password = 'browser-regression-password'
  const passwordHash = bcrypt.hashSync(password, 8)
  const { child, getLogs } = spawnRustServer({
    NEXUS_PROJECT_ROOT: projectRoot,
    NEXUS_DATA_DIR: dataDir,
    HOST: '127.0.0.1',
    PORT: String(port),
    JWT_SECRET: 'browser-regression-secret',
    ACC_PASSWORD_HASH: passwordHash,
    TMUX_SESSION: 'nexus-preview-rust',
    WORKSPACE_ROOT: '/workspace',
    NEXUS_PTY_BROKER_RUST_EXECUTABLE: process.execPath,
    NEXUS_PTY_BROKER_RUST_ARGS: JSON.stringify([PTY_FIXTURE]),
    NEXUS_SESSION_MANAGEMENT_RUST_EXECUTABLE: process.execPath,
    NEXUS_SESSION_MANAGEMENT_RUST_ARGS: JSON.stringify([SESSION_MANAGEMENT_FIXTURE]),
    FAKE_SESSION_MANAGEMENT_EXTRA_CHANNELS_JSON: JSON.stringify(extraChannels),
    FAKE_PTY_RUNTIME_SNAPSHOT_JSON: JSON.stringify({
      'nexus-preview-rust:0': {
        output: 'preview shell ready\n',
        clients: 1,
      },
      'nexus-preview-rust:1': {
        output: 'notes ready\n',
        clients: 0,
      },
      ...ptySnapshots,
    }),
  })

  t.after(async () => {
    await stopChild(child)
    rmSync(projectRoot, { recursive: true, force: true })
  })

  await waitForHealthyHttp(port, child)

  const browser = await chromium.launch(resolveChromiumLaunchOptions())
  t.after(async () => {
    await browser.close()
  })

  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    isMobile: mobile,
    hasTouch: mobile,
    serviceWorkers: 'block',
  })
  t.after(async () => {
    await context.close()
  })

  await context.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'en')
    localStorage.setItem('nexus_guide_seen', 'true')
    localStorage.removeItem('nexus_token')
    localStorage.removeItem('nexus_session')
    localStorage.removeItem('nexus_session_source')
    localStorage.removeItem('nexus_sidebar_collapsed')
    localStorage.removeItem('nexus_toolbar_collapsed')
    localStorage.removeItem('nexus_codex_history_fab_pos')
    localStorage.removeItem('nexus_fab_pos')
  })

  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => {
    pageErrors.push(error)
  })

  return {
    getLogs,
    page,
    pageErrors,
    password,
    port,
  }
}

async function loginAndWaitForTerminal(page, port, password) {
  await page.goto(`http://127.0.0.1:${port}/`)
  await page.getByPlaceholder('Enter password').fill(password)
  await page.getByRole('button', { name: 'Login' }).click()
  const isMobile = await page.evaluate(() => window.innerWidth < 768)
  if (isMobile) {
    await page.getByRole('button', { name: 'Select text' }).waitFor()
    return
  }
  await page.getByTestId('split-workspace-view').waitFor()
}

async function dispatchMobileSwipe(page, points) {
  const session = await page.context().newCDPSession(page)
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: points[0][0], y: points[0][1], radiusX: 2, radiusY: 2, force: 1, id: 1 }],
  })

  for (const [x, y] of points.slice(1)) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y, radiusX: 2, radiusY: 2, force: 1, id: 1 }],
    })
    await delay(30)
  }

  await session.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  })
}

test('browser regression: desktop login opens the terminal shell and session manager modal', { timeout: 120000 }, async (t) => {
  const { getLogs, page, pageErrors, password, port } = await launchBrowserApp(t)

  await loginAndWaitForTerminal(page, port, password)

  await page.getByTitle('Workspaces & Windows').click()
  await page.getByText('Workspaces & Windows').waitFor()
  await page.getByText('nexus-preview-rust').waitFor()
  await page.getByText('demo-project').waitFor()
  await page.getByText('New Workspace').waitFor()

  assert.deepEqual(
    pageErrors.map((error) => String(error?.message || error)),
    [],
    `unexpected page errors:\n${pageErrors.map((error) => String(error?.stack || error)).join('\n\n')}\n\nserver logs:\n${getLogs()}`,
  )
})

test('browser regression: desktop split workspace fills the available height', { timeout: 120000 }, async (t) => {
  const { getLogs, page, pageErrors, password, port } = await launchBrowserApp(t)

  await loginAndWaitForTerminal(page, port, password)

  const metrics = await page.getByTestId('split-workspace-view').evaluate((workspace) => {
    const rightWrapper = workspace.parentElement
    return {
      workspaceHeight: workspace.getBoundingClientRect().height,
      wrapperHeight: rightWrapper?.getBoundingClientRect().height ?? 0,
      windowHeight: window.innerHeight,
    }
  })

  assert.ok(metrics.wrapperHeight > 0, `expected split workspace wrapper height to be measurable, got ${JSON.stringify(metrics)}`)
  assert.ok(
    Math.abs(metrics.workspaceHeight - metrics.wrapperHeight) <= 1,
    `expected split workspace to fill wrapper height, got ${JSON.stringify(metrics)}`,
  )
  assert.ok(
    Math.abs(metrics.workspaceHeight - metrics.windowHeight) <= 1,
    `expected desktop split workspace to fill the screen height, got ${JSON.stringify(metrics)}`,
  )
  assert.deepEqual(
    pageErrors.map((error) => String(error?.message || error)),
    [],
    `unexpected page errors:\n${pageErrors.map((error) => String(error?.stack || error)).join('\n\n')}\n\nserver logs:\n${getLogs()}`,
  )
})

test('browser regression: desktop split layout modes persist after refresh', { timeout: 120000 }, async (t) => {
  const { getLogs, page, pageErrors, password, port } = await launchBrowserApp(t)

  await loginAndWaitForTerminal(page, port, password)

  const modes = [
    { button: 'Single', mode: 'single', panes: 1 },
    { button: 'V Split', mode: 'vertical', panes: 2 },
    { button: 'H Split', mode: 'horizontal', panes: 2 },
    { button: '2x2', mode: 'grid-2x2', panes: 4 },
    { button: '3x3', mode: 'grid-3x3', panes: 9 },
  ]

  for (const { button, mode, panes } of modes) {
    const saveResponse = page.waitForResponse((response) => (
      response.url().includes('/api/workspace-layouts/active')
        && response.request().method() === 'PUT'
        && response.ok()
    ))
    await page.getByRole('button', { name: button }).click()
    await saveResponse
    await page.waitForFunction(
      (expectedMode) => document.body.textContent?.includes(`mode ${expectedMode}`),
      mode,
    )
    assert.equal(await page.locator('[data-testid^="terminal-pane-"]').count(), panes)
  }

  await page.reload()
  await loginAndWaitForTerminal(page, port, password)
  await page.waitForFunction(() => document.body.textContent?.includes('mode grid-3x3'))
  assert.equal(await page.locator('[data-testid^="terminal-pane-"]').count(), 9)

  assert.deepEqual(
    pageErrors.map((error) => String(error?.message || error)),
    [],
    `unexpected page errors:\n${pageErrors.map((error) => String(error?.stack || error)).join('\n\n')}\n\nserver logs:\n${getLogs()}`,
  )
})

test('browser regression: desktop drags a sidebar channel into a split pane and restores it after refresh', { timeout: 120000 }, async (t) => {
  const { getLogs, page, pageErrors, password, port } = await launchBrowserApp(t)
  await page.addInitScript(() => {
    localStorage.setItem('nexus_sidebar_collapsed', 'false')
  })

  await loginAndWaitForTerminal(page, port, password)

  const source = page.locator('[draggable="true"]').filter({ hasText: 'shell' }).first()
  await source.waitFor()

  const saveResponse = page.waitForResponse((response) => (
    response.url().includes('/api/workspace-layouts/active')
      && response.request().method() === 'PUT'
      && response.ok()
  ))
  await source.dragTo(page.getByTestId('terminal-pane-pane-1'))
  await saveResponse
  await page.waitForFunction(() => document.body.textContent?.includes('notes ready'))

  await page.reload()
  await loginAndWaitForTerminal(page, port, password)
  await page.waitForFunction(() => (
    document.body.textContent?.includes('nexus-preview-rust / notes')
      && document.body.textContent?.includes('已连接 1/1 panes')
  ))

  assert.deepEqual(
    pageErrors.map((error) => String(error?.message || error)),
    [],
    `unexpected page errors:\n${pageErrors.map((error) => String(error?.stack || error)).join('\n\n')}\n\nserver logs:\n${getLogs()}`,
  )
})

test('browser regression: desktop split panes keep input and resize scoped to the focused pane', { timeout: 120000 }, async (t) => {
  const { getLogs, page, pageErrors, password, port } = await launchBrowserApp(t, {
    extraChannels: [{ index: 0, name: 'preview', active: false, cwd: '/workspace' }],
  })
  await page.addInitScript(() => {
    localStorage.setItem('nexus_sidebar_collapsed', 'false')

    const NativeWebSocket = window.WebSocket
    window.__nexusWsSends = []
    function PatchedWebSocket(url, protocols) {
      const socket = protocols === undefined
        ? new NativeWebSocket(url)
        : new NativeWebSocket(url, protocols)
      const rawSend = socket.send
      socket.send = function send(data) {
        window.__nexusWsSends.push({ url: String(url), data: String(data) })
        return rawSend.call(this, data)
      }
      return socket
    }
    Object.assign(PatchedWebSocket, NativeWebSocket)
    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      writable: true,
      value: PatchedWebSocket,
    })
  })

  await loginAndWaitForTerminal(page, port, password)

  const shellSource = page.locator('[draggable="true"]').filter({ hasText: 'shell' }).first()
  await shellSource.waitFor()
  await shellSource.dragTo(page.getByTestId('terminal-pane-pane-1'))
  await page.waitForFunction(() => document.body.textContent?.includes('notes ready'))

  await page.waitForFunction(() => {
    const sends = window.__nexusWsSends || []
    return sends.some((send) => send.url.includes('window=1') && send.data.includes('"resize"'))
  })
  const singleCols = await page.evaluate(() => {
    const sends = window.__nexusWsSends || []
    const resize = sends
      .filter((send) => send.url.includes('window=1'))
      .map((send) => {
        try { return JSON.parse(send.data) } catch { return null }
      })
      .filter((message) => message?.type === 'resize')
      .at(-1)
    return resize?.cols || 0
  })

  await page.getByRole('button', { name: '2x2' }).click()
  await page.waitForFunction(() => document.body.textContent?.includes('mode grid-2x2'))
  await page.waitForFunction((previousCols) => {
    const sends = window.__nexusWsSends || []
    return sends
      .filter((send) => send.url.includes('window=1'))
      .map((send) => {
        try { return JSON.parse(send.data) } catch { return null }
      })
      .some((message) => message?.type === 'resize' && message.cols > 0 && message.cols < previousCols)
  }, singleCols)

  const previewSource = page.locator('[draggable="true"]').filter({ hasText: 'preview' }).first()
  await previewSource.waitFor()
  await previewSource.dragTo(page.getByTestId('terminal-pane-pane-2'))
  await page.waitForFunction(() => document.body.textContent?.includes('preview shell ready'))

  await page.evaluate(() => {
    window.__nexusWsSends = []
  })

  await page.getByTestId('terminal-pane-pane-1').click({ position: { x: 24, y: 18 } })
  await page.keyboard.type('pane-one')
  await page.getByTestId('terminal-pane-pane-2').click({ position: { x: 24, y: 18 } })
  await page.keyboard.type('pane-two')

  const textByWindow = await page.evaluate(() => (window.__nexusWsSends || [])
    .filter((send) => !send.data.includes('"resize"'))
    .reduce((acc, send) => {
      const windowIndex = new URL(send.url).searchParams.get('window')
      acc[windowIndex] = `${acc[windowIndex] || ''}${send.data}`
      return acc
    }, {}))

  assert.deepEqual(textByWindow, {
    0: 'pane-two',
    1: 'pane-one',
  })
  assert.deepEqual(
    pageErrors.map((error) => String(error?.message || error)),
    [],
    `unexpected page errors:\n${pageErrors.map((error) => String(error?.stack || error)).join('\n\n')}\n\nserver logs:\n${getLogs()}`,
  )
})

test('browser regression: desktop sidebar channel clicks focus the matching split pane without reattaching the global terminal', { timeout: 120000 }, async (t) => {
  const { getLogs, page, pageErrors, password, port } = await launchBrowserApp(t, {
    extraChannels: [{ index: 0, name: 'preview', active: false, cwd: '/workspace' }],
  })
  await page.addInitScript(() => {
    localStorage.setItem('nexus_sidebar_collapsed', 'false')
  })

  await loginAndWaitForTerminal(page, port, password)

  const shellSource = page.locator('[draggable="true"]').filter({ hasText: 'shell' }).first()
  await shellSource.waitFor()
  await shellSource.dragTo(page.getByTestId('terminal-pane-pane-1'))
  await page.waitForFunction(() => document.body.textContent?.includes('nexus-preview-rust / notes'))

  const attachRequests = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/sessions/0/attach?session=nexus-preview-rust')) {
      attachRequests.push(request.url())
    }
  })
  await page.locator('[draggable="true"]').filter({ hasText: 'preview' }).first().click()
  await page.waitForTimeout(200)
  assert.equal(attachRequests.length, 0, 'clicking a draggable sidebar channel should not attach the global terminal')
  await page.waitForFunction(() => document.body.textContent?.includes('nexus-preview-rust / notes'))

  await page.getByRole('button', { name: '2x2' }).click()
  await page.waitForFunction(() => document.body.textContent?.includes('mode grid-2x2'))
  await page.locator('[draggable="true"]').filter({ hasText: 'preview' }).first().dragTo(page.getByTestId('terminal-pane-pane-2'))
  await page.waitForFunction(() => {
    const text = document.body.textContent || ''
    return text.includes('nexus-preview-rust / notes')
      && text.includes('nexus-preview-rust / shell')
      && text.includes('已占用 2')
  })
  await page.waitForFunction(() => {
    const badgeText = document.querySelector('[data-testid="sidebar-channel-assigned-panes-nexus-preview-rust-0"]')?.textContent || ''
    return badgeText.includes('2')
  })

  await page.locator('[draggable="true"]').filter({ hasText: 'preview' }).first().click()
  await page.waitForFunction(() => {
    const pane2 = document.querySelector('[data-testid="terminal-pane-pane-2"]')
    const pane1 = document.querySelector('[data-testid="terminal-pane-pane-1"]')
    return pane2?.className.includes('border-nexus-accent')
      && !pane1?.className.includes('border-nexus-accent')
  })
  await page.locator('[draggable="true"]').filter({ hasText: 'shell' }).first().click()
  await page.waitForFunction(() => {
    const pane2 = document.querySelector('[data-testid="terminal-pane-pane-2"]')
    const pane1 = document.querySelector('[data-testid="terminal-pane-pane-1"]')
    return pane1?.className.includes('border-nexus-accent')
      && !pane2?.className.includes('border-nexus-accent')
  })

  assert.deepEqual(
    pageErrors.map((error) => String(error?.message || error)),
    [],
    `unexpected page errors:\n${pageErrors.map((error) => String(error?.stack || error)).join('\n\n')}\n\nserver logs:\n${getLogs()}`,
  )
})

test('browser regression: closing a sidebar channel clears its split pane assignment', { timeout: 120000 }, async (t) => {
  const { getLogs, page, pageErrors, password, port } = await launchBrowserApp(t, {
    extraChannels: [{ index: 0, name: 'preview', active: false, cwd: '/workspace' }],
  })
  await page.addInitScript(() => {
    localStorage.setItem('nexus_sidebar_collapsed', 'false')
  })

  await loginAndWaitForTerminal(page, port, password)

  const channelRow = page.getByTestId('sidebar-channel-nexus-preview-rust-1')
  await channelRow.waitFor()
  await channelRow.dragTo(page.getByTestId('terminal-pane-pane-1'))
  await page.waitForFunction(() => {
    const badgeText = document.querySelector('[data-testid="sidebar-channel-assigned-panes-nexus-preview-rust-1"]')?.textContent || ''
    return document.body.textContent?.includes('nexus-preview-rust / notes') && badgeText.includes('1')
  })

  await channelRow.click({ button: 'right' })
  await page.getByRole('button', { name: 'Close' }).click()
  await page.waitForFunction(() => {
    const badge = document.querySelector('[data-testid="sidebar-channel-assigned-panes-nexus-preview-rust-1"]')
    const pane = document.querySelector('[data-testid="terminal-pane-pane-1"]')
    return !badge
      && pane?.textContent?.includes('拖入窗口')
      && !pane.querySelector('.xterm')
  })

  assert.deepEqual(
    pageErrors.map((error) => String(error?.message || error)),
    [],
    `unexpected page errors:\n${pageErrors.map((error) => String(error?.stack || error)).join('\n\n')}\n\nserver logs:\n${getLogs()}`,
  )
})

test('browser regression: desktop split panes can copy selected terminal text', { timeout: 120000 }, async (t) => {
  const { getLogs, page, pageErrors, password, port } = await launchBrowserApp(t)
  await page.addInitScript(() => {
    localStorage.setItem('nexus_sidebar_collapsed', 'false')
  })
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: `http://127.0.0.1:${port}`,
  })

  await loginAndWaitForTerminal(page, port, password)

  const shellSource = page.locator('[draggable="true"]').filter({ hasText: 'shell' }).first()
  await shellSource.waitFor()
  await shellSource.dragTo(page.getByTestId('terminal-pane-pane-1'))
  await page.waitForFunction(() => document.body.textContent?.includes('notes ready'))

  const row = page.getByTestId('terminal-pane-pane-1').locator('.xterm-rows').first()
  const box = await row.boundingBox()
  assert.ok(box, 'expected xterm rows to be measurable')
  await page.mouse.move(box.x + 4, box.y + 12)
  await page.mouse.down()
  await page.mouse.move(box.x + 110, box.y + 12)
  await page.mouse.up()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C')

  await page.waitForFunction(async () => (await navigator.clipboard.readText()).includes('notes ready'))

  assert.deepEqual(
    pageErrors.map((error) => String(error?.message || error)),
    [],
    `unexpected page errors:\n${pageErrors.map((error) => String(error?.stack || error)).join('\n\n')}\n\nserver logs:\n${getLogs()}`,
  )
})

test('browser regression: desktop split pane header opens selectable terminal text', { timeout: 120000 }, async (t) => {
  const { getLogs, page, pageErrors, password, port } = await launchBrowserApp(t)
  await page.addInitScript(() => {
    localStorage.setItem('nexus_sidebar_collapsed', 'false')
  })
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: `http://127.0.0.1:${port}`,
  })

  await loginAndWaitForTerminal(page, port, password)

  const shellSource = page.locator('[draggable="true"]').filter({ hasText: 'shell' }).first()
  await shellSource.waitFor()
  await shellSource.dragTo(page.getByTestId('terminal-pane-pane-1'))
  await page.waitForFunction(() => document.body.textContent?.includes('notes ready'))

  const scrollbackRequests = []
  await page.route('**/api/sessions/1/scrollback?**', async (route) => {
    scrollbackRequests.push(route.request().url())
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ content: 'notes ready\n' }),
    })
  })

  await page
    .getByTestId('terminal-pane-pane-1')
    .getByRole('button', { name: '选字复制' })
    .click()

  const scrollbackText = page.locator('pre').filter({ hasText: 'notes ready' }).first()
  await scrollbackText.waitFor()
  await delay(400)
  const box = await scrollbackText.boundingBox()
  assert.ok(box, 'expected scrollback text to be measurable')

  await page.mouse.move(box.x + 4, box.y + 10)
  await page.mouse.down()
  await page.mouse.move(box.x + 110, box.y + 10)
  await page.mouse.up()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C')

  await page.waitForFunction(async () => (await navigator.clipboard.readText()).includes('notes ready'))
  assert.equal(scrollbackRequests.length, 1)
  assert.match(scrollbackRequests[0], /\/api\/sessions\/1\/scrollback\?/)
  assert.match(scrollbackRequests[0], /session=nexus-preview-rust/)

  assert.deepEqual(
    pageErrors.map((error) => String(error?.message || error)),
    [],
    `unexpected page errors:\n${pageErrors.map((error) => String(error?.stack || error)).join('\n\n')}\n\nserver logs:\n${getLogs()}`,
  )
})

test('browser regression: desktop split pane keeps user scroll during streaming output', { timeout: 120000 }, async (t) => {
  const longOutput = Array.from({ length: 80 }, (_, index) => `line ${String(index + 1).padStart(2, '0')}`).join('\n') + '\n'
  const { getLogs, page, pageErrors, password, port } = await launchBrowserApp(t, {
    ptySnapshots: {
      'nexus-preview-rust:1': {
        output: longOutput,
        clients: 0,
      },
    },
  })
  await page.addInitScript(() => {
    localStorage.setItem('nexus_sidebar_collapsed', 'false')
  })

  await loginAndWaitForTerminal(page, port, password)

  const shellSource = page.locator('[draggable="true"]').filter({ hasText: 'shell' }).first()
  await shellSource.waitFor()
  await shellSource.dragTo(page.getByTestId('terminal-pane-pane-1'))
  await page.waitForFunction(() => document.body.textContent?.includes('line 80'))

  const pane = page.getByTestId('terminal-pane-pane-1')
  const viewport = pane.locator('.xterm-viewport').first()
  const box = await viewport.boundingBox()
  assert.ok(box, 'expected xterm viewport to be measurable')

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, -900)
  await viewport.evaluate((el) => {
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -900, bubbles: true, cancelable: true }))
  })
  await pane.getByRole('button', { name: '回到底部' }).waitFor()

  await pane.click({ position: { x: 24, y: 48 } })
  await page.keyboard.type('streaming output while user reads')
  await delay(150)

  await pane.getByRole('button', { name: '回到底部' }).waitFor()

  assert.deepEqual(
    pageErrors.map((error) => String(error?.message || error)),
    [],
    `unexpected page errors:\n${pageErrors.map((error) => String(error?.stack || error)).join('\n\n')}\n\nserver logs:\n${getLogs()}`,
  )
})

test('browser regression: desktop bottom-right split pane can be focused', { timeout: 120000 }, async (t) => {
  const { getLogs, page, pageErrors, password, port } = await launchBrowserApp(t)

  await loginAndWaitForTerminal(page, port, password)

  await page.getByRole('button', { name: '3x3' }).click()
  await page.waitForFunction(() => document.body.textContent?.includes('mode grid-3x3'))
  await page.getByTestId('terminal-pane-pane-9').click({ position: { x: 24, y: 18 } })

  await page.waitForFunction(() => {
    const pane9 = document.querySelector('[data-testid="terminal-pane-pane-9"]')
    const pane1 = document.querySelector('[data-testid="terminal-pane-pane-1"]')
    return pane9?.className.includes('border-nexus-accent')
      && !pane1?.className.includes('border-nexus-accent')
  })

  assert.deepEqual(
    pageErrors.map((error) => String(error?.message || error)),
    [],
    `unexpected page errors:\n${pageErrors.map((error) => String(error?.stack || error)).join('\n\n')}\n\nserver logs:\n${getLogs()}`,
  )
})

test('browser regression: mobile codex history modal opens and restores focus to the trigger', { timeout: 120000 }, async (t) => {
  const { getLogs, page, pageErrors, password, port } = await launchBrowserApp(t, { mobile: true })

  await loginAndWaitForTerminal(page, port, password)

  const codexHistoryTrigger = page.getByRole('button', { name: 'Codex History' })
  await codexHistoryTrigger.waitFor()
  await codexHistoryTrigger.click()

  await page.getByRole('button', { name: 'Back to Session' }).waitFor()
  await page.getByText('Codex History · nexus-preview-rust').waitFor()
  await page.getByText('Fix bug').waitFor()

  await page.getByRole('button', { name: 'Back to Session' }).click()
  await page.getByRole('button', { name: 'Back to Session' }).waitFor({ state: 'hidden' })

  const focusRestored = await codexHistoryTrigger.evaluate((element) => document.activeElement === element)
  assert.equal(focusRestored, true, 'focus should return to the Codex History trigger after closing the modal')
  assert.deepEqual(
    pageErrors.map((error) => String(error?.message || error)),
    [],
    `unexpected page errors:\n${pageErrors.map((error) => String(error?.stack || error)).join('\n\n')}\n\nserver logs:\n${getLogs()}`,
  )
})

test('browser regression: mobile codex history continue opens codex profile picker before resume', { timeout: 120000 }, async (t) => {
  const { getLogs, page, pageErrors, password, port } = await launchBrowserApp(t, { mobile: true })

  await loginAndWaitForTerminal(page, port, password)

  const resumeRequests = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/codex-sessions/session-1/resume')) {
      resumeRequests.push(request)
    }
  })

  await page.getByRole('button', { name: 'Codex History' }).click()
  await page.getByRole('button', { name: 'Continue: Fix bug' }).click()

  const profileSelect = page.locator('select')
  await profileSelect.waitFor()
  await page.waitForFunction(() => {
    const select = document.querySelector('select')
    return select instanceof HTMLSelectElement && select.value === 'daily'
  })
  assert.equal(await profileSelect.inputValue(), 'daily')
  await page.getByRole('button', { name: 'Continue Session' }).waitFor()
  assert.equal(resumeRequests.length, 0, 'resume request should not fire before the dialog is confirmed')

  await profileSelect.selectOption('focus')
  const resumeRequestPromise = page.waitForRequest((request) => (
    request.method() === 'POST'
      && request.url().includes('/api/codex-sessions/session-1/resume')
      && request.postDataJSON()?.profile === 'focus'
  ))
  await page.getByRole('button', { name: 'Continue Session' }).click()
  await resumeRequestPromise

  assert.deepEqual(
    pageErrors.map((error) => String(error?.message || error)),
    [],
    `unexpected page errors:\n${pageErrors.map((error) => String(error?.stack || error)).join('\n\n')}\n\nserver logs:\n${getLogs()}`,
  )
})

test('browser regression: mobile codex history continue prefers the current cc-switch codex profile over stale local storage', { timeout: 120000 }, async (t) => {
  const { getLogs, page, pageErrors, password, port } = await launchBrowserApp(t, { mobile: true })

  await page.addInitScript(() => {
    localStorage.setItem('nexus_last_profile_codex', 'daily')
  })
  const ccSwitchProviderRequests = []
  await page.route('**/api/project-defaults**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: 'null',
    })
  })
  await page.route('**/api/cc-switch/providers?**', async (route) => {
    ccSwitchProviderRequests.push(route.request().url())
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        provider_id: 'provider-openai',
        kind: 'codex',
        name: 'OpenAI Official',
        is_current: true,
        existing_profile_id: 'focus',
        target_profile_id: 'cc-switch-openai-official',
      }]),
    })
  })

  await loginAndWaitForTerminal(page, port, password)
  await page.getByRole('button', { name: 'Codex History' }).click()
  const ccSwitchResponsePromise = page.waitForResponse((response) => (
    response.url().includes('/api/cc-switch/providers?kind=codex')
      && response.request().method() === 'GET'
  ))
  await page.getByRole('button', { name: 'Continue: Fix bug' }).click()
  await ccSwitchResponsePromise
  await page.waitForFunction(() => document.querySelector('select') instanceof HTMLSelectElement)
  await page.waitForFunction(() => document.body.textContent?.includes('Continue Session'))

  const profileSelect = page.locator('select')
  await profileSelect.waitFor()
  await page.waitForFunction(() => {
    const select = document.querySelector('select')
    return select instanceof HTMLSelectElement && select.value === 'focus'
  })
  assert.equal(await profileSelect.inputValue(), 'focus')
  assert.equal(ccSwitchProviderRequests.length > 0, true)

  assert.deepEqual(
    pageErrors.map((error) => String(error?.message || error)),
    [],
    `unexpected page errors:\n${pageErrors.map((error) => String(error?.stack || error)).join('\n\n')}\n\nserver logs:\n${getLogs()}`,
  )
})

test('browser regression: fatal codex attach failure stops connecting and shows the close reason', { timeout: 120000 }, async (t) => {
  const { getLogs, page, pageErrors, password, port } = await launchBrowserApp(t, { mobile: true })

  await loginAndWaitForTerminal(page, port, password)

  await page.evaluate(() => {
    const NativeWebSocket = window.WebSocket
    const closeCode = 1006

    function FailingSocket(url) {
      this.url = String(url)
      this.readyState = NativeWebSocket.CONNECTING
      window.setTimeout(() => {
        this.readyState = NativeWebSocket.CLOSED
        const event = { code: closeCode, reason: '', wasClean: false }
        this.onclose?.(event)
      }, 50)
    }

    FailingSocket.prototype.send = () => {}
    FailingSocket.prototype.close = function close() {
      this.readyState = NativeWebSocket.CLOSED
    }

    function PatchedWebSocket(url, protocols) {
      if (String(url).includes('window=7')) {
        return new FailingSocket(url)
      }
      return protocols === undefined
        ? new NativeWebSocket(url)
        : new NativeWebSocket(url, protocols)
    }

    Object.assign(PatchedWebSocket, NativeWebSocket)
    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      writable: true,
      value: PatchedWebSocket,
    })
  })

  await page.getByRole('button', { name: 'Codex History' }).click()
  await page.getByRole('button', { name: 'Continue: Fix bug' }).click()
  await page.getByRole('button', { name: 'Continue Session' }).click()

  await page.waitForFunction(() => document.body.textContent?.includes('连接失败，请重试'))
  await page.waitForFunction(() => !document.body.textContent?.includes('Connecting...'))

  assert.equal(await page.getByText('Connecting...').count(), 0)
  assert.match(await page.locator('body').innerText(), /连接失败，请重试/)
  assert.deepEqual(
    pageErrors.map((error) => String(error?.message || error)),
    [],
    `unexpected page errors:\n${pageErrors.map((error) => String(error?.stack || error)).join('\n\n')}\n\nserver logs:\n${getLogs()}`,
  )
})

test('browser regression: settings home syncs codex desktop history from cc-switch', { timeout: 120000 }, async (t) => {
  const { getLogs, page, pageErrors, password, port } = await launchBrowserApp(t)
  await page.addInitScript(() => {
    localStorage.setItem('nexus_sidebar_collapsed', 'false')
  })

  await loginAndWaitForTerminal(page, port, password)

  const syncRequests = []
  await page.route('**/api/cc-switch/codex/sync-history', async (route) => {
    syncRequests.push(route.request().method())
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        currentProviderCodex: 'provider-xmapi',
        targetAccountId: 'provider-xmapi',
        indexProjection: { writtenEntries: 1 },
        stateProjection: { writtenThreads: 1, targetModelProvider: 'custom' },
      }),
    })
  })

  await page.getByTitle('Settings').click()
  await page.getByRole('button', { name: 'Sync Codex Desktop History' }).waitFor()

  syncRequests.length = 0

  await page.getByRole('button', { name: 'Sync Codex Desktop History' }).click()
  await page.waitForFunction(() => document.body.textContent?.includes('Synced 1 Codex history entries to the current provider: provider-xmapi'))

  assert.deepEqual(syncRequests, ['POST'])
  assert.deepEqual(
    pageErrors.map((error) => String(error?.message || error)),
    [],
    `unexpected page errors:\n${pageErrors.map((error) => String(error?.stack || error)).join('\n\n')}\n\nserver logs:\n${getLogs()}`,
  )
})

test('browser regression: mobile settings modal stays scrollable and closable', { timeout: 120000 }, async (t) => {
  const { getLogs, page, pageErrors, password, port } = await launchBrowserApp(t, { mobile: true })

  await loginAndWaitForTerminal(page, port, password)

  await page.getByTitle('More').click()
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Sync Codex Desktop History' }).waitFor()

  const metrics = await page.getByText('Appearance').evaluate((heading) => {
    const dialog = heading.closest('.bg-nexus-bg')
    if (!(dialog instanceof HTMLElement)) return null
    const content = Array.from(dialog.children).find((child) => (
      child instanceof HTMLElement &&
      child.textContent?.includes('Appearance') &&
      child.textContent?.includes('About')
    ))
    if (!(content instanceof HTMLElement)) return null
    const dialogRect = dialog.getBoundingClientRect()
    const closeButton = dialog.querySelector('button')
    const closeRect = closeButton?.getBoundingClientRect()
    return {
      closeVisible: !!closeRect && closeRect.top >= 0 && closeRect.bottom <= window.innerHeight,
      contentCanScroll: content.scrollHeight > content.clientHeight,
      dialogBottom: dialogRect.bottom,
      dialogTop: dialogRect.top,
      viewportHeight: window.innerHeight,
    }
  })

  assert.ok(metrics, 'expected settings dialog metrics to be available')
  assert.equal(metrics.contentCanScroll, true, 'settings content should scroll inside the dialog on mobile')
  assert.equal(metrics.closeVisible, true, 'settings close button should be visible before scrolling')
  assert.ok(metrics.dialogTop >= 0, `settings dialog should start inside viewport: ${JSON.stringify(metrics)}`)
  assert.ok(metrics.dialogBottom <= metrics.viewportHeight, `settings dialog should fit inside viewport: ${JSON.stringify(metrics)}`)

  await page.getByText('Appearance').evaluate((heading) => {
    const dialog = heading.closest('.bg-nexus-bg')
    const content = dialog?.querySelector('.overflow-y-auto')
    if (content instanceof HTMLElement) content.scrollTop = content.scrollHeight
  })
  await page.getByText('About').waitFor()

  await page.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('button', { name: 'Close' }).waitFor({ state: 'hidden' })

  assert.deepEqual(
    pageErrors.map((error) => String(error?.message || error)),
    [],
    `unexpected page errors:\n${pageErrors.map((error) => String(error?.stack || error)).join('\n\n')}\n\nserver logs:\n${getLogs()}`,
  )
})

test('browser regression: mobile terminal vertical drag scrolls xterm history without cancelling native touch scroll', { timeout: 120000 }, async (t) => {
  const longOutput = Array.from({ length: 120 }, (_, index) => `mobile history line ${String(index + 1).padStart(3, '0')}`).join('\n') + '\n'
  const { getLogs, page, pageErrors, password, port } = await launchBrowserApp(t, {
    mobile: true,
    ptySnapshots: {
      'nexus-preview-rust:0': {
        output: longOutput,
        clients: 1,
      },
    },
  })
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket
    window.__nexusWsInstances = []
    window.__nexusTerminalTouchMoveStats = { total: 0, defaultPrevented: 0, preventDefaultCalls: 0, paths: [] }
    function isTerminalTouchMove(event) {
      const path = event.composedPath()
      return path.some((node) => node instanceof HTMLElement && node.classList.contains('xterm'))
    }
    const nativePreventDefault = Event.prototype.preventDefault
    Event.prototype.preventDefault = function patchedPreventDefault() {
      if (this.type === 'touchmove' && isTerminalTouchMove(this)) {
        window.__nexusTerminalTouchMoveStats.preventDefaultCalls += 1
      }
      return nativePreventDefault.call(this)
    }
    document.addEventListener('touchmove', (event) => {
      if (!isTerminalTouchMove(event)) return
      const path = event.composedPath()
      window.__nexusTerminalTouchMoveStats.total += 1
      if (event.defaultPrevented) window.__nexusTerminalTouchMoveStats.defaultPrevented += 1
      window.__nexusTerminalTouchMoveStats.paths.push(path.map((node) => {
        if (!(node instanceof HTMLElement)) return node.constructor?.name || String(node)
        const className = typeof node.className === 'string' ? node.className : ''
        return `${node.tagName.toLowerCase()}${className ? `.${className.replace(/\s+/g, '.')}` : ''}`
      }).slice(0, 8))
    }, { capture: true, passive: true })

    function PatchedWebSocket(url, protocols) {
      const socket = protocols === undefined
        ? new NativeWebSocket(url)
        : new NativeWebSocket(url, protocols)
      window.__nexusWsInstances.push(socket)
      return socket
    }
    Object.assign(PatchedWebSocket, NativeWebSocket)
    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      writable: true,
      value: PatchedWebSocket,
    })
  })

  await loginAndWaitForTerminal(page, port, password)
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('mobile history line 120'))

  const rect = await page.getByRole('button', { name: 'Select text' }).evaluate((button) => {
    const container = button.parentElement?.firstElementChild
    const bounds = container?.getBoundingClientRect()
    return bounds ? {
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
    } : null
  })

  assert.ok(rect, 'expected terminal container bounds to exist')

  const startX = rect.left + rect.width / 2
  const startY = rect.top + rect.height / 2
  const beforeScrollTop = await page.locator('.xterm-viewport').first().evaluate((viewport) => viewport.scrollTop)
  await dispatchMobileSwipe(page, [
    [startX, startY],
    [startX + 1, startY + 80],
    [startX + 1, startY + 160],
    [startX, startY + 240],
    [startX, startY + 320],
  ])

  await page.waitForFunction(() => {
    const viewport = document.querySelector('.xterm-viewport')
    return viewport instanceof HTMLElement && viewport.scrollTop < viewport.scrollHeight - viewport.clientHeight - 20
  })
  const afterScrollTop = await page.locator('.xterm-viewport').first().evaluate((viewport) => viewport.scrollTop)
  assert.ok(afterScrollTop < beforeScrollTop, `expected mobile drag to move xterm viewport upward, before=${beforeScrollTop}, after=${afterScrollTop}`)
  const touchMoveStats = await page.evaluate(() => window.__nexusTerminalTouchMoveStats)
  assert.ok(touchMoveStats.total > 0, `expected terminal touchmove events to be observed, got ${JSON.stringify(touchMoveStats)}`)
  assert.equal(
    touchMoveStats.preventDefaultCalls,
    0,
    `vertical terminal dragging must stay on the browser-native scroll path, got ${JSON.stringify(touchMoveStats)}`,
  )
  await page.getByRole('button', { name: '滚到底部' }).waitFor()

  await page.evaluate(() => {
    const socket = window.__nexusWsInstances?.at(-1)
    socket?.onmessage?.(new MessageEvent('message', { data: 'streaming output after touch scroll\n' }))
  })
  await delay(150)
  const afterStreamingScrollTop = await page.locator('.xterm-viewport').first().evaluate((viewport) => viewport.scrollTop)
  assert.ok(
    afterStreamingScrollTop < beforeScrollTop,
    `expected incoming output to preserve user scroll, before=${beforeScrollTop}, afterStream=${afterStreamingScrollTop}`,
  )

  assert.deepEqual(
    pageErrors.map((error) => String(error?.message || error)),
    [],
    `unexpected page errors:\n${pageErrors.map((error) => String(error?.stack || error)).join('\n\n')}\n\nserver logs:\n${getLogs()}`,
  )
})

test('browser regression: mobile terminal short drag scrolls immediately', { timeout: 120000 }, async (t) => {
  const longOutput = Array.from({ length: 120 }, (_, index) => `short drag history line ${String(index + 1).padStart(3, '0')}`).join('\n') + '\n'
  const { getLogs, page, pageErrors, password, port } = await launchBrowserApp(t, {
    mobile: true,
    ptySnapshots: {
      'nexus-preview-rust:0': {
        output: longOutput,
        clients: 1,
      },
    },
  })

  await loginAndWaitForTerminal(page, port, password)
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('short drag history line 120'))

  const rect = await page.getByRole('button', { name: 'Select text' }).evaluate((button) => {
    const container = button.parentElement?.firstElementChild
    const bounds = container?.getBoundingClientRect()
    return bounds ? {
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
    } : null
  })

  assert.ok(rect, 'expected terminal container bounds to exist')

  const startX = rect.left + rect.width / 2
  const startY = rect.top + rect.height / 2
  const beforeScrollTop = await page.locator('.xterm-viewport').first().evaluate((viewport) => viewport.scrollTop)
  await dispatchMobileSwipe(page, [
    [startX, startY],
    [startX + 1, startY + 18],
    [startX + 1, startY + 28],
  ])

  const afterScrollTop = await page.locator('.xterm-viewport').first().evaluate((viewport) => viewport.scrollTop)
  assert.ok(
    afterScrollTop < beforeScrollTop,
    `expected short mobile drag to move xterm viewport immediately, before=${beforeScrollTop}, after=${afterScrollTop}`,
  )

  assert.deepEqual(
    pageErrors.map((error) => String(error?.message || error)),
    [],
    `unexpected page errors:\n${pageErrors.map((error) => String(error?.stack || error)).join('\n\n')}\n\nserver logs:\n${getLogs()}`,
  )
})

test('browser regression: mobile diagonal-horizontal swipe switches channel even if the finger leaves terminal bounds', { timeout: 120000 }, async (t) => {
  const { getLogs, page, pageErrors, password, port } = await launchBrowserApp(t, { mobile: true })

  await loginAndWaitForTerminal(page, port, password)

  const rect = await page.getByRole('button', { name: 'Select text' }).evaluate((button) => {
    const container = button.parentElement?.firstElementChild
    const bounds = container?.getBoundingClientRect()
    return bounds ? {
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
    } : null
  })

  assert.ok(rect, 'expected terminal container bounds to exist')

  const startX = rect.left + rect.width - 40
  const startY = rect.top + rect.height / 2
  const attachRequest = page.waitForRequest((request) => (
    request.method() === 'POST' && request.url().includes('/api/sessions/1/attach?session=nexus-preview-rust')
  ), { timeout: 3000 })

  await dispatchMobileSwipe(page, [
    [startX, startY],
    [startX - 10, startY + 13],
    [startX - 90, startY + 24],
    [startX - 170, startY + 33],
    [rect.left - 20, startY + 40],
  ])

  await attachRequest
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('notes ready'))

  assert.deepEqual(
    pageErrors.map((error) => String(error?.message || error)),
    [],
    `unexpected page errors:\n${pageErrors.map((error) => String(error?.stack || error)).join('\n\n')}\n\nserver logs:\n${getLogs()}`,
  )
})
