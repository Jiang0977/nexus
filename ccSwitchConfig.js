import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'

import {
  importCodexConfigFromGlobal,
  parseSimpleToml,
  sanitizeCodexConfigId,
} from './codexConfig.js'
import { importClaudeConfigFromSettings } from './systemConfig.js'

export const CC_SWITCH_SYNC_SOURCE = 'cc-switch'

function resolveUserHome(userHome = '') {
  return userHome || process.env.HOME || homedir()
}

function resolveCcSwitchDbPath({ dbPath = '', userHome = '' } = {}) {
  return dbPath || join(resolveUserHome(userHome), '.cc-switch', 'cc-switch.db')
}

function parseJsonObject(rawValue, fallback = {}) {
  try {
    const parsed = JSON.parse(String(rawValue || '{}'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {}
  return fallback
}

function withCcSwitchDb(options, callback) {
  const dbPath = resolveCcSwitchDbPath(options)
  if (!existsSync(dbPath)) return null
  const db = new DatabaseSync(dbPath)
  try {
    return callback(db)
  } finally {
    db.close()
  }
}

function getProviderRows(db, kind) {
  return db.prepare(`
    SELECT id, app_type, name, settings_config, is_current, meta
    FROM providers
    WHERE app_type = ?
    ORDER BY is_current DESC, name ASC, id ASC
  `).all(kind)
}

function getProviderRow(db, kind, providerId) {
  return db.prepare(`
    SELECT id, app_type, name, settings_config, is_current, meta
    FROM providers
    WHERE app_type = ? AND id = ?
    LIMIT 1
  `).get(kind, providerId)
}

function summarizeClaudeProvider(provider) {
  const settings = parseJsonObject(provider.settings_config)
  const env = settings.env && typeof settings.env === 'object' ? settings.env : {}
  return {
    model: String(env.ANTHROPIC_DEFAULT_SONNET_MODEL || env.ANTHROPIC_MODEL || '').trim(),
    base_url: String(env.ANTHROPIC_BASE_URL || '').trim(),
    auth_mode: env.ANTHROPIC_AUTH_TOKEN ? 'auth_token' : (env.ANTHROPIC_API_KEY ? 'api_key' : ''),
  }
}

function summarizeCodexProvider(provider) {
  const settings = parseJsonObject(provider.settings_config)
  const auth = settings.auth && typeof settings.auth === 'object' ? settings.auth : {}
  const parsedToml = parseSimpleToml(settings.config || '')
  const providerName = String(parsedToml.root.model_provider || '').trim()
  const providerSection = providerName ? parsedToml.sections[`model_providers.${providerName}`] || {} : {}
  return {
    model: String(parsedToml.root.model || '').trim(),
    base_url: String(providerSection.base_url || '').trim(),
    auth_mode: String(auth.auth_mode || '').trim() || (auth.OPENAI_API_KEY ? 'api_key' : ''),
  }
}

function buildSyncMetadata(provider) {
  return {
    SYNC_SOURCE: CC_SWITCH_SYNC_SOURCE,
    SYNC_SOURCE_ID: String(provider.id || '').trim(),
    SYNC_SOURCE_NAME: String(provider.name || '').trim(),
  }
}

function matchExistingImportedProfile(existingProfiles, providerId) {
  return existingProfiles.find(profile =>
    String(profile?.SYNC_SOURCE || '') === CC_SWITCH_SYNC_SOURCE
    && String(profile?.SYNC_SOURCE_ID || '') === String(providerId || ''),
  ) || null
}

export function resolveCcSwitchTargetProfileId(existingProfiles = [], provider = {}) {
  const matched = matchExistingImportedProfile(existingProfiles, provider.id)
  if (matched?.id) return matched.id

  const baseId = sanitizeCodexConfigId(`cc-switch-${provider.name || provider.id || 'provider'}`) || 'cc-switch-provider'
  let nextId = baseId
  let counter = 1
  const existingIds = new Set(existingProfiles.map(profile => String(profile?.id || '')).filter(Boolean))
  while (existingIds.has(nextId)) {
    nextId = `${baseId}-${counter++}`
  }
  return nextId
}

/**
 * @param {{
 *   kind?: string,
 *   existingProfiles?: any[],
 *   dbPath?: string,
 *   userHome?: string,
 * }} options
 */
export function listCcSwitchProviders({ kind, existingProfiles = [], dbPath = '', userHome = '' } = {}) {
  if (kind !== 'claude' && kind !== 'codex') return []
  return withCcSwitchDb({ dbPath, userHome }, (db) => {
    return getProviderRows(db, kind).map((provider) => {
      const summary = kind === 'claude' ? summarizeClaudeProvider(provider) : summarizeCodexProvider(provider)
      const existingProfile = matchExistingImportedProfile(existingProfiles, provider.id)
      const targetProfileId = resolveCcSwitchTargetProfileId(existingProfiles, provider)
      return {
        provider_id: provider.id,
        kind,
        name: String(provider.name || provider.id || '').trim() || provider.id,
        is_current: Boolean(provider.is_current),
        model: summary.model,
        base_url: summary.base_url,
        auth_mode: summary.auth_mode,
        existing_profile_id: existingProfile?.id || null,
        target_profile_id: targetProfileId,
      }
    })
  }) || []
}

/**
 * @param {{
 *   kind?: string,
 *   providerId?: string,
 *   dbPath?: string,
 *   userHome?: string,
 * }} options
 */
export function importCcSwitchProvider({ kind, providerId, dbPath = '', userHome = '' } = {}) {
  if (kind !== 'claude' && kind !== 'codex') return null
  return withCcSwitchDb({ dbPath, userHome }, (db) => {
    const provider = getProviderRow(db, kind, providerId)
    if (!provider) return null

    if (kind === 'claude') {
      const config = importClaudeConfigFromSettings(provider.settings_config)
      return {
        ...config,
        label: String(provider.name || config.label || provider.id).trim() || provider.id,
        ...buildSyncMetadata(provider),
      }
    }

    const settings = parseJsonObject(provider.settings_config)
    const config = importCodexConfigFromGlobal(
      String(settings.config || ''),
      JSON.stringify(settings.auth || {}, null, 2),
    )
    return {
      ...config,
      label: String(provider.name || config.label || provider.id).trim() || provider.id,
      ...buildSyncMetadata(provider),
    }
  })
}
