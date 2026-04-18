import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createSessionManagementRustClient } from './helpers/sessionManagementRustClient.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'fakeSessionManagementRustRuntime.js')

function createClient(overrides = {}) {
  return createSessionManagementRustClient({
    runtimeExecutable: process.execPath,
    runtimeArgs: [FIXTURE],
    env: {
      ...process.env,
      FAKE_SESSION_MANAGEMENT_RUNTIME_MODE: 'normal',
      ...overrides.env,
    },
    readyTimeoutMs: overrides.readyTimeoutMs || 500,
    log: { log() {}, error() {} },
  })
}

test('rust session management client waits for ready and maps project/channel/resume and interaction methods onto the contract', async (t) => {
  const events = []
  const client = createClient()
  t.after(async () => {
    await client.close()
  })

  client.onEvent((event) => {
    events.push(event)
  })

  const ready = await client.ready()
  assert.equal(ready.ready, true)
  assert.equal(ready.source, 'fake-session-management-rust-runtime')
  assert.equal(ready.capabilities.sessions, true)

  assert.deepEqual(await client.listTmuxSessions(), [
    { name: 'nexus-preview-rust', windows: 1, attached: true },
    { name: 'demo-project', windows: 2, attached: false },
  ])

  assert.deepEqual(await client.listProjects(), [
    { name: 'demo-project', path: '/workspace/demo', active: false, channelCount: 2 },
    { name: 'nexus-preview-rust', path: '/workspace', active: true, channelCount: 1 },
  ])

  assert.deepEqual(await client.getSessionCwd({ sessionName: 'demo-project' }), {
    cwd: '/workspace/demo',
    relative: 'demo',
  })

  assert.deepEqual(await client.listProjectChannels({ projectName: 'demo-project' }), {
    project: 'demo-project',
    channels: [
      { index: 2, name: 'review', active: false, cwd: '/workspace/demo' },
      { index: 1, name: 'shell', active: true, cwd: '/workspace' },
    ],
  })

  assert.deepEqual(await client.listSessionWindows({ sessionName: 'demo-project' }), {
    session: 'demo-project',
    windows: [
      { index: 0, name: 'shell', active: true },
      { index: 1, name: 'notes', active: false },
    ],
  })

  assert.deepEqual(await client.activateProject({ projectName: 'demo-project' }), {
    active: true,
    project: 'demo-project',
    lastChannel: 4,
  })

  assert.deepEqual(await client.listCodexSessions({
    projectName: 'demo-project',
    limit: 10,
    cursor: '0',
  }), {
    scope: {
      project: 'demo-project',
      path: '/workspace/demo',
      repoRoot: '/workspace/demo',
      summary: 'repo root: /workspace/demo',
    },
    items: [
      {
        id: 'session-1',
        title: 'Fix bug',
        updatedAt: '2026-04-14T12:00:00.000Z',
        cwd: '/workspace/demo',
        attributionKind: 'repo-root',
      },
    ],
    nextCursor: null,
    warning: null,
  })

  assert.deepEqual(await client.getCodexSessionDetail({
    sessionId: 'session-1',
    projectName: 'demo-project',
  }), {
    id: 'session-1',
    title: 'Fix bug',
    updatedAt: '2026-04-14T12:00:00.000Z',
    startedAt: '2026-04-14T11:59:00.000Z',
    cwd: '/workspace/demo',
    attributionKind: 'repo-root',
    source: 'cli',
    originator: 'codex_cli_rs',
    cliVersion: '0.117.0',
    modelProvider: 'openai',
  })

  assert.deepEqual(await client.resumeCodexSession({
    sessionId: 'session-1',
    projectName: 'demo-project',
    cwd: '/workspace/demo',
    windowName: 'codex-history',
    shellCmd: 'shell:codex::/workspace/demo:[object Object]',
    proxyVars: { HTTPS_PROXY: 'http://proxy.local' },
  }), {
    ok: true,
    project: 'demo-project',
    channelIndex: 7,
    channelName: 'codex-history',
    sessionId: 'session-1',
  })

  assert.deepEqual(await client.deleteProjectCodexSession({
    sessionId: 'session-1',
    projectName: 'demo-project',
    defaultShellCmd: 'exec zsh -i',
  }), {
    ok: true,
    sessionId: 'session-1',
    closedWindowIndexes: [7],
  })

  const createdProject = await client.createProject({
    sessionName: 'workspace-demo',
    cwd: '/workspace/demo',
    initialWindowName: 'demo-work',
    shellCmd: 'shell:codex:work:/workspace/demo',
    proxyVars: { HTTPS_PROXY: 'http://proxy.local' },
  })
  assert.deepEqual(createdProject, { ok: true })

  const createdChannel = await client.createProjectChannel({
    sessionName: 'workspace-demo',
    cwd: '/workspace/demo',
    channelName: 'review',
    shellCmd: 'exec zsh -i',
    defaultShellCmd: 'exec zsh -i',
    proxyVars: {},
  })
  assert.deepEqual(createdChannel, { ok: true })

  const resumed = await client.createResumeWindow({
    sessionName: 'workspace-demo',
    cwd: '/workspace/demo',
    windowName: 'codex-history',
    shellCmd: 'shell:codex::/workspace/demo:[object Object]',
    defaultShellCmd: 'exec zsh -i',
    proxyVars: { HTTPS_PROXY: 'http://proxy.local' },
  })
  assert.deepEqual(resumed, {
    windowId: '@9',
    index: 7,
    name: 'codex-history',
  })

  const renamedProject = await client.renameProject({
    oldName: 'workspace-demo',
    newName: 'workspace-demo-renamed',
  })
  assert.deepEqual(renamedProject, {
    ok: true,
    oldName: 'workspace-demo',
    newName: 'workspace-demo-renamed',
  })

  const attached = await client.attachSessionWindow({
    sessionName: 'workspace-demo-renamed',
    index: 7,
  })
  assert.deepEqual(attached, { ok: true })

  const renamedWindow = await client.renameSessionWindow({
    sessionName: 'workspace-demo-renamed',
    index: 7,
    name: 'review-tab',
  })
  assert.deepEqual(renamedWindow, { ok: true, name: 'review-tab' })

  const deletedWindow = await client.deleteSessionWindow({
    sessionName: 'workspace-demo-renamed',
    index: 7,
    createFallbackShell: true,
    defaultShellCmd: 'exec zsh -i',
  })
  assert.deepEqual(deletedWindow, { ok: true })

  const deletedProject = await client.deleteProject({
    sessionName: 'workspace-demo-renamed',
  })
  assert.deepEqual(deletedProject, { ok: true })
  assert.deepEqual(events, [])

  const status = await client.getStatus()
  assert.equal(status.projectsCreated, 1)
  assert.equal(status.windowsCreated, 4)
})

test('rust session management client rejects pending ready and emits fatal when the runtime exits before readiness', async (t) => {
  const events = []
  const client = createClient({
    env: { FAKE_SESSION_MANAGEMENT_RUNTIME_MODE: 'exit-before-ready' },
  })
  t.after(async () => {
    await client.close()
  })

  client.onEvent((event) => {
    events.push(event)
  })

  await assert.rejects(client.ready(), /session management rust runtime exited/)
  assert.deepEqual(events, [{
    type: 'fatal',
    message: 'session management rust runtime exited (code=9, signal=null)',
  }])
})
