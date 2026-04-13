import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

export const EMPTY_CODEX_CONFIG = Object.freeze({
  label: '',
  OPENAI_API_KEY: '',
  BASE_URL: '',
  MODEL: '',
  REASONING_EFFORT: '',
  CONFIG_TOML: '',
  AUTH_JSON: '',
  SYNC_SOURCE: '',
  SYNC_SOURCE_ID: '',
  SYNC_SOURCE_NAME: '',
})

export function sanitizeCodexConfigId(id) {
  return String(id || '').replace(/[^a-z0-9_-]/gi, '-').toLowerCase()
}

export function normalizeCodexConfig(config = {}) {
  const authJson = normalizeJsonText(config.AUTH_JSON)
  const authPayload = parseJsonObject(authJson)
  return {
    label: String(config.label || '').trim(),
    OPENAI_API_KEY: String(
      config.OPENAI_API_KEY
      || (typeof authPayload?.OPENAI_API_KEY === 'string' ? authPayload.OPENAI_API_KEY : '')
      || '',
    ).trim(),
    BASE_URL: String(config.BASE_URL || '').trim(),
    MODEL: String(config.MODEL || '').trim(),
    REASONING_EFFORT: String(config.REASONING_EFFORT || '').trim(),
    CONFIG_TOML: String(config.CONFIG_TOML || '').trim(),
    AUTH_JSON: authJson,
    SYNC_SOURCE: String(config.SYNC_SOURCE || '').trim(),
    SYNC_SOURCE_ID: String(config.SYNC_SOURCE_ID || '').trim(),
    SYNC_SOURCE_NAME: String(config.SYNC_SOURCE_NAME || '').trim(),
  }
}

function parseJsonObject(rawValue) {
  if (!rawValue) return null
  if (typeof rawValue === 'string') {
    try {
      const parsed = JSON.parse(rawValue)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  if (typeof rawValue === 'object' && !Array.isArray(rawValue)) {
    return rawValue
  }
  return null
}

function normalizeJsonText(rawValue) {
  const parsed = parseJsonObject(rawValue)
  return parsed ? JSON.stringify(parsed, null, 2) : ''
}

function tomlString(value) {
  return JSON.stringify(String(value))
}

function parseTomlScalar(rawValue) {
  const value = rawValue.trim()
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value)
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^[+-]?\d+$/.test(value)) return Number.parseInt(value, 10)
  if (/^[+-]?\d+\.\d+$/.test(value)) return Number.parseFloat(value)
  return value
}

export function parseSimpleToml(text) {
  const root = {}
  const sections = {}
  let currentSection = null

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const sectionMatch = line.match(/^\[(.+)\]$/)
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim()
      if (!sections[currentSection]) sections[currentSection] = {}
      continue
    }

    const kvMatch = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/)
    if (!kvMatch) continue

    const [, key, rawValue] = kvMatch
    const target = currentSection ? sections[currentSection] : root
    target[key] = parseTomlScalar(rawValue)
  }

  return { root, sections }
}

export function importCodexConfigFromGlobal(configTomlText, authJsonText) {
  const normalizedConfigToml = String(configTomlText || '').trim()
  const normalizedAuthJson = normalizeJsonText(authJsonText)
  const parsed = parseSimpleToml(normalizedConfigToml)
  const providerName = String(parsed.root.model_provider || '').trim()
  const providerSection = providerName ? parsed.sections[`model_providers.${providerName}`] || {} : {}

  const auth = parseJsonObject(normalizedAuthJson) || {}

  const config = normalizeCodexConfig({
    label: parsed.root.model ? `Imported (${parsed.root.model})` : 'Imported from ~/.codex',
    OPENAI_API_KEY: auth.OPENAI_API_KEY || '',
    BASE_URL: providerSection.base_url || '',
    MODEL: parsed.root.model || '',
    REASONING_EFFORT: parsed.root.model_reasoning_effort || '',
    CONFIG_TOML: normalizedConfigToml,
    AUTH_JSON: normalizedAuthJson,
  })

  if (!config.label) config.label = 'Imported from ~/.codex'
  return config
}

function ensureTrailingNewline(text) {
  if (!text) return ''
  return text.endsWith('\n') ? text : `${text}\n`
}

function appendTrustedProjectSection(configTomlText, projectPath = '') {
  const trimmed = String(configTomlText || '').trim()
  if (!projectPath) return ensureTrailingNewline(trimmed)

  const sectionHeader = `[projects.${tomlString(projectPath)}]`
  if (trimmed.includes(sectionHeader)) {
    return ensureTrailingNewline(trimmed)
  }

  const projectSection = `${sectionHeader}\ntrust_level = "trusted"`
  return ensureTrailingNewline(trimmed ? `${trimmed}\n\n${projectSection}` : projectSection)
}

export function buildCodexConfigToml(config = {}, projectPath = '') {
  const normalized = normalizeCodexConfig(config)
  if (normalized.CONFIG_TOML) {
    return appendTrustedProjectSection(normalized.CONFIG_TOML, projectPath)
  }
  const lines = []

  if (normalized.BASE_URL) {
    lines.push('model_provider = "custom"')
  }
  if (normalized.MODEL) {
    lines.push(`model = ${tomlString(normalized.MODEL)}`)
  }
  if (normalized.REASONING_EFFORT) {
    lines.push(`model_reasoning_effort = ${tomlString(normalized.REASONING_EFFORT)}`)
  }

  if (normalized.BASE_URL) {
    if (lines.length > 0) lines.push('')
    lines.push('[model_providers]')
    lines.push('')
    lines.push('[model_providers.custom]')
    lines.push('name = "custom"')
    lines.push('wire_api = "responses"')
    lines.push('requires_openai_auth = true')
    lines.push(`base_url = ${tomlString(normalized.BASE_URL)}`)
  }

  if (projectPath) {
    if (lines.length > 0) lines.push('')
    lines.push(`[projects.${tomlString(projectPath)}]`)
    lines.push('trust_level = "trusted"')
  }

  return ensureTrailingNewline(lines.join('\n'))
}

export function resolveCodexRuntimeDir(runtimeRootDir, windowId) {
  const safeWindowId = String(windowId || 'window-unknown').replace(/[^a-zA-Z0-9._-]+/g, '-')
  return join(runtimeRootDir, safeWindowId)
}

export function materializeCodexHome({ config = {}, homeDir, projectPath }) {
  const normalized = normalizeCodexConfig(config)
  const codexDir = join(homeDir, '.codex')
  mkdirSync(homeDir, { recursive: true })
  rmSync(codexDir, { recursive: true, force: true })
  mkdirSync(codexDir, { recursive: true })

  writeFileSync(join(codexDir, 'config.toml'), buildCodexConfigToml(normalized, projectPath), 'utf8')

  const authFile = join(codexDir, 'auth.json')
  if (normalized.AUTH_JSON) {
    writeFileSync(authFile, ensureTrailingNewline(normalized.AUTH_JSON), 'utf8')
  } else if (normalized.OPENAI_API_KEY) {
    writeFileSync(authFile, `${JSON.stringify({ OPENAI_API_KEY: normalized.OPENAI_API_KEY }, null, 2)}\n`, 'utf8')
  } else {
    rmSync(authFile, { force: true })
  }
}

export function listCodexConfigs(configDir) {
  try {
    const files = readdirSync(configDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => ({
        name: entry.name,
        mtime: statSync(join(configDir, entry.name)).mtimeMs,
      }))
      .sort((left, right) => right.mtime - left.mtime)
      .map((entry) => entry.name)

    return files.map((fileName) => {
      const id = fileName.replace(/\.json$/, '')
      try {
        const raw = JSON.parse(readFileSync(join(configDir, fileName), 'utf8'))
        return { id, ...normalizeCodexConfig(raw), label: raw.label || id }
      } catch {
        return { id, ...EMPTY_CODEX_CONFIG, label: id }
      }
    })
  } catch {
    return []
  }
}

export function saveCodexConfig(configDir, id, config = {}) {
  const sanitizedId = sanitizeCodexConfigId(id)
  if (!sanitizedId) {
    throw new Error('invalid id')
  }
  mkdirSync(configDir, { recursive: true })
  writeFileSync(
    join(configDir, `${sanitizedId}.json`),
    `${JSON.stringify(normalizeCodexConfig(config), null, 2)}\n`,
    'utf8',
  )
  return sanitizedId
}

export function deleteCodexConfig(configDir, id) {
  const sanitizedId = sanitizeCodexConfigId(id)
  if (!sanitizedId) return
  const filePath = join(configDir, `${sanitizedId}.json`)
  if (existsSync(filePath)) unlinkSync(filePath)
}

export function readCodexConfig(configDir, id) {
  const sanitizedId = sanitizeCodexConfigId(id)
  if (!sanitizedId) return null
  const filePath = join(configDir, `${sanitizedId}.json`)
  if (!existsSync(filePath)) return null
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'))
    return { id: sanitizedId, ...normalizeCodexConfig(raw), label: raw.label || sanitizedId }
  } catch {
    return { id: sanitizedId, ...EMPTY_CODEX_CONFIG, label: sanitizedId }
  }
}
