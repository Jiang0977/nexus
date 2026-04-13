import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

import {
  importCcSwitchProvider,
  listCcSwitchProviders,
  resolveCcSwitchTargetProfileId,
} from '../ccSwitchConfig.js'

function createTestDb(filePath) {
  const db = new DatabaseSync(filePath)
  db.exec(`
    CREATE TABLE providers (
      id TEXT NOT NULL,
      app_type TEXT NOT NULL,
      name TEXT NOT NULL,
      settings_config TEXT NOT NULL,
      meta TEXT NOT NULL DEFAULT '{}',
      is_current BOOLEAN NOT NULL DEFAULT 0,
      PRIMARY KEY (id, app_type)
    );
  `)
  return db
}

test('listCcSwitchProviders returns codex providers with stable target ids', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'nexus-cc-switch-'))
  const dbPath = join(rootDir, 'cc-switch.db')
  const db = createTestDb(dbPath)

  try {
    db.prepare(`
      INSERT INTO providers (id, app_type, name, settings_config, is_current)
      VALUES (?, 'codex', ?, ?, ?)
    `).run(
      'provider-xmapi',
      'xmapi',
      JSON.stringify({
        auth: { OPENAI_API_KEY: 'sk-test' },
        config: 'model_provider = "custom"\nmodel = "gpt-5.4"\n\n[model_providers.custom]\nbase_url = "https://example.com/v1"',
      }),
      1,
    )

    const providers = listCcSwitchProviders({
      kind: 'codex',
      dbPath,
      existingProfiles: [],
    })

    assert.deepEqual(providers, [{
      provider_id: 'provider-xmapi',
      kind: 'codex',
      name: 'xmapi',
      is_current: true,
      model: 'gpt-5.4',
      base_url: 'https://example.com/v1',
      auth_mode: 'api_key',
      existing_profile_id: null,
      target_profile_id: 'cc-switch-xmapi',
    }])
  } finally {
    db.close()
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('resolveCcSwitchTargetProfileId reuses already imported profile ids', () => {
  assert.equal(
    resolveCcSwitchTargetProfileId([{
      id: 'cc-switch-xmapi',
      SYNC_SOURCE: 'cc-switch',
      SYNC_SOURCE_ID: 'provider-xmapi',
    }], {
      id: 'provider-xmapi',
      name: 'xmapi',
    }),
    'cc-switch-xmapi',
  )
})

test('importCcSwitchProvider converts Claude and Codex providers into Nexus configs', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'nexus-cc-switch-'))
  const dbPath = join(rootDir, 'cc-switch.db')
  mkdirSync(rootDir, { recursive: true })
  const db = createTestDb(dbPath)

  try {
    db.prepare(`
      INSERT INTO providers (id, app_type, name, settings_config, is_current)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      'claude-provider',
      'claude',
      'anthropic',
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: 'https://claude.example.com',
          ANTHROPIC_AUTH_TOKEN: 'token-123',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet',
        },
      }),
      1,
    )
    db.prepare(`
      INSERT INTO providers (id, app_type, name, settings_config, is_current)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      'codex-provider',
      'codex',
      'xmapi',
      JSON.stringify({
        auth: { auth_mode: 'chatgpt', tokens: { access_token: 'access-token' } },
        config: 'model_provider = "custom"\nmodel = "gpt-5.4"\n\n[model_providers.custom]\nbase_url = "https://example.com/v1"',
      }),
      0,
    )

    const claudeConfig = importCcSwitchProvider({ kind: 'claude', providerId: 'claude-provider', dbPath })
    const codexConfig = importCcSwitchProvider({ kind: 'codex', providerId: 'codex-provider', dbPath })

    assert.deepEqual(claudeConfig, {
      label: 'anthropic',
      BASE_URL: 'https://claude.example.com',
      AUTH_TOKEN: 'token-123',
      API_KEY: '',
      DEFAULT_MODEL: 'claude-sonnet',
      THINK_MODEL: '',
      LONG_CONTEXT_MODEL: '',
      DEFAULT_HAIKU_MODEL: '',
      API_TIMEOUT_MS: '3000000',
      SYNC_SOURCE: 'cc-switch',
      SYNC_SOURCE_ID: 'claude-provider',
      SYNC_SOURCE_NAME: 'anthropic',
    })
    assert.equal(codexConfig?.label, 'xmapi')
    assert.equal(codexConfig?.MODEL, 'gpt-5.4')
    assert.equal(codexConfig?.BASE_URL, 'https://example.com/v1')
    assert.match(String(codexConfig?.AUTH_JSON || ''), /"auth_mode": "chatgpt"/)
    assert.equal(codexConfig?.SYNC_SOURCE_ID, 'codex-provider')
    assert.equal(codexConfig?.SYNC_SOURCE_NAME, 'xmapi')
  } finally {
    db.close()
    await rm(rootDir, { recursive: true, force: true })
  }
})
