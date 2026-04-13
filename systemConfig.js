import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import { importCodexConfigFromGlobal } from './codexConfig.js'

const EMPTY_CLAUDE_CONFIG = Object.freeze({
  label: 'Imported from ~/.claude/settings.json',
  BASE_URL: '',
  AUTH_TOKEN: '',
  API_KEY: '',
  DEFAULT_MODEL: '',
  THINK_MODEL: '',
  LONG_CONTEXT_MODEL: '',
  DEFAULT_HAIKU_MODEL: '',
  API_TIMEOUT_MS: '3000000',
})

function resolveUserHome(userHome = '') {
  return userHome || process.env.HOME || homedir()
}

export function importClaudeConfigFromSettings(settingsJsonText) {
  let settings = {}
  try {
    settings = JSON.parse(settingsJsonText || '{}')
  } catch {
    settings = {}
  }

  const env = settings?.env && typeof settings.env === 'object' ? settings.env : {}
  return {
    ...EMPTY_CLAUDE_CONFIG,
    BASE_URL: String(env.ANTHROPIC_BASE_URL || '').trim(),
    AUTH_TOKEN: String(env.ANTHROPIC_AUTH_TOKEN || '').trim(),
    API_KEY: String(env.ANTHROPIC_API_KEY || '').trim(),
    DEFAULT_MODEL: String(env.ANTHROPIC_DEFAULT_SONNET_MODEL || env.ANTHROPIC_MODEL || '').trim(),
    THINK_MODEL: String(env.ANTHROPIC_DEFAULT_OPUS_MODEL || env.ANTHROPIC_THINK_MODEL || '').trim(),
    LONG_CONTEXT_MODEL: String(env.ANTHROPIC_LONG_CONTEXT_MODEL || '').trim(),
    DEFAULT_HAIKU_MODEL: String(env.ANTHROPIC_DEFAULT_HAIKU_MODEL || '').trim(),
    API_TIMEOUT_MS: String(env.API_TIMEOUT_MS || EMPTY_CLAUDE_CONFIG.API_TIMEOUT_MS).trim() || EMPTY_CLAUDE_CONFIG.API_TIMEOUT_MS,
  }
}

export function readGlobalClaudeConfig({ userHome = '' } = {}) {
  const settingsFile = join(resolveUserHome(userHome), '.claude', 'settings.json')
  if (!existsSync(settingsFile)) return null
  return importClaudeConfigFromSettings(readFileSync(settingsFile, 'utf8'))
}

export function readGlobalCodexConfig({ userHome = '' } = {}) {
  const codexDir = join(resolveUserHome(userHome), '.codex')
  const configFile = join(codexDir, 'config.toml')
  const authFile = join(codexDir, 'auth.json')

  if (!existsSync(configFile) && !existsSync(authFile)) return null

  return importCodexConfigFromGlobal(
    existsSync(configFile) ? readFileSync(configFile, 'utf8') : '',
    existsSync(authFile) ? readFileSync(authFile, 'utf8') : '',
  )
}
