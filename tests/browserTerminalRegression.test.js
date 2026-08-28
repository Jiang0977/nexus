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

async function dispatchSyntheticTouch(page, targetSelector, type, x, y) {
  await page.evaluate(({ selector, eventType, x, y }) => {
    const target = document.querySelector(selector)
    if (!(target instanceof HTMLElement)) {
      throw new Error(`synthetic swipe target not found: ${selector}`)
    }
    const touch = new Touch({
      identifier: 1,
      target,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      pageX: x,
      pageY: y,
      radiusX: 2,
      radiusY: 2,
      force: 1,
    })
    const ended = eventType === 'touchend' || eventType === 'touchcancel'
    target.dispatchEvent(new TouchEvent(eventType, {
      bubbles: true,
      cancelable: true,
      composed: true,
      touches: ended ? [] : [touch],
      targetTouches: ended ? [] : [touch],
      changedTouches: [touch],
    }))
  }, { selector: targetSelector, eventType: type, x, y })
}

async function dispatchSyntheticMobileSwipe(page, targetSelector, points) {
  await page.evaluate(({ selector, swipePoints }) => {
    const target = document.querySelector(selector)
    if (!(target instanceof HTMLElement)) {
      throw new Error(`synthetic swipe target not found: ${selector}`)
    }

    const fire = (type, x, y) => {
      const touch = new Touch({
        identifier: 1,
        target,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
        pageX: x,
        pageY: y,
        radiusX: 2,
        radiusY: 2,
        force: 1,
      })
      const ended = type === 'touchend' || type === 'touchcancel'
      target.dispatchEvent(new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        touches: ended ? [] : [touch],
        targetTouches: ended ? [] : [touch],
        changedTouches: [touch],
      }))
    }

    fire('touchstart', swipePoints[0][0], swipePoints[0][1])
    for (const [x, y] of swipePoints.slice(1)) {
      fire('touchmove', x, y)
    }
    const [endX, endY] = swipePoints[swipePoints.length - 1]
    fire('touchend', endX, endY)
  }, { selector: targetSelector, swipePoints: points })
}

async function waitForAnimationFrames(page, count = 2) {
  await page.evaluate((frameCount) => new Promise((resolve) => {
    const step = (left) => {
      if (left <= 0) {
        resolve(undefined)
        return
      }
      requestAnimationFrame(() => step(left - 1))
    }
    step(frameCount)
  }), count)
}

async function holdAnimationFrames(page) {
  await page.evaluate(() => {
    if (window.__nexusRafHold?.active) return
    const originalRaf = window.requestAnimationFrame.bind(window)
    const originalCaf = window.cancelAnimationFrame.bind(window)
    const pending = new Map()
    let nextId = 1
    window.__nexusRafHold = {
      active: true,
      originalCaf,
      originalRaf,
      pending,
    }
    window.requestAnimationFrame = (callback) => {
      const id = nextId
      nextId += 1
      pending.set(id, callback)
      return id
    }
    window.cancelAnimationFrame = (id) => {
      if (pending.has(id)) {
        pending.delete(id)
        return
      }
      originalCaf(id)
    }
  })
}

async function releaseAnimationFrames(page) {
  await page.evaluate(() => {
    const hold = window.__nexusRafHold
    if (!hold?.active) return
    hold.active = false
    window.requestAnimationFrame = hold.originalRaf
    window.cancelAnimationFrame = hold.originalCaf
  })
  // Let the compositor deliver scroll events so xterm can update ydisp before
  // any queued Viewport refresh writes scrollTop back from a stale buffer.
  await waitForAnimationFrames(page, 1)
  await page.evaluate(() => {
    const hold = window.__nexusRafHold
    if (!hold?.pending) return
    const callbacks = [...hold.pending.values()]
    hold.pending.clear()
    for (const callback of callbacks) hold.originalRaf(callback)
  })
  await waitForAnimationFrames(page, 2)
}

async function readTerminalViewportScroll(page) {
  return page.locator('.xterm-viewport').first().evaluate((viewport) => ({
    maxScrollTop: Math.max(0, viewport.scrollHeight - viewport.clientHeight),
    scrollTop: viewport.scrollTop,
  }))
}

async function waitForTerminalViewportAtBottom(page, selector, label) {
  await page.waitForFunction((viewportSelector) => {
    const viewport = document.querySelector(viewportSelector)
    if (!(viewport instanceof HTMLElement)) return false
    return viewport.scrollHeight - viewport.clientHeight > 400
  }, selector)

  await page.waitForFunction((viewportSelector) => {
    const viewport = document.querySelector(viewportSelector)
    if (!(viewport instanceof HTMLElement)) return false
    const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    return maxScrollTop <= 4 || viewport.scrollTop >= maxScrollTop - 4
  }, selector, { timeout: 10000 })

  const metrics = await page.evaluate((viewportSelector) => {
    const viewport = document.querySelector(viewportSelector)
    if (!(viewport instanceof HTMLElement)) return null
    const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    return {
      clientHeight: viewport.clientHeight,
      maxScrollTop,
      scrollHeight: viewport.scrollHeight,
      scrollTop: viewport.scrollTop,
    }
  }, selector)

  assert.ok(metrics, `expected ${label} terminal viewport to exist`)
  assert.ok(
    metrics.maxScrollTop <= 4 || metrics.scrollTop >= metrics.maxScrollTop - 4,
    `expected ${label} terminal viewport at bottom, got ${JSON.stringify(metrics)}`,
  )
}

async function assertSplitPaneTerminalScrollbarGutter(page, paneSelector) {
  const metrics = await page.evaluate((selector) => {
    const pane = document.querySelector(selector)
    const terminal = pane?.querySelector('.nexus-split-terminal .xterm')
    const viewport = pane?.querySelector('.xterm-viewport')
    if (!(terminal instanceof HTMLElement) || !(viewport instanceof HTMLElement)) return null

    const terminalRect = terminal.getBoundingClientRect()
    const screen = terminal.querySelector('.xterm-screen')
    const screenRight = screen instanceof HTMLElement ? screen.getBoundingClientRect().right : null
    const scrollbarWidth = viewport.offsetWidth - viewport.clientWidth

    return {
      paddingRight: Number.parseFloat(getComputedStyle(terminal).paddingRight),
      screenRight,
      scrollbarWidth,
      terminalRight: terminalRect.right,
    }
  }, paneSelector)

  assert.ok(metrics, `expected ${paneSelector} split terminal metrics`)
  assert.ok(
    metrics.paddingRight >= Math.max(16, metrics.scrollbarWidth),
    `expected split terminal right gutter to cover scrollbar, got ${JSON.stringify(metrics)}`,
  )
  if (metrics.screenRight !== null) {
    assert.ok(
      metrics.screenRight <= metrics.terminalRight - Math.max(0, metrics.scrollbarWidth - 2),
      `expected split terminal screen to stay left of scrollbar, got ${JSON.stringify(metrics)}`,
    )
  }
}

function installWebSocketCapture() {
  const NativeWebSocket = window.WebSocket
  window.__nexusWsInstances = []
  window.__nexusWsSends = []
  function PatchedWebSocket(url, protocols) {
    const socket = protocols === undefined
      ? new NativeWebSocket(url)
      : new NativeWebSocket(url, protocols)
    socket.__nexusUrl = String(url)
    const nativeSend = socket.send.bind(socket)
    socket.send = (data) => {
      window.__nexusWsSends.push({ data, url: socket.__nexusUrl })
      return nativeSend(data)
    }
    window.__nexusWsInstances.push(socket)
    return socket
  }
  Object.assign(PatchedWebSocket, NativeWebSocket)
  Object.defineProperty(window, 'WebSocket', {
    configurable: true,
    writable: true,
    value: PatchedWebSocket,
  })
}

function describeCapturedWebSocketSends(sends) {
  return JSON.stringify(sends.map(({ data, url }) => ({
    data: String(data),
    url: String(url).replace(/\?.*$/, ''),
  })))
}

async function dispatchCapturedWebSocketMessage(page, urlPart, data) {
  await page.evaluate(({ data, urlPart }) => {
    const socket = [...(window.__nexusWsInstances || [])].reverse()
      .find((candidate) => String(candidate.__nexusUrl || candidate.url || '').includes(urlPart))
    if (!socket) throw new Error(`captured WebSocket not found for ${urlPart}`)
    socket.onmessage?.(new MessageEvent('message', { data }))
  }, { data, urlPart })
}

async function dispatchCapturedWebSocketMessages(page, urlPart, chunks) {
  for (const chunk of chunks) {
    await dispatchCapturedWebSocketMessage(page, urlPart, chunk)
    await delay(10)
  }
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

test('browser regression: desktop split pane right-click copy preserves soft-wrapped terminal lines', { timeout: 120000 }, async (t) => {
  const longLine = `soft-wrap-${'x'.repeat(180)}-done`
  const { getLogs, page, pageErrors, password, port } = await launchBrowserApp(t, {
    ptySnapshots: {
      'nexus-preview-rust:1': {
        output: `${longLine}\n`,
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
  await page.waitForFunction(() => document.body.textContent?.includes('soft-wrap-'))
  await page.waitForFunction(() => document.body.textContent?.includes('-done'))

  const row = page.getByTestId('terminal-pane-pane-1').locator('.xterm-rows').first()
  const box = await row.boundingBox()
  assert.ok(box, 'expected xterm rows to be measurable')

  await page.mouse.move(box.x + 1, box.y + 12)
  await page.mouse.down()
  await page.mouse.move(box.x + Math.min(box.width - 24, 840), box.y + 54, { steps: 12 })
  await page.mouse.up()
  await page.mouse.click(box.x + 64, box.y + 12, { button: 'right' })

  const preparedText = await page.getByTestId('terminal-pane-pane-1').locator('.xterm-helper-textarea').first().evaluate((textarea) => {
    if (!(textarea instanceof HTMLTextAreaElement)) return null
    return textarea.value.substring(textarea.selectionStart, textarea.selectionEnd)
  })

  const copyResult = await page.getByTestId('terminal-pane-pane-1').locator('.nexus-split-terminal').first().evaluate((element) => {
    const data = new DataTransfer()
    const event = new ClipboardEvent('copy', {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    })
    element.dispatchEvent(event)
    return {
      defaultPrevented: event.defaultPrevented,
      text: data.getData('text/plain'),
    }
  })

  assert.equal(preparedText, longLine)
  assert.equal(copyResult.defaultPrevented, true)
  assert.equal(copyResult.text, longLine)

  assert.deepEqual(
    pageErrors.map((error) => String(error?.message || error)),
    [],
    `unexpected page errors:\n${pageErrors.map((error) => String(error?.stack || error)).join('\n\n')}\n\nserver logs:\n${getLogs()}`,
  )
})

test('browser regression: desktop split pane right-click copy joins indented hard-wrapped prose', { timeout: 120000 }, async (t) => {
  const hardWrappedText = '首页已经引用新 bundle，bundle 可下载，服务仍 active。由于部署验证成\r\n  功，不需要回滚。'
  const expectedText = '首页已经引用新 bundle，bundle 可下载，服务仍 active。由于部署验证成功，不需要回滚。\n'
  const { getLogs, page, pageErrors, password, port } = await launchBrowserApp(t, {
    ptySnapshots: {
      'nexus-preview-rust:1': {
        output: `${hardWrappedText}\n`,
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
  await page.waitForFunction(() => document.body.textContent?.includes('由于部署验证成'))
  await page.waitForFunction(() => document.body.textContent?.includes('功，不需要回滚'))

  const row = page.getByTestId('terminal-pane-pane-1').locator('.xterm-rows').first()
  const box = await row.boundingBox()
  assert.ok(box, 'expected xterm rows to be measurable')

  await page.mouse.move(box.x + 1, box.y + 12)
  await page.mouse.down()
  await page.mouse.move(box.x + Math.min(box.width - 24, 840), box.y + 38, { steps: 10 })
  await page.mouse.up()
  await page.mouse.click(box.x + 64, box.y + 12, { button: 'right' })

  const preparedText = await page.getByTestId('terminal-pane-pane-1').locator('.xterm-helper-textarea').first().evaluate((textarea) => {
    if (!(textarea instanceof HTMLTextAreaElement)) return null
    return textarea.value.substring(textarea.selectionStart, textarea.selectionEnd)
  })

  const copyResult = await page.getByTestId('terminal-pane-pane-1').locator('.nexus-split-terminal').first().evaluate((element) => {
    const data = new DataTransfer()
    const event = new ClipboardEvent('copy', {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    })
    element.dispatchEvent(event)
    return {
      defaultPrevented: event.defaultPrevented,
      text: data.getData('text/plain'),
    }
  })

  assert.equal(preparedText, expectedText)
  assert.equal(copyResult.defaultPrevented, true)
  assert.equal(copyResult.text, expectedText)

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
  assert.match(scrollbackRequests[0], /lines=10000/)

  assert.deepEqual(
    pageErrors.map((error) => String(error?.message || error)),
    [],
    `unexpected page errors:\n${pageErrors.map((error) => String(error?.stack || error)).join('\n\n')}\n\nserver logs:\n${getLogs()}`,
  )
})

test('browser regression: mobile selectable terminal text requests full scrollback and joins hard-wrapped prose', { timeout: 120000 }, async (t) => {
  const { getLogs, page, pageErrors, password, port } = await launchBrowserApp(t, { mobile: true })
  await loginAndWaitForTerminal(page, port, password)

  const wrappedProse = '首页已经引用新 bundle，bundle 可下载，服务仍 active。由于部署验证成\n  功，不需要回滚。'
  const normalizedProse = '首页已经引用新 bundle，bundle 可下载，服务仍 active。由于部署验证成功，不需要回滚。'
  const archivedLines = Array.from({ length: 3500 }, (_unused, index) => `archived mobile line ${String(index + 1).padStart(4, '0')}`)
  const fullScrollback = `${wrappedProse}\n${archivedLines.join('\n')}\nmobile scrollback tail\n`
  const scrollbackRequests = []

  await page.route('**/api/sessions/0/scrollback?**', async (route) => {
    const url = new URL(route.request().url())
    const requestedLines = Number(url.searchParams.get('lines') || '0')
    scrollbackRequests.push(route.request().url())
    const content = requestedLines >= 10000
      ? fullScrollback
      : `${archivedLines.slice(-3000).join('\n')}\nmobile scrollback tail\n`
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ content }),
    })
  })

  await page.getByRole('button', { name: 'Select text' }).click()

  const scrollbackText = page.locator('pre').filter({ hasText: normalizedProse }).first()
  await scrollbackText.waitFor()
  const text = await scrollbackText.textContent()

  assert.equal(scrollbackRequests.length, 1)
  assert.match(scrollbackRequests[0], /\/api\/sessions\/0\/scrollback\?/)
  assert.match(scrollbackRequests[0], /session=nexus-preview-rust/)
  assert.match(scrollbackRequests[0], /lines=10000/)
  assert.ok(text?.includes(normalizedProse), 'expected hard-wrapped Chinese prose to be joined for mobile selection copy')
  assert.ok(text?.includes('archived mobile line 0001'), 'expected mobile selectable text to include full scrollback, not only the tail')
  assert.doesNotMatch(text || '', /部署验证成\n  功/)

  assert.deepEqual(
    pageErrors.map((error) => String(error?.message || error)),
    [],
    `unexpected page errors:\n${pageErrors.map((error) => String(error?.stack || error)).join('\n\n')}\n\nserver logs:\n${getLogs()}`,
  )
})

test('browser regression: mobile selectable terminal text keeps bottom selection room', { timeout: 120000 }, async (t) => {
  const { getLogs, page, pageErrors, password, port } = await launchBrowserApp(t, { mobile: true })
  await loginAndWaitForTerminal(page, port, password)

  const scrollbackContent = Array.from({ length: 160 }, (_unused, index) => (
    `selectable bottom room line ${String(index + 1).padStart(3, '0')}`
  )).join('\n') + '\n'

  await page.route('**/api/sessions/0/scrollback?**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ content: scrollbackContent }),
    })
  })

  await page.getByRole('button', { name: 'Select text' }).click()
  await page.locator('pre').filter({ hasText: 'selectable bottom room line 160' }).waitFor()

  const metrics = await page.locator('[data-scrollback-overlay="true"]').evaluate((overlay) => {
    if (!(overlay instanceof HTMLElement)) return null
    const content = overlay.querySelector('[data-scrollback-content="true"]')
    const spacer = overlay.querySelector('[data-scrollback-bottom-spacer="true"]')
    if (!(content instanceof HTMLElement) || !(spacer instanceof HTMLElement)) return null
    const overlayRect = overlay.getBoundingClientRect()
    const contentRect = content.getBoundingClientRect()
    const spacerRect = spacer.getBoundingClientRect()
    return {
      bottomGap: overlayRect.bottom - contentRect.bottom,
      distanceFromAbsoluteBottom: overlay.scrollHeight - overlay.clientHeight - overlay.scrollTop,
      spacerHeight: spacerRect.height,
    }
  })

  assert.ok(metrics, 'expected scrollback overlay metrics to be available')
  assert.ok(metrics.spacerHeight >= 300, `expected mobile scrollback spacer to provide selection room: ${JSON.stringify(metrics)}`)
  assert.ok(metrics.bottomGap >= 150, `expected final lines to sit above the viewport bottom: ${JSON.stringify(metrics)}`)
  assert.ok(
    metrics.distanceFromAbsoluteBottom >= 120,
    `expected selectable text overlay to open before the close-at-bottom zone: ${JSON.stringify(metrics)}`,
  )

  await page.locator('[data-scrollback-overlay="true"]').evaluate((overlay) => {
    if (overlay instanceof HTMLElement) overlay.scrollTop += 40
  })
  await delay(150)
  await page.locator('pre').filter({ hasText: 'selectable bottom room line 160' }).waitFor()

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

test('browser regression: desktop split pane replay defaults to bottom', { timeout: 120000 }, async (t) => {
  const lineCount = 1200
  const replayChunks = Array.from({ length: 12 }, (_, chunkIndex) => (
    Array.from({ length: lineCount / 12 }, (_unused, lineIndex) => {
      const index = chunkIndex * (lineCount / 12) + lineIndex
      return `desktop refresh line ${String(index + 1).padStart(4, '0')}`
    }).join('\n') + '\n'
  ))
  const { getLogs, page, pageErrors, password, port } = await launchBrowserApp(t)
  await page.addInitScript(installWebSocketCapture)
  await page.addInitScript(() => {
    localStorage.setItem('nexus_sidebar_collapsed', 'false')
  })

  await loginAndWaitForTerminal(page, port, password)

  const channelRow = page.getByTestId('sidebar-channel-nexus-preview-rust-1')
  await channelRow.waitFor()
  const saveResponse = page.waitForResponse((response) => (
    response.url().includes('/api/workspace-layouts/active')
      && response.request().method() === 'PUT'
      && response.ok()
  ))
  await channelRow.dragTo(page.getByTestId('terminal-pane-pane-1'))
  await saveResponse
  await page.waitForFunction(() => (window.__nexusWsInstances || []).some((socket) => String(socket.__nexusUrl || '').includes('window=1')))
  await dispatchCapturedWebSocketMessages(page, 'window=1', replayChunks)
  await waitForTerminalViewportAtBottom(page, '[data-testid="terminal-pane-pane-1"] .xterm-viewport', 'desktop replay')
  await assertSplitPaneTerminalScrollbarGutter(page, '[data-testid="terminal-pane-pane-1"]')

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

test('browser regression: mobile terminal replay defaults to bottom', { timeout: 120000 }, async (t) => {
  const lineCount = 1200
  const replayChunks = Array.from({ length: 12 }, (_, chunkIndex) => (
    Array.from({ length: lineCount / 12 }, (_unused, lineIndex) => {
      const index = chunkIndex * (lineCount / 12) + lineIndex
      return `mobile refresh line ${String(index + 1).padStart(4, '0')}`
    }).join('\n') + '\n'
  ))
  const { getLogs, page, pageErrors, password, port } = await launchBrowserApp(t, { mobile: true })
  await page.addInitScript(installWebSocketCapture)

  await loginAndWaitForTerminal(page, port, password)
  await page.waitForFunction(() => (window.__nexusWsInstances || []).some((socket) => String(socket.__nexusUrl || '').includes('window=0')))
  await dispatchCapturedWebSocketMessages(page, 'window=0', replayChunks)
  await waitForTerminalViewportAtBottom(page, '.xterm-viewport', 'mobile replay')

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

test('browser regression: mobile terminal vertical drag still scrolls when native viewport does not move', { timeout: 120000 }, async (t) => {
  const longOutput = Array.from({ length: 120 }, (_, index) => `unmoved native history line ${String(index + 1).padStart(3, '0')}`).join('\n') + '\n'
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
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('unmoved native history line 120'))

  const metrics = await page.locator('.xterm-viewport').first().evaluate((viewport) => {
    const bounds = viewport.getBoundingClientRect()
    const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    return {
      height: bounds.height,
      left: bounds.left,
      maxScrollTop,
      scrollTop: viewport.scrollTop,
      top: bounds.top,
      width: bounds.width,
    }
  })

  assert.ok(metrics.maxScrollTop > 400, `expected ordinary buffer scroll range, got ${JSON.stringify(metrics)}`)
  assert.ok(
    metrics.scrollTop >= metrics.maxScrollTop - 4,
    `expected viewport at bottom before unmoved native drag, got ${JSON.stringify(metrics)}`,
  )

  const startX = metrics.left + metrics.width / 2
  const startY = metrics.top + metrics.height / 2
  await dispatchSyntheticMobileSwipe(page, '.xterm-viewport', [
    [startX, startY],
    [startX + 1, startY + 80],
    [startX + 1, startY + 160],
    [startX, startY + 240],
    [startX, startY + 320],
  ])

  await page.waitForFunction((beforeScrollTop) => {
    const viewport = document.querySelector('.xterm-viewport')
    return viewport instanceof HTMLElement && viewport.scrollTop < beforeScrollTop - 20
  }, metrics.scrollTop, { timeout: 5000 })
  const afterScrollTop = await page.locator('.xterm-viewport').first().evaluate((viewport) => viewport.scrollTop)
  assert.ok(
    afterScrollTop < metrics.scrollTop - 20,
    `expected app fallback to move xterm history when native pan did not, before=${metrics.scrollTop}, after=${afterScrollTop}, max=${metrics.maxScrollTop}`,
  )
  await page.getByRole('button', { name: '滚到底部' }).waitFor()

  assert.deepEqual(
    pageErrors.map((error) => String(error?.message || error)),
    [],
    `unexpected page errors:\n${pageErrors.map((error) => String(error?.stack || error)).join('\n\n')}\n\nserver logs:\n${getLogs()}`,
  )
})

test('browser regression: mobile terminal fallback still scrolls when streaming output changes scrollTop during an unmoved downward drag', { timeout: 120000 }, async (t) => {
  const longOutput = Array.from({ length: 120 }, (_, index) => `stream-unmoved history line ${String(index + 1).padStart(3, '0')}`).join('\n') + '\n'
  const streamChunk = Array.from({ length: 40 }, (_, index) => `live output during drag ${String(index + 1).padStart(2, '0')}`).join('\n') + '\n'
  const { getLogs, page, pageErrors, password, port } = await launchBrowserApp(t, {
    mobile: true,
    ptySnapshots: {
      'nexus-preview-rust:0': {
        output: longOutput,
        clients: 1,
      },
    },
  })
  await page.addInitScript(installWebSocketCapture)

  await loginAndWaitForTerminal(page, port, password)
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('stream-unmoved history line 120'))
  await page.waitForFunction(() => (window.__nexusWsInstances || []).some((socket) => String(socket.__nexusUrl || '').includes('window=0')))

  const startMetrics = await page.locator('.xterm-viewport').first().evaluate((viewport) => {
    const bounds = viewport.getBoundingClientRect()
    const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    return {
      height: bounds.height,
      left: bounds.left,
      maxScrollTop,
      scrollTop: viewport.scrollTop,
      top: bounds.top,
      width: bounds.width,
    }
  })
  assert.ok(startMetrics.maxScrollTop > 400, `expected ordinary buffer scroll range, got ${JSON.stringify(startMetrics)}`)
  assert.ok(
    startMetrics.scrollTop >= startMetrics.maxScrollTop - 4,
    `expected viewport at bottom before streaming drag, got ${JSON.stringify(startMetrics)}`,
  )

  const startX = startMetrics.left + startMetrics.width / 2
  const startY = startMetrics.top + startMetrics.height / 2
  await dispatchSyntheticTouch(page, '.xterm-viewport', 'touchstart', startX, startY)
  await dispatchSyntheticTouch(page, '.xterm-viewport', 'touchmove', startX + 1, startY + 10)
  await dispatchCapturedWebSocketMessage(page, 'window=0', streamChunk)
  await page.waitForFunction((previous) => {
    const viewport = document.querySelector('.xterm-viewport')
    return viewport instanceof HTMLElement && viewport.scrollTop > previous + 10
  }, startMetrics.scrollTop, { timeout: 5000 })

  const postStream = await page.locator('.xterm-viewport').first().evaluate((viewport) => ({
    maxScrollTop: Math.max(0, viewport.scrollHeight - viewport.clientHeight),
    scrollTop: viewport.scrollTop,
  }))
  assert.ok(
    postStream.scrollTop > startMetrics.scrollTop,
    `expected streaming output to move scrollTop away from the downward-history direction, before=${startMetrics.scrollTop}, after=${postStream.scrollTop}`,
  )

  await dispatchSyntheticTouch(page, '.xterm-viewport', 'touchmove', startX + 1, startY + 160)
  await dispatchSyntheticTouch(page, '.xterm-viewport', 'touchmove', startX, startY + 240)
  await dispatchSyntheticTouch(page, '.xterm-viewport', 'touchmove', startX, startY + 320)
  await dispatchSyntheticTouch(page, '.xterm-viewport', 'touchend', startX, startY + 320)

  await page.waitForFunction((postStreamScrollTop) => {
    const viewport = document.querySelector('.xterm-viewport')
    return viewport instanceof HTMLElement && viewport.scrollTop < postStreamScrollTop - 20
  }, postStream.scrollTop, { timeout: 5000 })
  await page.getByRole('button', { name: '滚到底部' }).waitFor()

  await dispatchCapturedWebSocketMessage(page, 'window=0', 'more live output after fallback\n')
  await delay(150)
  const afterMoreOutput = await page.locator('.xterm-viewport').first().evaluate((viewport) => ({
    maxScrollTop: Math.max(0, viewport.scrollHeight - viewport.clientHeight),
    scrollTop: viewport.scrollTop,
  }))
  assert.ok(
    afterMoreOutput.scrollTop < afterMoreOutput.maxScrollTop - 20,
    `expected fallback scrolled-up state to survive more output, got ${JSON.stringify(afterMoreOutput)}`,
  )
  await page.getByRole('button', { name: '滚到底部' }).waitFor()

  assert.deepEqual(
    pageErrors.map((error) => String(error?.message || error)),
    [],
    `unexpected page errors:\n${pageErrors.map((error) => String(error?.stack || error)).join('\n\n')}\n\nserver logs:\n${getLogs()}`,
  )
})

test('browser regression: delayed native viewport movement prevents mobile terminal fallback from double-scrolling', { timeout: 120000 }, async (t) => {
  const longOutput = Array.from({ length: 120 }, (_, index) => `delayed native history line ${String(index + 1).padStart(3, '0')}`).join('\n') + '\n'
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
    window.__nexusTerminalTouchMoveStats = { total: 0, defaultPrevented: 0, preventDefaultCalls: 0 }
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
  })

  await loginAndWaitForTerminal(page, port, password)
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('delayed native history line 120'))

  const metrics = await page.locator('.xterm-viewport').first().evaluate((viewport) => {
    const bounds = viewport.getBoundingClientRect()
    const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    return {
      height: bounds.height,
      left: bounds.left,
      maxScrollTop,
      scrollTop: viewport.scrollTop,
      top: bounds.top,
      width: bounds.width,
    }
  })
  assert.ok(metrics.maxScrollTop > 400, `expected ordinary buffer scroll range, got ${JSON.stringify(metrics)}`)
  assert.ok(
    metrics.scrollTop >= metrics.maxScrollTop - 4,
    `expected viewport at bottom before delayed native drag, got ${JSON.stringify(metrics)}`,
  )

  const startX = metrics.left + metrics.width / 2
  const startY = metrics.top + metrics.height / 2
  const session = await page.context().newCDPSession(page)
  const dispatchTouch = async (type, x, y) => {
    await session.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd'
        ? []
        : [{ x, y, radiusX: 2, radiusY: 2, force: 1, id: 1 }],
    })
  }

  await waitForAnimationFrames(page, 2)
  await holdAnimationFrames(page)
  await dispatchTouch('touchStart', startX, startY)
  for (const [x, y] of [
    [startX + 1, startY + 80],
    [startX + 1, startY + 160],
    [startX, startY + 240],
  ]) {
    await dispatchTouch('touchMove', x, y)
    await delay(30)
  }

  const afterNative = await readTerminalViewportScroll(page)
  assert.ok(
    afterNative.scrollTop < metrics.scrollTop - 40,
    `expected CDP native pan to move history while fallback rAF is held, start=${metrics.scrollTop}, afterNative=${afterNative.scrollTop}`,
  )
  assert.ok(
    metrics.scrollTop - afterNative.scrollTop < 480,
    `expected native-only movement while fallback rAF is held, not native+manual double-scroll, start=${metrics.scrollTop}, afterNative=${afterNative.scrollTop}`,
  )

  await releaseAnimationFrames(page)
  const afterDecision = await readTerminalViewportScroll(page)
  assert.ok(
    afterDecision.scrollTop > afterNative.scrollTop - 40,
    `expected releasing fallback rAF not to apply extra manual scroll, afterNative=${afterNative.scrollTop}, afterDecision=${afterDecision.scrollTop}`,
  )
  assert.ok(
    afterDecision.scrollTop < metrics.scrollTop - 40,
    `expected native history position to survive the deferred fallback decision, start=${metrics.scrollTop}, afterDecision=${afterDecision.scrollTop}`,
  )

  await dispatchTouch('touchMove', startX, startY + 320)
  await delay(30)
  await dispatchTouch('touchEnd', startX, startY + 320)
  await waitForAnimationFrames(page, 2)

  const finalScroll = await readTerminalViewportScroll(page)
  assert.ok(
    finalScroll.scrollTop < metrics.scrollTop - 40,
    `expected gesture to remain scrolled after native continuation, start=${metrics.scrollTop}, final=${finalScroll.scrollTop}`,
  )
  const touchMoveStats = await page.evaluate(() => window.__nexusTerminalTouchMoveStats)
  assert.equal(
    touchMoveStats.preventDefaultCalls,
    0,
    `delayed native movement must stay on the browser-native scroll path, got ${JSON.stringify(touchMoveStats)}`,
  )

  assert.deepEqual(
    pageErrors.map((error) => String(error?.message || error)),
    [],
    `unexpected page errors:\n${pageErrors.map((error) => String(error?.stack || error)).join('\n\n')}\n\nserver logs:\n${getLogs()}`,
  )
})

test('browser regression: reconnected Grok TUI forwards mouse wheel and touch scroll to the application', { timeout: 120000 }, async (t) => {
  const grokTuiReplay = 'Grok 4.6 reconnect frame without retained mouse mode'
  const { getLogs, page, pageErrors, password, port } = await launchBrowserApp(t, {
    mobile: true,
    ptySnapshots: {
      'nexus-preview-rust:0': {
        output: grokTuiReplay,
        clients: 1,
      },
    },
  })
  await page.addInitScript(installWebSocketCapture)

  await loginAndWaitForTerminal(page, port, password)
  await page.waitForFunction(() => (window.__nexusWsInstances || []).some((socket) => String(socket.__nexusUrl || '').includes('window=0')))
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('Grok 4.6 reconnect frame'))

  const terminalBounds = await page.locator('.xterm-viewport').first().evaluate((viewport) => {
    const bounds = viewport.getBoundingClientRect()
    return {
      height: bounds.height,
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
    }
  })
  const centerX = terminalBounds.left + terminalBounds.width / 2
  const centerY = terminalBounds.top + terminalBounds.height / 2

  await page.evaluate(() => { window.__nexusWsSends = [] })
  await page.mouse.move(centerX, centerY)
  await page.mouse.wheel(0, -120)
  await delay(100)
  const wheelSends = await page.evaluate(() => window.__nexusWsSends || [])
  assert.ok(
    wheelSends.some(({ data, url }) => (
      String(url).includes('window=0') && /^\x1b\[<64;\d+;\d+M$/.test(String(data))
    )),
    `expected reconnect fallback to forward mouse wheel-up as SGR input, got ${describeCapturedWebSocketSends(wheelSends)}`,
  )

  await page.evaluate(() => { window.__nexusWsSends = [] })
  await dispatchMobileSwipe(page, [
    [centerX, centerY],
    [centerX, centerY + 40],
    [centerX, centerY + 90],
    [centerX, centerY + 130],
  ])
  await delay(100)
  const touchSends = await page.evaluate(() => window.__nexusWsSends || [])
  assert.ok(
    touchSends.some(({ data, url }) => (
      String(url).includes('window=0') && /^\x1b\[<64;\d+;\d+M$/.test(String(data))
    )),
    `expected reconnect fallback to forward downward touch drag as SGR wheel-up input, got ${describeCapturedWebSocketSends(touchSends)}`,
  )

  assert.deepEqual(
    pageErrors.map((error) => String(error?.message || error)),
    [],
    `unexpected page errors:\n${pageErrors.map((error) => String(error?.stack || error)).join('\n\n')}\n\nserver logs:\n${getLogs()}`,
  )
})

test('browser regression: desktop pane forwards reconnected synchronized TUI wheel to the application', { timeout: 120000 }, async (t) => {
  const synchronizedTuiReplay = [
    '\x1b]0;Grok desktop reconnect\x07',
    '\x1b[?2026hGrok desktop reconnect frame one\x1b[?2026l',
    '\x1b[?2026hGrok desktop reconnect frame two\x1b[?2026l',
  ].join('')
  const { getLogs, page, pageErrors, password, port } = await launchBrowserApp(t, {
    extraChannels: [{ index: 0, name: 'preview', active: false, cwd: '/workspace' }],
    ptySnapshots: {
      'nexus-preview-rust:0': {
        output: synchronizedTuiReplay,
        clients: 1,
      },
    },
  })
  await page.addInitScript(installWebSocketCapture)
  await page.addInitScript(() => {
    localStorage.setItem('nexus_sidebar_collapsed', 'false')
  })

  await loginAndWaitForTerminal(page, port, password)
  const channelRow = page.locator('[draggable="true"]').filter({ hasText: 'preview' }).first()
  await channelRow.waitFor()
  await channelRow.dragTo(page.getByTestId('terminal-pane-pane-1'))
  const targetRows = page.getByTestId('terminal-pane-pane-1').locator('.xterm-rows').filter({ hasText: 'Grok desktop reconnect frame two' }).first()
  await targetRows.waitFor()
  const targetTerminal = targetRows.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " xterm ")][1]')
  const targetViewport = targetTerminal.locator('.xterm-viewport')
  const terminalBounds = await targetViewport.evaluate((viewport) => {
    const bounds = viewport.getBoundingClientRect()
    return {
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
    }
  })

  await page.evaluate(() => { window.__nexusWsSends = [] })
  await page.mouse.move(
    terminalBounds.left + terminalBounds.width / 2,
    terminalBounds.top + terminalBounds.height / 2,
  )
  await page.mouse.wheel(0, -120)
  await delay(100)
  const wheelSends = await page.evaluate(() => window.__nexusWsSends || [])
  assert.ok(
    wheelSends.some(({ data, url }) => (
      String(url).includes('window=0') && /^\x1b\[<64;\d+;\d+M$/.test(String(data))
    )),
    `expected desktop pane reconnect fallback to forward wheel-up as SGR input, got ${describeCapturedWebSocketSends(wheelSends)}`,
  )

  assert.deepEqual(
    pageErrors.map((error) => String(error?.message || error)),
    [],
    `unexpected page errors:\n${pageErrors.map((error) => String(error?.stack || error)).join('\n\n')}\n\nserver logs:\n${getLogs()}`,
  )
})

test('browser regression: desktop Codex synchronized updates keep native xterm scrollback', { timeout: 120000 }, async (t) => {
  const codexHistory = Array.from({ length: 180 }, (_unused, index) => (
    `Codex history line ${String(index + 1).padStart(3, '0')}\r\n`
  )).join('')
  const codexReplay = [
    '\x1b[?2026hCodex synchronized frame one\x1b[?2026l\r\n',
    '\x1b[?2026hCodex synchronized frame two\x1b[?2026l\r\n',
    codexHistory,
  ].join('')
  const { getLogs, page, pageErrors, password, port } = await launchBrowserApp(t, {
    extraChannels: [{ index: 0, name: 'codex', active: false, cwd: '/workspace' }],
    ptySnapshots: {
      'nexus-preview-rust:0': {
        output: codexReplay,
        clients: 1,
      },
    },
  })
  await page.addInitScript(installWebSocketCapture)
  await page.addInitScript(() => {
    localStorage.setItem('nexus_sidebar_collapsed', 'false')
  })

  await loginAndWaitForTerminal(page, port, password)
  const channelRow = page.locator('[draggable="true"]').filter({ hasText: 'codex' }).first()
  await channelRow.waitFor()
  await channelRow.dragTo(page.getByTestId('terminal-pane-pane-1'))
  const targetRows = page.getByTestId('terminal-pane-pane-1').locator('.xterm-rows').filter({ hasText: 'Codex history line 180' }).first()
  await targetRows.waitFor()
  const targetViewport = page.getByTestId('terminal-pane-pane-1').locator('.xterm-viewport')
  await targetViewport.evaluate((viewport) => {
    viewport.scrollTop = viewport.scrollHeight
  })
  const before = await targetViewport.evaluate((viewport) => ({
    maxScrollTop: Math.max(0, viewport.scrollHeight - viewport.clientHeight),
    scrollTop: viewport.scrollTop,
  }))
  assert.ok(before.maxScrollTop > 400, `expected Codex scrollback range, got ${JSON.stringify(before)}`)

  const terminalBounds = await targetViewport.evaluate((viewport) => {
    const bounds = viewport.getBoundingClientRect()
    return {
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
    }
  })
  await page.evaluate(() => { window.__nexusWsSends = [] })
  await page.mouse.move(
    terminalBounds.left + terminalBounds.width / 2,
    terminalBounds.top + terminalBounds.height / 2,
  )
  await page.mouse.wheel(0, -900)
  await delay(100)

  const after = await targetViewport.evaluate((viewport) => ({
    scrollTop: viewport.scrollTop,
  }))
  const wheelSends = await page.evaluate(() => window.__nexusWsSends || [])
  assert.equal(
    wheelSends.some(({ data, url }) => (
      String(url).includes('window=0') && /^\x1b\[<6[45];\d+;\d+M$/.test(String(data))
    )),
    false,
    `Codex wheel must not be forwarded as SGR input, got ${describeCapturedWebSocketSends(wheelSends)}`,
  )
  assert.ok(
    after.scrollTop < before.scrollTop - 20,
    `expected Codex xterm history to scroll, before=${before.scrollTop}, after=${after.scrollTop}`,
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

test('browser regression: window status polling requests a 4096-character output tail', { timeout: 120000 }, async (t) => {
  const { getLogs, page, pageErrors, password, port } = await launchBrowserApp(t)
  const outputUrls = []
  page.on('request', (request) => {
    const url = request.url()
    if (url.includes('/api/sessions/') && url.includes('/output')) {
      outputUrls.push(url)
    }
  })

  await loginAndWaitForTerminal(page, port, password)
  for (let attempt = 0; attempt < 20 && outputUrls.length === 0; attempt += 1) {
    await delay(100)
  }

  assert.ok(outputUrls.length > 0, `expected window output polling requests, server logs:\n${getLogs()}`)
  for (const url of outputUrls) {
    assert.match(
      url,
      /\/api\/sessions\/\d+\/output\?session=[^&]+&tailChars=4096(?:&|$)/,
      `expected bounded output polling URL, got ${url}`,
    )
  }

  assert.deepEqual(
    pageErrors.map((error) => String(error?.message || error)),
    [],
    `unexpected page errors:\n${pageErrors.map((error) => String(error?.stack || error)).join('\n\n')}\n\nserver logs:\n${getLogs()}`,
  )
})
