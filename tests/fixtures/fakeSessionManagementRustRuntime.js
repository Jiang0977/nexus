import { createInterface } from 'node:readline'

const mode = process.env.FAKE_SESSION_MANAGEMENT_RUNTIME_MODE || 'normal'
const workspaceRoot = (process.env.FAKE_SESSION_MANAGEMENT_WORKSPACE_ROOT || '/workspace').replace(/\/+$/, '') || '/'

function workspacePath(relativePath = '') {
  const relative = String(relativePath || '').replace(/^\/+/, '')
  if (!relative) return workspaceRoot
  if (workspaceRoot === '/') return `/${relative}`
  return `${workspaceRoot}/${relative}`
}

const state = {
  ready: true,
  source: 'fake-session-management-rust-runtime',
  version: '0.0-test',
  capabilities: {
    sessions: true,
    admin: true,
  },
  projectsCreated: 0,
  windowsCreated: 0,
}

function extraProjectChannels() {
  const raw = process.env.FAKE_SESSION_MANAGEMENT_EXTRA_CHANNELS_JSON || ''
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

if (mode === 'exit-immediately') {
  process.exit(7)
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function response(id, ok, resultOrError) {
  if (ok) {
    send({ kind: 'response', id, ok: true, result: resultOrError })
    return
  }
  send({ kind: 'response', id, ok: false, error: resultOrError })
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  if (!line.trim()) return

  let message = null
  try {
    message = JSON.parse(line)
  } catch {
    return
  }

  if (message.kind !== 'request') return

  const { id, method, params = {} } = message
  switch (method) {
    case 'ready':
      if (mode === 'exit-before-ready') process.exit(9)
      if (mode === 'hang-ready') return
      response(id, true, state)
      return
    case 'runtimeStatus':
      response(id, true, state)
      return
    case 'listTmuxSessions':
      response(id, true, [
        { name: 'nexus-preview-rust', windows: 1, attached: true },
        { name: 'demo-project', windows: 2, attached: false },
      ])
      return
    case 'listProjects':
      response(id, true, [
        { name: 'demo-project', path: workspacePath('demo'), active: false, channelCount: 2 },
        { name: 'nexus-preview-rust', path: workspacePath(), active: true, channelCount: 1 },
      ])
      return
    case 'getSessionCwd':
      response(id, true, {
        cwd: params.sessionName === 'demo-project' ? workspacePath('demo') : workspacePath(),
        relative: params.sessionName === 'demo-project' ? 'demo' : '',
      })
      return
    case 'listProjectChannels':
      response(id, true, {
        project: params.projectName || 'demo-project',
        channels: [
          ...extraProjectChannels(),
          { index: 2, name: 'review', active: false, cwd: workspacePath('demo') },
          { index: 1, name: 'shell', active: true, cwd: workspacePath() },
        ],
      })
      return
    case 'listSessionWindows':
      response(id, true, {
        session: params.sessionName || 'nexus-preview-rust',
        windows: [
          { index: 0, name: 'shell', active: true },
          { index: 1, name: 'notes', active: false },
        ],
      })
      return
    case 'activateProject':
      response(id, true, {
        active: true,
        project: params.projectName || 'demo-project',
        lastChannel: 4,
      })
      return
    case 'listCodexSessions':
      response(id, true, {
        scope: {
          project: params.projectName || 'demo-project',
          path: workspacePath('demo'),
          repoRoot: workspacePath('demo'),
          summary: `repo root: ${workspacePath('demo')}`,
        },
        items: [
          {
            id: 'session-1',
            title: 'Fix bug',
            updatedAt: '2026-04-14T12:00:00.000Z',
            cwd: workspacePath('demo'),
            attributionKind: 'repo-root',
          },
        ],
        nextCursor: null,
        warning: null,
      })
      return
    case 'getCodexSessionDetail':
      response(id, true, {
        id: params.sessionId || 'session-1',
        title: 'Fix bug',
        updatedAt: '2026-04-14T12:00:00.000Z',
        startedAt: '2026-04-14T11:59:00.000Z',
        cwd: workspacePath('demo'),
        attributionKind: 'repo-root',
        source: 'cli',
        originator: 'codex_cli_rs',
        cliVersion: '0.117.0',
        modelProvider: 'openai',
      })
      return
    case 'resumeCodexSession':
      state.windowsCreated += 1
      response(id, true, {
        ok: true,
        project: params.projectName || 'demo-project',
        channelIndex: 7,
        channelName: params.windowName || 'codex-history',
        sessionId: params.sessionId || 'session-1',
      })
      return
    case 'deleteProjectCodexSession':
      response(id, true, {
        ok: true,
        sessionId: params.sessionId || 'session-1',
        closedWindowIndexes: [7],
      })
      return
    case 'createProject':
      state.projectsCreated += 1
      state.windowsCreated += 1
      response(id, true, { ok: true })
      return
    case 'createProjectChannel':
      state.windowsCreated += 1
      response(id, true, { ok: true })
      return
    case 'createResumeWindow':
      state.windowsCreated += 1
      response(id, true, {
        windowId: '@9',
        index: 7,
        name: params.windowName || 'codex-history',
      })
      return
    case 'renameProject':
      response(id, true, {
        ok: true,
        oldName: params.oldName,
        newName: params.newName,
      })
      return
    case 'deleteProject':
      response(id, true, { ok: true })
      return
    case 'attachSessionWindow':
      response(id, true, { ok: true })
      return
    case 'renameSessionWindow':
      response(id, true, { ok: true, name: params.name })
      return
    case 'deleteSessionWindow':
      response(id, true, { ok: true })
      return
    case 'shutdown':
      response(id, true, { ok: true })
      process.exit(0)
      return
    default:
      response(id, false, { message: `unsupported method: ${method}` })
      return
  }
})

process.on('SIGTERM', () => process.exit(0))
