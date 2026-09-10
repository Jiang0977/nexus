// Isolated binary-release smoke: never connects to an existing Nexus or tmux server.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'
import WebSocket from 'ws'

const archive = process.argv[2]
assert.ok(archive, 'Usage: node scripts/release-smoke.mjs release/nexus-VERSION-linux-x86_64.tar.gz [--screenshots]')
const root = mkdtempSync(join(tmpdir(), 'nexus-release-smoke-'))
const install = join(root, 'install')
mkdirSync(install)
mkdirSync(join(root, 'workspace'))
mkdirSync(join(root, 'workspace', 'demo-project'))
mkdirSync(join(root, 'tmux'), { mode: 0o700 })
mkdirSync(join(root, 'bin'))
const realTmux = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim()
assert.ok(realTmux)
writeFileSync(join(root, 'bin/tmux'), `#!/bin/sh\nexec ${realTmux} -S ${root}/tmux/test.sock -f /dev/null \"$@\"\n`, { mode: 0o755 })
const listener = createServer().listen(0, '127.0.0.1')
await once(listener, 'listening')
const port = listener.address().port
await new Promise(resolve => listener.close(resolve))
const env = { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, NEXUS_PROJECT_ROOT: install, NEXUS_DATA_DIR: join(install, 'data'), WORKSPACE_ROOT: join(root, 'workspace'), HOST: '127.0.0.1', PORT: String(port), TMUX_TMPDIR: join(root, 'tmux'), TMUX_SESSION: 'release-demo', NEXUS_SESSION_BACKEND: 'tmux', NEXUS_CODEX_HISTORY_ENABLED: '0' }
// Do not let user environment credentials or executable overrides enter the fixture.
for (const key of Object.keys(env)) if (/^NEXUS_.*(?:EXECUTABLE|ARGS|SOCKET)$/.test(key) || ['JWT_SECRET', 'ACC_PASSWORD_HASH', 'TMUX'].includes(key)) delete env[key]
let child, browser
try {
  assert.equal(spawnSync('tar', ['-xzf', resolve(archive), '-C', install, '--strip-components=1']).status, 0)
  const setup = spawnSync('bash', ['setup.sh', '--configure-only'], { cwd: install, env, encoding: 'utf8' })
  assert.equal(setup.status, 0, setup.stderr)
  const password = setup.stdout.match(/Password: (\S+)/)?.[1]
  assert.ok(password, 'installer must display the generated password')
  assert.equal(statSync(join(install, '.env')).mode & 0o777, 0o600)
  const cliEnv = { ...env }; delete cliEnv.NEXUS_PROJECT_ROOT; delete cliEnv.NEXUS_DATA_DIR
  const cli = spawnSync(join(install, 'rust-runtime/target/release/nexus-native-session'), ['list'], { cwd: root, env: cliEnv, encoding: 'utf8' })
  assert.equal(cli.status, 0, cli.stderr)
  child = spawn('bash', ['start.sh'], { cwd: install, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''
  child.stdout.on('data', chunk => { logs += chunk })
  child.stderr.on('data', chunk => { logs += chunk })
  const base = `http://127.0.0.1:${port}`
  let ready = false
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break } } catch {}
    if (child.exitCode !== null) break
    await delay(100)
  }
  assert.ok(ready, `server failed to start: ${logs}`)
  assert.equal((await fetch(`${base}/api/version`)).status, 401)
  const loginResponse = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) })
  assert.equal(loginResponse.status, 200)
  const { token } = await loginResponse.json()
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const version = await (await fetch(`${base}/api/version`, { headers })).json()
  assert.equal(version.current, 'v' + readFileSync(join(install, 'VERSION'), 'utf8').split('\n')[0])
  const response = await fetch(`${base}/api/projects`, { method: 'POST', headers, body: JSON.stringify({ path: 'demo-project', shell_type: 'bash' }) })
  assert.equal(response.status, 200, await response.clone().text())
  const project = await response.json()
  assert.ok(project.name)
  const renamed = await fetch(`${base}/api/projects/${encodeURIComponent(project.name)}/rename`, { method: 'POST', headers, body: JSON.stringify({ name: 'demo-project' }) })
  assert.equal(renamed.status, 200)
  project.name = 'demo-project'
  assert.equal(spawnSync('tmux', ['set-option', '-g', 'status', 'off'], { env }).status, 0)
  const url = new URL('/ws', base.replace('http:', 'ws:'))
  url.search = new URLSearchParams({ token, session: project.name, window: '0', terminalProtocol: '2', cols: '100', rows: '30' })
  const connect = async () => {
    const ws = new WebSocket(url)
    let output = ''
    ws.on('message', (data, binary) => { if (!binary) output += data.toString() })
    await once(ws, 'open')
    return { ws, output: () => output }
  }
  const first = await connect()
  await delay(300)
  first.ws.send("export PS1='$ '; printf '\\033[2J\\033[HWelcome to Nexus\\n\\nProject: demo-project\\nChannel: Bash\\n\\nYour local coding workspace, available from a browser.\\n'\r")
  for (let i = 0; i < 50 && !first.output().includes('Welcome to Nexus'); i++) await delay(100)
  assert.match(first.output(), /Welcome to Nexus/, logs)
  first.ws.close()
  const second = await connect()
  for (let i = 0; i < 50 && !second.output().includes('Welcome to Nexus'); i++) await delay(100)
  assert.match(second.output(), /Welcome to Nexus/)
  second.ws.close()
  browser = await chromium.launch({ ...(process.env.NEXUS_BROWSER_EXECUTABLE ? { executablePath: process.env.NEXUS_BROWSER_EXECUTABLE } : {}), headless: true })
  const pageErrors = []
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 }, isMobile: mobile, hasTouch: mobile })
    await context.addInitScript(({ project }) => {
      localStorage.setItem('i18nextLng', 'en')
      localStorage.setItem('nexus_guide_seen', 'true')
      localStorage.setItem('nexus_session', project)
      localStorage.setItem('nexus_session_source', 'user')
      localStorage.setItem('nexus_window', '0')
      localStorage.setItem('nexus_window_' + project, '0')
      localStorage.setItem('nexus_sidebar_collapsed', 'false')
    }, { project: project.name })
    const page = await context.newPage()
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.goto(base)
    await page.getByPlaceholder('Enter password').fill(password)
    await page.getByRole('button', { name: 'Login', exact: true }).click()
    await delay(500)
    const later = page.getByRole('button', { name: /Later|稍后设置/i })
    if (await later.isVisible()) await later.click()
    if (!mobile) await page.getByTestId(`sidebar-channel-${project.name}-0`).click()
    try { await page.locator('.xterm-screen').first().waitFor({ timeout: 10000 }) } catch (error) { console.error((await page.locator('body').innerText()).slice(0,5000)); throw error }
    await delay(700)
    await page.reload()
    await page.locator('.xterm-screen').first().waitFor()
    await delay(500)
    if (await later.isVisible()) await later.click()
    await delay(300)
    if (process.argv.includes('--screenshots')) {
      mkdirSync('docs/images', { recursive: true })
      await page.screenshot({ path: `docs/images/${mobile ? 'mobile' : 'desktop'}.png` })
    }
    await context.close()
  }
  assert.deepEqual(pageErrors, [])
  console.log(JSON.stringify({ passed: true, version, checks: ['configure-only', '0600', 'cli-outside-install-directory', 'health', 'auth', 'create-project', 'real-tmux-input', 'tmux-reconnect', 'desktop-login-refresh', 'mobile-login-refresh', 'no-browser-errors'] }))
} finally {
  await browser?.close()
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await Promise.race([once(child, 'exit'), delay(5000)])
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  // TMUX_TMPDIR is an isolated directory created by this test.
  spawnSync('tmux', ['kill-server'], { env, stdio: 'ignore' })
  rmSync(root, { recursive: true, force: true })
}
