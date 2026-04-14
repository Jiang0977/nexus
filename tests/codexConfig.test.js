import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  buildCodexValidationConfig,
  buildCodexConfigToml,
  detectCodexAuthMode,
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
    assert.match(configToml, /\[features\]/)
    assert.match(configToml, /apps = false/)
    assert.match(configToml, /plugins = false/)
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

test('materializeCodexHome seeds resume and custom skill state from source codex home', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'nexus-codex-home-'))
  const sourceHome = mkdtempSync(join(tmpdir(), 'nexus-codex-source-'))
  const sourceCodexDir = join(sourceHome, '.codex')
  const customSkillDir = join(sourceCodexDir, 'skills', 'my-custom-skill')
  const sessionsDir = join(sourceCodexDir, 'sessions', '2026', '04', '14')
  const pluginCacheDir = join(sourceCodexDir, 'plugins', 'cache', 'openai-curated', 'github', 'hash')
  const tmpPluginsAgentsDir = join(sourceCodexDir, '.tmp', 'plugins', '.agents', 'plugins')
  const vendorImportsDir = join(sourceCodexDir, 'vendor_imports')
  const cacheDir = join(sourceCodexDir, 'cache', 'codex_apps_tools')

  mkdirSync(customSkillDir, { recursive: true })
  mkdirSync(sessionsDir, { recursive: true })
  mkdirSync(pluginCacheDir, { recursive: true })
  mkdirSync(tmpPluginsAgentsDir, { recursive: true })
  mkdirSync(vendorImportsDir, { recursive: true })
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(join(sourceCodexDir, 'session_index.jsonl'), '{"id":"session-1"}\n', 'utf8')
  writeFileSync(join(sourceCodexDir, 'history.jsonl'), '{"type":"history"}\n', 'utf8')
  writeFileSync(join(customSkillDir, 'SKILL.md'), '# custom skill\n', 'utf8')
  writeFileSync(join(sessionsDir, 'session-1.jsonl'), '{"type":"message"}\n', 'utf8')
  writeFileSync(join(sourceCodexDir, 'config.toml'), 'model = "source-model"\n', 'utf8')
  writeFileSync(join(sourceCodexDir, 'auth.json'), '{\n  "OPENAI_API_KEY": "source-key"\n}\n', 'utf8')
  writeFileSync(join(sourceCodexDir, '.codex-global-state.json'), '{"global":true}\n', 'utf8')
  writeFileSync(join(sourceCodexDir, 'installation_id'), 'install-1\n', 'utf8')
  writeFileSync(join(sourceCodexDir, 'models_cache.json'), '{"models":[]}\n', 'utf8')
  writeFileSync(join(sourceCodexDir, 'version.json'), '{"version":"1"}\n', 'utf8')
  writeFileSync(join(pluginCacheDir, '.app.json'), '{"name":"github"}\n', 'utf8')
  writeFileSync(join(tmpPluginsAgentsDir, 'marketplace.json'), '{"name":"openai-curated"}\n', 'utf8')
  writeFileSync(join(vendorImportsDir, 'skills-curated-cache.json'), '{"skills":[]}\n', 'utf8')
  writeFileSync(join(cacheDir, 'cache.json'), '{"apps":[]}\n', 'utf8')
  writeFileSync(join(sourceCodexDir, 'logs_2.sqlite'), 'do-not-copy', 'utf8')

  try {
    materializeCodexHome({
      config: normalizeCodexConfig({
        OPENAI_API_KEY: 'profile-key',
        MODEL: 'gpt-5.4',
      }),
      homeDir,
      projectPath: '/workspace/demo',
      sourceCodexHome: sourceHome,
    })

    const runtimeCodexDir = join(homeDir, '.codex')
    const authText = readFileSync(join(runtimeCodexDir, 'auth.json'), 'utf8')
    const configToml = readFileSync(join(runtimeCodexDir, 'config.toml'), 'utf8')

    assert.match(authText, /"OPENAI_API_KEY": "profile-key"/)
    assert.match(configToml, /model = "gpt-5\.4"/)
    assert.equal(readFileSync(join(runtimeCodexDir, 'session_index.jsonl'), 'utf8'), '{"id":"session-1"}\n')
    assert.equal(readFileSync(join(runtimeCodexDir, 'history.jsonl'), 'utf8'), '{"type":"history"}\n')
    assert.equal(readFileSync(join(runtimeCodexDir, 'skills', 'my-custom-skill', 'SKILL.md'), 'utf8'), '# custom skill\n')
    assert.equal(
      readFileSync(join(runtimeCodexDir, 'sessions', '2026', '04', '14', 'session-1.jsonl'), 'utf8'),
      '{"type":"message"}\n',
    )
    assert.equal(readFileSync(join(runtimeCodexDir, '.codex-global-state.json'), 'utf8'), '{"global":true}\n')
    assert.equal(readFileSync(join(runtimeCodexDir, 'plugins', 'cache', 'openai-curated', 'github', 'hash', '.app.json'), 'utf8'), '{"name":"github"}\n')
    assert.equal(readFileSync(join(runtimeCodexDir, '.tmp', 'plugins', '.agents', 'plugins', 'marketplace.json'), 'utf8'), '{"name":"openai-curated"}\n')
    assert.equal(readFileSync(join(runtimeCodexDir, 'vendor_imports', 'skills-curated-cache.json'), 'utf8'), '{"skills":[]}\n')
    assert.equal(readFileSync(join(runtimeCodexDir, 'cache', 'codex_apps_tools', 'cache.json'), 'utf8'), '{"apps":[]}\n')
    assert.equal(existsSync(join(runtimeCodexDir, 'logs_2.sqlite')), false)
  } finally {
    await rm(homeDir, { recursive: true, force: true })
    await rm(sourceHome, { recursive: true, force: true })
  }
})

test('materializeCodexHome merges missing mcp and plugin sections from source codex config', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'nexus-codex-home-'))
  const sourceHome = mkdtempSync(join(tmpdir(), 'nexus-codex-source-'))
  const sourceCodexDir = join(sourceHome, '.codex')

  mkdirSync(sourceCodexDir, { recursive: true })
  writeFileSync(
    join(sourceCodexDir, 'config.toml'),
    [
      'model = "source-model"',
      '',
      '[mcp_servers.chrome-devtools]',
      'command = "npx"',
      'args = ["-y", "chrome-devtools-mcp@latest"]',
      '',
      '[plugins."github@openai-curated"]',
      'enabled = true',
      '',
      '[notice.model_migrations]',
      '"gpt-5.3-codex" = "gpt-5.4"',
    ].join('\n'),
    'utf8',
  )

  try {
    materializeCodexHome({
      config: normalizeCodexConfig({
        MODEL: 'gpt-5.4',
        CONFIG_TOML: 'model = "gpt-5.4"\n',
      }),
      homeDir,
      projectPath: '/workspace/demo',
      sourceCodexHome: sourceHome,
    })

    const configToml = readFileSync(join(homeDir, '.codex', 'config.toml'), 'utf8')
    assert.match(configToml, /^model = "gpt-5\.4"/m)
    assert.match(configToml, /\[mcp_servers\.chrome-devtools\]/)
    assert.match(configToml, /chrome-devtools-mcp@latest/)
    assert.match(configToml, /\[plugins\."github@openai-curated"\]/)
    assert.match(configToml, /enabled = true/)
    assert.match(configToml, /\[notice\.model_migrations\]/)
    assert.match(configToml, /\[features\]/)
    assert.match(configToml, /apps = false/)
    assert.match(configToml, /plugins = false/)
    assert.doesNotMatch(configToml, /model = "source-model"/)
  } finally {
    await rm(homeDir, { recursive: true, force: true })
    await rm(sourceHome, { recursive: true, force: true })
  }
})

test('materializeCodexHome preserves unrelated features while disabling remote apps and plugins', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'nexus-codex-home-'))

  try {
    materializeCodexHome({
      config: normalizeCodexConfig({
        MODEL: 'gpt-5.4',
        CONFIG_TOML: [
          'model = "gpt-5.4"',
          '',
          '[features]',
          'fast_mode = true',
          'plugins = true',
        ].join('\n'),
      }),
      homeDir,
      projectPath: '/workspace/demo',
    })

    const configToml = readFileSync(join(homeDir, '.codex', 'config.toml'), 'utf8')
    assert.match(configToml, /\[features\]/)
    assert.match(configToml, /fast_mode = true/)
    assert.match(configToml, /apps = false/)
    assert.match(configToml, /plugins = false/)
    assert.doesNotMatch(configToml, /plugins = true/)
  } finally {
    await rm(homeDir, { recursive: true, force: true })
  }
})

test('buildCodexValidationConfig strips raw config extras but keeps core auth fields', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'nexus-codex-home-'))
  const authJson = JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: 'access-token' },
  }, null, 2)

  try {
    const validationConfig = buildCodexValidationConfig({
      BASE_URL: 'https://example.com/v1',
      MODEL: 'gpt-5.4',
      REASONING_EFFORT: 'high',
      CONFIG_TOML: [
        'model = "gpt-5.4"',
        '',
        '[mcp_servers.chrome-devtools]',
        'command = "npx"',
      ].join('\n'),
      AUTH_JSON: authJson,
    })

    assert.equal(validationConfig.CONFIG_TOML, '')
    assert.equal(validationConfig.BASE_URL, 'https://example.com/v1')
    assert.equal(validationConfig.MODEL, 'gpt-5.4')
    assert.equal(validationConfig.REASONING_EFFORT, 'high')
    assert.equal(validationConfig.AUTH_JSON, authJson)

    materializeCodexHome({
      config: validationConfig,
      homeDir,
      projectPath: '/workspace/demo',
      includeSharedState: false,
    })

    const configToml = readFileSync(join(homeDir, '.codex', 'config.toml'), 'utf8')
    assert.doesNotMatch(configToml, /\[mcp_servers\.chrome-devtools\]/)
    assert.match(configToml, /model_provider = "custom"/)
    assert.match(configToml, /model = "gpt-5\.4"/)
    assert.match(configToml, /base_url = "https:\/\/example\.com\/v1"/)
    assert.match(configToml, /\[projects\."\/workspace\/demo"\]/)
  } finally {
    await rm(homeDir, { recursive: true, force: true })
  }
})

test('detectCodexAuthMode recognizes chatgpt and api key auth', () => {
  assert.equal(detectCodexAuthMode({
    AUTH_JSON: JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'access-token' },
    }),
  }), 'chatgpt')

  assert.equal(detectCodexAuthMode({
    AUTH_JSON: JSON.stringify({ OPENAI_API_KEY: 'sk-test' }),
  }), 'api_key')

  assert.equal(detectCodexAuthMode({
    OPENAI_API_KEY: 'sk-direct',
  }), 'api_key')
})

test('resolveCodexRuntimeDir sanitizes tmux window ids', () => {
  const runtimeDir = resolveCodexRuntimeDir('/tmp/nexus-codex-runtime', '@12')
  assert.equal(runtimeDir, '/tmp/nexus-codex-runtime/-12')
})
