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

async function launchBrowserApp(t, { mobile = false } = {}) {
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
    FAKE_PTY_RUNTIME_SNAPSHOT_JSON: JSON.stringify({
      'nexus-preview-rust:0': {
        output: 'preview shell ready\n',
        clients: 1,
      },
      'nexus-preview-rust:1': {
        output: 'notes ready\n',
        clients: 0,
      },
    }),
  })

  t.after(async () => {
    await stopChild(child)
    rmSync(projectRoot, { recursive: true, force: true })
  })

  await waitForHealthyHttp(port, child)

  const browser = await chromium.launch({ headless: true })
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
  await page.getByRole('button', { name: 'Select text' }).waitFor()
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

test('browser regression: desktop terminal viewport fills the available height', { timeout: 120000 }, async (t) => {
  const { getLogs, page, pageErrors, password, port } = await launchBrowserApp(t)

  await loginAndWaitForTerminal(page, port, password)

  const metrics = await page.getByRole('button', { name: 'Select text' }).evaluate((button) => {
    const viewportRoot = button.parentElement
    const rightWrapper = viewportRoot?.parentElement
    return {
      viewportHeight: viewportRoot?.getBoundingClientRect().height ?? 0,
      wrapperHeight: rightWrapper?.getBoundingClientRect().height ?? 0,
      windowHeight: window.innerHeight,
    }
  })

  assert.ok(metrics.wrapperHeight > 0, `expected terminal wrapper height to be measurable, got ${JSON.stringify(metrics)}`)
  assert.ok(
    Math.abs(metrics.viewportHeight - metrics.wrapperHeight) <= 1,
    `expected terminal viewport to fill wrapper height, got ${JSON.stringify(metrics)}`,
  )
  assert.ok(
    Math.abs(metrics.viewportHeight - metrics.windowHeight) <= 1,
    `expected desktop terminal viewport to fill the screen height, got ${JSON.stringify(metrics)}`,
  )
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
