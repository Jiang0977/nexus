import test from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { saveCodexConfig } from '../codexConfig.js'
import { saveProjectDefault } from '../projectDefaults.js'
import { ConfigProfilesError, createConfigProfilesService } from '../configProfilesService.js'

function createServiceRoot() {
  const rootDir = mkdtempSync(join(tmpdir(), 'nexus-config-profiles-'))
  mkdirSync(join(rootDir, 'configs'), { recursive: true })
  mkdirSync(join(rootDir, 'codex-configs'), { recursive: true })
  mkdirSync(join(rootDir, 'codex-validate'), { recursive: true })
  return rootDir
}

function createService(rootDir, overrides = {}) {
  return createConfigProfilesService({
    configsDir: join(rootDir, 'configs'),
    codexConfigsDir: join(rootDir, 'codex-configs'),
    toolbarConfigFile: join(rootDir, 'toolbar-config.json'),
    projectDefaultsFile: join(rootDir, 'project-defaults.json'),
    workspaceRoot: '/workspace',
    codexValidateDir: join(rootDir, 'codex-validate'),
    projectPath: '/workspace/nexus4cc',
    ...overrides,
  })
}

test('syncCurrentClaudeConfig keeps existing label and sync metadata', async () => {
  const rootDir = createServiceRoot()
  const configFile = join(rootDir, 'configs', 'team.json')
  writeFileSync(configFile, JSON.stringify({
    label: 'Team Profile',
    API_KEY: 'old-key',
    SYNC_SOURCE: 'cc-switch',
    SYNC_SOURCE_ID: 'provider-1',
  }, null, 2), 'utf8')

  const service = createService(rootDir, {
    readGlobalClaudeConfigImpl: () => ({
      API_KEY: 'new-key',
      DEFAULT_MODEL: 'claude-sonnet-4-5',
    }),
  })

  try {
    const result = service.syncCurrentClaudeConfig('team')

    assert.deepEqual(result, {
      ok: true,
      id: 'team',
      config: {
        id: 'team',
        label: 'Team Profile',
        API_KEY: 'new-key',
        DEFAULT_MODEL: 'claude-sonnet-4-5',
        SYNC_SOURCE: 'cc-switch',
        SYNC_SOURCE_ID: 'provider-1',
      },
    })

    const saved = JSON.parse(readFileSync(configFile, 'utf8'))
    assert.equal(saved.label, 'Team Profile')
    assert.equal(saved.SYNC_SOURCE, 'cc-switch')
    assert.equal(saved.SYNC_SOURCE_ID, 'provider-1')
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('importGlobalCodexConfig allocates a unique id when the preferred id already exists', async () => {
  const rootDir = createServiceRoot()
  writeFileSync(join(rootDir, 'codex-configs', 'imported.json'), JSON.stringify({ label: 'existing' }), 'utf8')

  const service = createService(rootDir, {
    readGlobalCodexConfigImpl: () => ({
      label: 'Imported from ~/.codex',
      MODEL: 'gpt-5.4',
      AUTH_JSON: JSON.stringify({ auth_mode: 'chatgpt' }),
    }),
  })

  try {
    const result = service.importGlobalCodexConfig({ id: 'Imported' })

    assert.equal(result.ok, true)
    assert.equal(result.id, 'imported-1')
    assert.equal(result.config.id, 'imported-1')
    assert.equal(result.config.MODEL, 'gpt-5.4')
    assert.equal(existsSync(join(rootDir, 'codex-configs', 'imported-1.json')), true)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('importCcSwitchProviderProfile reuses imported codex profile ids', async () => {
  const rootDir = createServiceRoot()
  const service = createService(rootDir, {
    listCodexConfigsImpl: () => [{
      id: 'cc-switch-xmapi',
      SYNC_SOURCE: 'cc-switch',
      SYNC_SOURCE_ID: 'provider-xmapi',
    }],
    importCcSwitchProviderImpl: ({ kind, providerId }) => ({
      label: `${kind}-${providerId}`,
      MODEL: 'gpt-5.4',
      AUTH_JSON: JSON.stringify({ auth_mode: 'chatgpt' }, null, 2),
      SYNC_SOURCE: 'cc-switch',
      SYNC_SOURCE_ID: providerId,
      SYNC_SOURCE_NAME: 'xmapi',
    }),
  })

  try {
    const result = service.importCcSwitchProviderProfile({
      kind: 'codex',
      providerId: 'provider-xmapi',
    })

    assert.equal(result.ok, true)
    assert.equal(result.id, 'cc-switch-xmapi')
    assert.equal(result.config.SYNC_SOURCE_ID, 'provider-xmapi')

    const saved = JSON.parse(readFileSync(join(rootDir, 'codex-configs', 'cc-switch-xmapi.json'), 'utf8'))
    assert.equal(saved.SYNC_SOURCE, 'cc-switch')
    assert.equal(saved.SYNC_SOURCE_ID, 'provider-xmapi')
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('config profile service rejects invalid cc-switch kinds', async () => {
  const rootDir = createServiceRoot()
  const service = createService(rootDir)

  try {
    assert.throws(
      () => service.listCcSwitchProviders('invalid'),
      (error) => error instanceof ConfigProfilesError
        && error.statusCode === 400
        && error.message === 'invalid kind',
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('getProjectDefaultForPath resolves workspace-relative paths and toolbar config round-trips', async () => {
  const rootDir = createServiceRoot()
  saveProjectDefault(join(rootDir, 'project-defaults.json'), {
    path: '/workspace/demo',
    shellType: 'codex',
    profile: 'work',
  })

  const service = createService(rootDir)

  try {
    assert.deepEqual(service.getProjectDefaultForPath('demo'), {
      path: '/workspace/demo',
      shell_type: 'codex',
      profile: 'work',
    })
    assert.equal(service.getProjectDefaultForPath(''), null)
    assert.equal(service.readToolbarConfig(), null)

    writeFileSync(join(rootDir, 'toolbar-config.json'), '{broken', 'utf8')
    assert.equal(service.readToolbarConfig(), null)

    assert.deepEqual(service.saveToolbarConfig({ pinned: ['enter'] }), { ok: true })
    assert.deepEqual(service.readToolbarConfig(), { pinned: ['enter'] })
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('validateCodexConfig skips exec validation for plain ChatGPT auth', async () => {
  const rootDir = createServiceRoot()
  saveCodexConfig(join(rootDir, 'codex-configs'), 'chatgpt-only', {
    label: 'ChatGPT Only',
    AUTH_JSON: JSON.stringify({ auth_mode: 'chatgpt' }, null, 2),
  })

  const calls = []
  const service = createService(rootDir, {
    collectProxyVarsImpl: () => ({ HTTPS_PROXY: 'http://proxy.local' }),
    materializeCodexHomeImpl: () => {},
    runCodexValidationCommandImpl: (tempHome, proxyVars, args, timeoutMs) => {
      calls.push({ tempHome, proxyVars, args, timeoutMs })
      return { status: 0, stdout: 'Logged in using ChatGPT' }
    },
  })

  try {
    const result = service.validateCodexConfig('chatgpt-only')

    assert.deepEqual(result, {
      ok: true,
      message: 'Logged in using ChatGPT',
    })
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].args, ['login', 'status'])
    assert.equal(calls[0].proxyVars.HTTPS_PROXY, 'http://proxy.local')
    assert.equal(existsSync(calls[0].tempHome), false)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('validateCodexConfig maps login timeout to a 504 config profile error', async () => {
  const rootDir = createServiceRoot()
  saveCodexConfig(join(rootDir, 'codex-configs'), 'chatgpt-timeout', {
    label: 'ChatGPT Timeout',
    AUTH_JSON: JSON.stringify({ auth_mode: 'chatgpt' }, null, 2),
  })

  const service = createService(rootDir, {
    materializeCodexHomeImpl: () => {},
    runCodexValidationCommandImpl: () => ({
      error: {
        code: 'ETIMEDOUT',
        message: 'timed out',
      },
    }),
  })

  try {
    assert.throws(
      () => service.validateCodexConfig('chatgpt-timeout'),
      (error) => error instanceof ConfigProfilesError
        && error.statusCode === 504
        && error.responseBody?.ok === false
        && /timed out after 15s/.test(error.message),
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
