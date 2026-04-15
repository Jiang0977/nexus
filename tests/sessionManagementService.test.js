import test from 'node:test'
import assert from 'node:assert/strict'

import { createSessionManagementService, SessionManagementError } from '../sessionManagementService.js'

function createService(overrides = {}) {
  const { execSyncImpl: execSyncOverride, ...serviceOverrides } = overrides
  const commands = []
  const cleanedRuntimeDirs = []
  const rememberedDefaults = []
  const setSessionEnvCalls = []
  const applyProxyEnvCalls = []
  const createdResumeWindows = []
  const markedResumeWindows = []
  const closedResumeSessions = []
  const deletedCodexSessions = []

  const execResponses = new Map()
  const execSyncImpl = (command, options = {}) => {
    commands.push(command)
    if (typeof execSyncOverride === 'function') {
      return execSyncOverride(command, options)
    }
    if (execResponses.has(command)) {
      return execResponses.get(command)
    }
    return ''
  }

  const service = createSessionManagementService({
    tmuxSession: 'nexus',
    workspaceRoot: '/workspace',
    sharedCodexHome: '/home/test/.codex',
    codexRuntimeDir: '/data/codex-runtime',
    defaultInteractiveShell: 'exec zsh -i',
    execSyncImpl,
    rmSyncImpl: (targetPath) => {
      cleanedRuntimeDirs.push(targetPath)
    },
    rememberProjectDefaultImpl: (...args) => {
      rememberedDefaults.push(args)
    },
    setTmuxSessionEnvImpl: (...args) => {
      setSessionEnvCalls.push(args)
    },
    applyProxyEnvToSessionImpl: (...args) => {
      applyProxyEnvCalls.push(args)
    },
    buildShellCommandImpl: (...args) => ({
      proxyVars: { HTTPS_PROXY: 'http://proxy.local' },
      shellCmd: `shell:${args.join(':')}`,
    }),
    ensureTmuxSessionImpl: () => {},
    createTmuxWindowSyncImpl: async (...args) => {
      createdResumeWindows.push(args)
      return { windowId: '@9', index: 3, name: 'codex-history' }
    },
    markTmuxWindowAsCodexResumeSessionImpl: (input) => {
      markedResumeWindows.push(input)
    },
    listProjectCodexSessionsImpl: (...args) => ({ items: args }),
    findProjectCodexSessionImpl: () => ({ cwd: '/workspace/demo', id: 'session-1', title: 'Fix bug' }),
    getProjectCodexSessionDetailImpl: () => ({
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
    }),
    deleteCodexSessionImpl: (input) => {
      deletedCodexSessions.push(input)
      return { id: input.sessionId }
    },
    closeTmuxWindowsForCodexSessionImpl: (input) => {
      closedResumeSessions.push(input)
      input.cleanupRuntime('@2')
      return [{ index: 2 }]
    },
    buildCodexResumeWindowNameImpl: () => 'codex-history',
    resolveCodexRuntimeDirImpl: (runtimeDir, windowId) => `${runtimeDir}/${windowId}`,
    ...serviceOverrides,
  })

  return {
    service,
    commands,
    execResponses,
    cleanedRuntimeDirs,
    rememberedDefaults,
    setSessionEnvCalls,
    applyProxyEnvCalls,
    createdResumeWindows,
    markedResumeWindows,
    closedResumeSessions,
    deletedCodexSessions,
  }
}

test('listProjects prefers NEXUS_CWD, falls back to first window path, and reverses output order', () => {
  const harness = createService({
    execSyncImpl(command) {
      if (command.includes('tmux list-sessions')) {
        return 'alpha|2|0\nbeta|1|1\n'
      }
      if (command.includes('show-environment -t alpha NEXUS_CWD')) {
        return 'NEXUS_CWD=/workspace/alpha\n'
      }
      if (command.includes('show-environment -t beta NEXUS_CWD')) {
        throw new Error('missing NEXUS_CWD')
      }
      if (command.includes("list-windows -t beta -F '#{pane_current_path}'")) {
        return '/workspace/beta\n'
      }
      return ''
    },
  })

  const projects = harness.service.listProjects()

  assert.deepEqual(projects, [
    { name: 'beta', path: '/workspace/beta', active: false, channelCount: 1 },
    { name: 'alpha', path: '/workspace/alpha', active: false, channelCount: 2 },
  ])
})

test('getSessionCwd falls back to pane_current_path and computes workspace-relative cwd', () => {
  const harness = createService({
    execSyncImpl(command) {
      if (command.includes('show-environment -t "demo" NEXUS_CWD')) {
        throw new Error('missing NEXUS_CWD')
      }
      if (command.includes(`display-message -t "demo" -p '#{pane_current_path}'`)) {
        return '/workspace/apps/demo\n'
      }
      return ''
    },
  })

  assert.deepEqual(harness.service.getSessionCwd('demo'), {
    cwd: '/workspace/apps/demo',
    relative: 'apps/demo',
  })
})

test('resumeCodexSession dedupes concurrent resume requests and returns the created channel', async () => {
  let releaseResume
  const resumeGate = new Promise((resolve) => {
    releaseResume = resolve
  })

  const harness = createService({
    execSyncImpl(command) {
      if (command.includes('tmux has-session -t "demo-project"')) {
        return ''
      }
      return ''
    },
    createTmuxWindowSyncImpl: async (...args) => {
      harness.createdResumeWindows.push(args)
      await resumeGate
      return { windowId: '@9', index: 7, name: 'codex-history' }
    },
  })

  const first = harness.service.resumeCodexSession({
    sessionId: 'session-1',
    projectName: 'demo-project',
  })
  const second = harness.service.resumeCodexSession({
    sessionId: 'session-1',
    projectName: 'demo-project',
  })

  releaseResume()
  const [firstResult, secondResult] = await Promise.all([first, second])

  assert.equal(harness.createdResumeWindows.length, 1)
  assert.equal(firstResult.deduped, false)
  assert.equal(secondResult.deduped, true)
  assert.deepEqual(firstResult, {
    ok: true,
    project: 'demo-project',
    channelIndex: 7,
    channelName: 'codex-history',
    sessionId: 'session-1',
    deduped: false,
  })
  assert.deepEqual(secondResult, {
    ok: true,
    project: 'demo-project',
    channelIndex: 7,
    channelName: 'codex-history',
    sessionId: 'session-1',
    deduped: true,
  })
  assert.deepEqual(harness.markedResumeWindows, [{
    windowTarget: '@9',
    sessionId: 'session-1',
  }])
  assert.deepEqual(harness.applyProxyEnvCalls, [['demo-project', { HTTPS_PROXY: 'http://proxy.local' }]])
})

test('resumeCodexSession default window naming avoids collisions with existing tmux windows', async () => {
  const harness = createService({
    buildCodexResumeWindowNameImpl: undefined,
    execSyncImpl(command) {
      if (command.includes('tmux has-session -t "demo-project"')) {
        return ''
      }
      if (command.includes('list-windows -t "demo-project" -F "#{window_name}" 2>/dev/null')) {
        return 'codex-fix-bug\nshell\n'
      }
      return ''
    },
  })

  await harness.service.resumeCodexSession({
    sessionId: 'session-1',
    projectName: 'demo-project',
  })

  assert.equal(harness.createdResumeWindows.length, 1)
  assert.equal(harness.createdResumeWindows[0][2], 'codex-fix-bug-1')
})

test('deleteProjectCodexSession validates inputs and closes tracked runtime windows', () => {
  const harness = createService({
    execSyncImpl(command) {
      if (command.includes('tmux has-session -t "demo-project"')) {
        return ''
      }
      return ''
    },
  })

  const result = harness.service.deleteProjectCodexSession({
    sessionId: 'session-1',
    projectName: 'demo-project',
  })

  assert.deepEqual(result, {
    ok: true,
    sessionId: 'session-1',
    closedWindowIndexes: [2],
  })
  assert.deepEqual(harness.deletedCodexSessions, [{
    sessionId: 'session-1',
    codexHome: '/home/test/.codex',
  }])
  assert.equal(harness.closedResumeSessions.length, 1)
  assert.deepEqual(harness.cleanedRuntimeDirs, ['/data/codex-runtime/@2'])

  assert.throws(
    () => harness.service.deleteProjectCodexSession({ sessionId: 'bad/id', projectName: 'demo-project' }),
    (error) => error instanceof SessionManagementError
      && error.statusCode === 400
      && error.message === 'invalid session id',
  )
})

test('codex history routes fail closed when the feature is disabled', async () => {
  const harness = createService({
    codexHistoryEnabled: false,
  })

  assert.throws(
    () => harness.service.listCodexSessions({ projectName: 'demo-project' }),
    (error) => error instanceof SessionManagementError
      && error.statusCode === 503
      && error.message === 'codex history disabled',
  )

  await assert.rejects(
    harness.service.resumeCodexSession({ sessionId: 'session-1', projectName: 'demo-project' }),
    (error) => error instanceof SessionManagementError
      && error.statusCode === 503
      && error.message === 'codex history disabled',
  )

  assert.throws(
    () => harness.service.getCodexSessionDetail({ sessionId: 'session-1', projectName: 'demo-project' }),
    (error) => error instanceof SessionManagementError
      && error.statusCode === 503
      && error.message === 'codex history disabled',
  )

  assert.throws(
    () => harness.service.deleteProjectCodexSession({ sessionId: 'session-1', projectName: 'demo-project' }),
    (error) => error instanceof SessionManagementError
      && error.statusCode === 503
      && error.message === 'codex history disabled',
  )
})

test('getCodexSessionDetail returns detail for matching project sessions and maps misses to 404', () => {
  const harness = createService()

  assert.deepEqual(
    harness.service.getCodexSessionDetail({ sessionId: 'session-1', projectName: 'demo-project' }),
    {
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
    },
  )

  const missingHarness = createService({
    getProjectCodexSessionDetailImpl: () => null,
  })

  assert.throws(
    () => missingHarness.service.getCodexSessionDetail({ sessionId: 'session-1', projectName: 'demo-project' }),
    (error) => error instanceof SessionManagementError
      && error.statusCode === 404
      && error.message === 'codex session not found in project',
  )
})

test('createProject generates a unique sanitized tmux session name and remembers defaults', () => {
  const harness = createService({
    resolveWorkspacePathImpl: (inputPath) => `/workspace/${inputPath}`,
    execSyncImpl(command) {
      if (command === 'tmux list-sessions -F "#{session_name}" 2>/dev/null') {
        return 'workspace-demo\nworkspace-demo-1\n'
      }
      if (command.includes('tmux new-session -d -s "workspace-demo-2"')) {
        return ''
      }
      return ''
    },
  })

  const result = harness.service.createProject({
    path: 'demo',
    shellType: 'codex',
    profile: 'work',
  })

  assert.deepEqual(result, {
    name: 'workspace-demo-2',
    path: '/workspace/demo',
    shell_type: 'codex',
    profile: 'work',
  })
  assert.deepEqual(harness.setSessionEnvCalls, [['workspace-demo-2', 'NEXUS_CWD', '/workspace/demo']])
  assert.deepEqual(harness.applyProxyEnvCalls, [['workspace-demo-2', { HTTPS_PROXY: 'http://proxy.local' }]])
  assert.deepEqual(harness.rememberedDefaults, [['/workspace/demo', 'codex', 'work']])
})

test('listProjectChannels preserves tmux list errors as transport-level failures', () => {
  const harness = createService({
    execSyncImpl(command) {
      if (command.includes('list-windows -t "missing-project" -F "#{window_index}|#{window_name}|#{window_active}|#{pane_current_path}"')) {
        throw new Error('no such session')
      }
      return ''
    },
  })

  assert.throws(
    () => harness.service.listProjectChannels('missing-project'),
    (error) => error instanceof SessionManagementError
      && error.statusCode === 500
      && error.message === 'no such session',
  )
})

test('deleteSessionWindow creates a fallback shell before killing the last tmux window', () => {
  const harness = createService({
    execSyncImpl(command) {
      if (command.includes(`display-message -t "nexus:3" -p '#{window_id}'`)) {
        return '@3\n'
      }
      if (command.includes(`list-windows -t "nexus" -F "#{window_index}"`)) {
        return '3\n'
      }
      return ''
    },
  })

  const result = harness.service.deleteSessionWindow({ session: 'nexus', index: '3' })

  assert.deepEqual(result, { ok: true })
  assert.deepEqual(harness.commands.slice(-2), [
    'tmux new-window -t "nexus" -n shell "exec zsh -i"',
    'tmux kill-window -t "nexus:3"',
  ])
  assert.deepEqual(harness.cleanedRuntimeDirs, ['/data/codex-runtime/@3'])
})

test('activateProject returns a validated last channel when present', () => {
  const harness = createService({
    execSyncImpl(command) {
      if (command === 'tmux has-session -t "demo-project" 2>/dev/null') return ''
      if (command.includes('show-environment -t "demo-project" NEXUS_LAST_CHANNEL')) {
        return 'NEXUS_LAST_CHANNEL=4\n'
      }
      if (command.includes('list-windows -t "demo-project" -F "#I"')) {
        return '1\n4\n'
      }
      return ''
    },
  })

  assert.deepEqual(harness.service.activateProject('demo-project'), {
    active: true,
    project: 'demo-project',
    lastChannel: 4,
  })
})
