import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  buildCodexConfigToml,
  importCodexConfigFromGlobal,
  materializeCodexHome,
  normalizeCodexConfig,
  parseSimpleToml,
  resolveCodexRuntimeDir,
} from '../codexConfig.js'

test('parseSimpleToml keeps top-level values and simple sections', () => {
  const parsed = parseSimpleToml(`
model_provider = "custom"
model = "gpt-5.4"

[model_providers.custom]
base_url = "https://example.com/v1"
`)

  assert.equal(parsed.root.model_provider, 'custom')
  assert.equal(parsed.root.model, 'gpt-5.4')
  assert.equal(parsed.sections['model_providers.custom'].base_url, 'https://example.com/v1')
})

test('importCodexConfigFromGlobal extracts api key, model and base url', () => {
  const config = importCodexConfigFromGlobal(
    `
model_provider = "custom"
model = "gpt-5.4"
model_reasoning_effort = "high"

[model_providers.custom]
base_url = "https://example.com/v1"
`,
    JSON.stringify({ OPENAI_API_KEY: 'sk-test' }),
  )

  assert.deepEqual(config, {
    label: 'Imported (gpt-5.4)',
    OPENAI_API_KEY: 'sk-test',
    BASE_URL: 'https://example.com/v1',
    MODEL: 'gpt-5.4',
    REASONING_EFFORT: 'high',
    CONFIG_TOML: [
      'model_provider = "custom"',
      'model = "gpt-5.4"',
      'model_reasoning_effort = "high"',
      '',
      '[model_providers.custom]',
      'base_url = "https://example.com/v1"',
    ].join('\n'),
    AUTH_JSON: '{\n  "OPENAI_API_KEY": "sk-test"\n}',
    SYNC_SOURCE: '',
    SYNC_SOURCE_ID: '',
    SYNC_SOURCE_NAME: '',
  })
})

test('importCodexConfigFromGlobal preserves raw auth payloads for chatgpt login', () => {
  const configToml = [
    'model = "gpt-5.4"',
    '',
    '[mcp_servers.chrome-devtools]',
    'command = "npx"',
  ].join('\n')
  const authJson = JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
    },
  }, null, 2)

  const config = importCodexConfigFromGlobal(configToml, authJson)

  assert.equal(config.AUTH_JSON, authJson)
  assert.equal(config.CONFIG_TOML, configToml)
  assert.equal(config.OPENAI_API_KEY, '')
})

test('buildCodexConfigToml writes custom provider and trusted project path', () => {
  const toml = buildCodexConfigToml({
    BASE_URL: 'https://example.com/v1',
    MODEL: 'gpt-5.4',
    REASONING_EFFORT: 'medium',
  }, '/workspace/demo')

  assert.match(toml, /model_provider = "custom"/)
  assert.match(toml, /model = "gpt-5\.4"/)
  assert.match(toml, /model_reasoning_effort = "medium"/)
  assert.match(toml, /base_url = "https:\/\/example\.com\/v1"/)
  assert.match(toml, /\[projects\."\/workspace\/demo"\]/)
  assert.match(toml, /trust_level = "trusted"/)
})

test('materializeCodexHome creates isolated auth and config files', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'nexus-codex-home-'))

  try {
    materializeCodexHome({
      config: normalizeCodexConfig({
        OPENAI_API_KEY: 'sk-test',
        MODEL: 'gpt-5.4',
      }),
      homeDir,
      projectPath: '/workspace/demo',
    })

    const authText = readFileSync(join(homeDir, '.codex', 'auth.json'), 'utf8')
    const configToml = readFileSync(join(homeDir, '.codex', 'config.toml'), 'utf8')

    assert.match(authText, /"OPENAI_API_KEY": "sk-test"/)
    assert.match(configToml, /model = "gpt-5\.4"/)
    assert.match(configToml, /\[projects\."\/workspace\/demo"\]/)
  } finally {
    await rm(homeDir, { recursive: true, force: true })
  }
})

test('materializeCodexHome keeps imported raw auth and config while trusting the project path', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'nexus-codex-home-'))
  const authJson = JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: 'access-token' },
  }, null, 2)
  const configTomlText = [
    'model = "gpt-5.4"',
    '',
    '[mcp_servers.chrome-devtools]',
    'command = "npx"',
  ].join('\n')

  try {
    materializeCodexHome({
      config: normalizeCodexConfig({
        MODEL: 'gpt-5.4',
        CONFIG_TOML: configTomlText,
        AUTH_JSON: authJson,
      }),
      homeDir,
      projectPath: '/workspace/demo',
    })

    const authText = readFileSync(join(homeDir, '.codex', 'auth.json'), 'utf8').trim()
    const configToml = readFileSync(join(homeDir, '.codex', 'config.toml'), 'utf8')

    assert.equal(authText, authJson)
    assert.match(configToml, /\[mcp_servers\.chrome-devtools\]/)
    assert.match(configToml, /\[projects\."\/workspace\/demo"\]/)
  } finally {
    await rm(homeDir, { recursive: true, force: true })
  }
})

test('resolveCodexRuntimeDir sanitizes tmux window ids', () => {
  const runtimeDir = resolveCodexRuntimeDir('/tmp/nexus-codex-runtime', '@12')
  assert.equal(runtimeDir, '/tmp/nexus-codex-runtime/-12')
})
