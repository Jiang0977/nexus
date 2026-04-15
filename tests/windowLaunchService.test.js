import test from 'node:test'
import assert from 'node:assert/strict'

import { createWindowLaunchService, WindowLaunchError } from '../windowLaunchService.js'

function createService(overrides = {}) {
  const { execImpl: execOverride, ...serviceOverrides } = overrides
  const execCalls = []
  const setSessionEnvCalls = []
  const ensureSessionCalls = []
  const applyProxyEnvCalls = []
  const rememberedDefaults = []

  const execImpl = (command, callback) => {
    execCalls.push(command)
    if (typeof execOverride === 'function') {
      return execOverride(command, callback)
    }
    callback(null, '', '')
    return undefined
  }

  const service = createWindowLaunchService({
    tmuxSession: 'nexus',
    workspaceRoot: '/workspace',
    execImpl,
    resolveWorkspacePathImpl: (inputPath) => `/workspace/${String(inputPath).replace(/^\/+/, '')}`,
    readSessionWorkspacePathImpl: () => '/workspace/current',
    setTmuxSessionEnvImpl: (...args) => {
      setSessionEnvCalls.push(args)
    },
    buildShellCommandImpl: (...args) => ({
      proxyVars: { HTTPS_PROXY: 'http://proxy.local' },
      shellCmd: `shell:${args.join(':')}`,
    }),
    ensureTmuxSessionImpl: (...args) => {
      ensureSessionCalls.push(args)
    },
    applyProxyEnvToSessionImpl: (...args) => {
      applyProxyEnvCalls.push(args)
    },
    rememberProjectDefaultImpl: (...args) => {
      rememberedDefaults.push(args)
    },
    ...serviceOverrides,
  })

  return {
    service,
    execCalls,
    setSessionEnvCalls,
    ensureSessionCalls,
    applyProxyEnvCalls,
    rememberedDefaults,
  }
}

test('launchWindow updates NEXUS_CWD for rel_path requests and returns the created window payload', async () => {
  const harness = createService()

  const result = await harness.service.launchWindow({
    relPath: 'apps/demo',
    profile: 'work',
    shellType: 'codex',
    sessionName: 'demo-session',
  })

  assert.deepEqual(result, {
    name: 'workspace-apps-demo',
    cwd: '/workspace/apps/demo',
    shell_type: 'codex',
    profile: 'work',
    session: 'demo-session',
  })
  assert.deepEqual(harness.setSessionEnvCalls, [['demo-session', 'NEXUS_CWD', '/workspace/apps/demo']])
  assert.deepEqual(harness.ensureSessionCalls, [['demo-session']])
  assert.deepEqual(harness.applyProxyEnvCalls, [['demo-session', { HTTPS_PROXY: 'http://proxy.local' }]])
  assert.deepEqual(harness.rememberedDefaults, [['/workspace/apps/demo', 'codex', 'work']])
  assert.equal(
    harness.execCalls[0],
    'tmux new-window -t "demo-session" -c "/workspace/apps/demo" -n "workspace-apps-demo" "shell:codex:work:/workspace/apps/demo"',
  )
})

test('launchWindow falls back to the session workspace when rel_path is omitted', async () => {
  const harness = createService({
    readSessionWorkspacePathImpl: () => '/workspace/current-project',
  })

  const result = await harness.service.launchWindow({
    shellType: 'zsh',
    profile: '',
  })

  assert.deepEqual(result, {
    name: 'workspace-current-project',
    cwd: '/workspace/current-project',
    shell_type: 'zsh',
    profile: null,
    session: 'nexus',
  })
  assert.deepEqual(harness.setSessionEnvCalls, [])
  assert.deepEqual(harness.ensureSessionCalls, [['nexus']])
})

test('createSessionWindow requires rel_path and uses the explicit target session', async () => {
  const harness = createService()

  await assert.rejects(
    harness.service.createSessionWindow({ sessionName: 'demo-session' }),
    (error) => error instanceof WindowLaunchError
      && error.statusCode === 400
      && error.message === 'rel_path required',
  )

  const result = await harness.service.createSessionWindow({
    relPath: 'docs',
    profile: 'default',
    shellType: 'claude',
    sessionName: 'demo-session',
  })

  assert.deepEqual(result, {
    name: 'workspace-docs',
    cwd: '/workspace/docs',
    shell_type: 'claude',
    profile: 'default',
    session: 'demo-session',
  })
  assert.deepEqual(harness.setSessionEnvCalls, [])
})

test('launchWindow surfaces NEXUS_CWD update failures with the legacy error message shape', async () => {
  const harness = createService({
    setTmuxSessionEnvImpl: () => {
      throw new Error('permission denied')
    },
  })

  await assert.rejects(
    harness.service.launchWindow({ relPath: 'apps/demo' }),
    (error) => error instanceof WindowLaunchError
      && error.statusCode === 500
      && error.message === 'failed to set NEXUS_CWD: permission denied',
  )
})

test('createSessionWindow maps tmux new-window failures to transport-safe 500 errors', async () => {
  const harness = createService({
    execImpl(command, callback) {
      harness.execCalls.push(command)
      callback(new Error('tmux crashed'))
      return undefined
    },
  })

  await assert.rejects(
    harness.service.createSessionWindow({ relPath: 'apps/demo', sessionName: 'demo-session' }),
    (error) => error instanceof WindowLaunchError
      && error.statusCode === 500
      && error.message === 'tmux crashed',
  )
})
