import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  readGlobalClaudeConfig,
  readGlobalCodexConfig,
} from '../systemConfig.js'

test('readGlobalClaudeConfig imports the current live Claude settings', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'nexus-system-claude-'))
  const claudeDir = join(homeDir, '.claude')
  mkdirSync(claudeDir, { recursive: true })

  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: 'https://claude.example.com',
      ANTHROPIC_AUTH_TOKEN: 'token-123',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku',
    },
  }, null, 2))

  try {
    assert.deepEqual(readGlobalClaudeConfig({ userHome: homeDir }), {
      label: 'Imported from ~/.claude/settings.json',
      BASE_URL: 'https://claude.example.com',
      AUTH_TOKEN: 'token-123',
      API_KEY: '',
      DEFAULT_MODEL: 'claude-sonnet',
      THINK_MODEL: 'claude-opus',
      LONG_CONTEXT_MODEL: '',
      DEFAULT_HAIKU_MODEL: 'claude-haiku',
      API_TIMEOUT_MS: '3000000',
    })
  } finally {
    await rm(homeDir, { recursive: true, force: true })
  }
})

test('readGlobalCodexConfig imports the current live Codex config and auth', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'nexus-system-codex-'))
  const codexDir = join(homeDir, '.codex')
  mkdirSync(codexDir, { recursive: true })

  const configToml = [
    'model_provider = "custom"',
    'model = "gpt-5.4"',
    '',
    '[model_providers.custom]',
    'base_url = "https://example.com/v1"',
  ].join('\n')
  const authJson = JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: 'access-token' },
  }, null, 2)

  writeFileSync(join(codexDir, 'config.toml'), configToml)
  writeFileSync(join(codexDir, 'auth.json'), authJson)

  try {
    assert.deepEqual(readGlobalCodexConfig({ userHome: homeDir }), {
      label: 'Imported (gpt-5.4)',
      OPENAI_API_KEY: '',
      BASE_URL: 'https://example.com/v1',
      MODEL: 'gpt-5.4',
      REASONING_EFFORT: '',
      CONFIG_TOML: configToml,
      AUTH_JSON: authJson,
      SYNC_SOURCE: '',
      SYNC_SOURCE_ID: '',
      SYNC_SOURCE_NAME: '',
    })
  } finally {
    await rm(homeDir, { recursive: true, force: true })
  }
})
