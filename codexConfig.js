import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'

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

const SHARED_CODEX_STATE_PATHS = Object.freeze([
  '.codex-global-state.json',
  '.tmp',
  'cache',
  'history.jsonl',
  'installation_id',
  'models_cache.json',
  'plugins',
  'session_index.jsonl',
  'sessions',
  'shell_snapshots',
  'skills',
  'vendor_imports',
  'version.json',
])

const SHARED_CODEX_CONFIG_SECTION_PREFIXES = Object.freeze([
  'mcp_servers.',
  'plugins.',
])

const SHARED_CODEX_CONFIG_SECTION_NAMES = new Set([
  'notice.model_migrations',
])

const RUNTIME_DISABLED_CODEX_FEATURES = Object.freeze([
  'apps',
  'plugins',
])

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

export function detectCodexAuthMode(config = {}) {
  const normalized = normalizeCodexConfig(config)
  const authPayload = parseJsonObject(normalized.AUTH_JSON)
  const authMode = String(authPayload?.auth_mode || '').trim()
  if (authMode) return authMode
  if (normalized.OPENAI_API_KEY) return 'api_key'
  return ''
}

export function buildCodexValidationConfig(config = {}) {
  const normalized = normalizeCodexConfig(config)
  return {
    ...normalized,
    CONFIG_TOML: '',
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

function parseTomlSectionBlocks(text) {
  const sections = new Map()
  let currentSection = ''
  let currentLines = []

  const flushSection = () => {
    if (!currentSection || currentLines.length === 0) return
    sections.set(currentSection, currentLines.join('\n').trim())
  }

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const sectionMatch = rawLine.trim().match(/^\[(.+)\]$/)
    if (sectionMatch) {
      flushSection()
      currentSection = sectionMatch[1].trim()
      currentLines = [rawLine]
      continue
    }
    if (currentSection) {
      currentLines.push(rawLine)
    }
  }

  flushSection()
  return sections
}

function shouldMergeSharedCodexConfigSection(sectionName = '') {
  return SHARED_CODEX_CONFIG_SECTION_NAMES.has(sectionName)
    || SHARED_CODEX_CONFIG_SECTION_PREFIXES.some(prefix => sectionName.startsWith(prefix))
}

function mergeSharedCodexConfigSections(configTomlText, sourceConfigTomlText = '') {
  const baseText = String(configTomlText || '').trim()
  const sourceText = String(sourceConfigTomlText || '').trim()
  if (!sourceText) return ensureTrailingNewline(baseText)

  const mergedSections = parseTomlSectionBlocks(baseText)
  let mergedText = baseText

  for (const [sectionName, blockText] of parseTomlSectionBlocks(sourceText)) {
    if (!shouldMergeSharedCodexConfigSection(sectionName)) continue
    if (mergedSections.has(sectionName)) continue
    mergedText = mergedText ? `${mergedText}\n\n${blockText}` : blockText
    mergedSections.set(sectionName, blockText)
  }

  return ensureTrailingNewline(mergedText)
}

function disableRuntimeCodexFeatures(configTomlText) {
  const sourceLines = String(configTomlText || '').split(/\r?\n/)
  const outputLines = []
  const pendingFeatures = new Set(RUNTIME_DISABLED_CODEX_FEATURES)
  let insideFeatures = false
  let sawFeaturesSection = false

  const appendMissingFeatureOverrides = () => {
    if (!insideFeatures) return
    for (const featureName of RUNTIME_DISABLED_CODEX_FEATURES) {
      if (pendingFeatures.has(featureName)) {
        outputLines.push(`${featureName} = false`)
        pendingFeatures.delete(featureName)
      }
    }
  }

  for (const rawLine of sourceLines) {
    const trimmedLine = rawLine.trim()
    const sectionMatch = trimmedLine.match(/^\[(.+)\]$/)
    if (sectionMatch) {
      appendMissingFeatureOverrides()
      insideFeatures = sectionMatch[1].trim() === 'features'
      if (insideFeatures) sawFeaturesSection = true
      outputLines.push(rawLine)
      continue
    }

    if (insideFeatures) {
      const kvMatch = trimmedLine.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/)
      if (kvMatch && pendingFeatures.has(kvMatch[1])) {
        outputLines.push(`${kvMatch[1]} = false`)
        pendingFeatures.delete(kvMatch[1])
        continue
      }
    }

    outputLines.push(rawLine)
  }

  appendMissingFeatureOverrides()

  if (!sawFeaturesSection) {
    const trimmedOutput = outputLines.join('\n').trim()
    const featureSection = [
      '[features]',
      ...RUNTIME_DISABLED_CODEX_FEATURES.map((featureName) => `${featureName} = false`),
    ].join('\n')
    return ensureTrailingNewline(trimmedOutput ? `${trimmedOutput}\n\n${featureSection}` : featureSection)
  }

  return ensureTrailingNewline(outputLines.join('\n').trim())
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

function resolveSourceCodexDir(sourceCodexHome = '') {
  const sourceHome = String(sourceCodexHome || process.env.HOME || homedir() || '').trim()
  if (!sourceHome) return ''
  return join(sourceHome, '.codex')
}

function readSourceCodexConfigToml(sourceCodexHome = '') {
  const sourceCodexDir = resolveSourceCodexDir(sourceCodexHome)
  if (!sourceCodexDir) return ''
  const configFile = join(sourceCodexDir, 'config.toml')
  if (!existsSync(configFile)) return ''
  try {
    return readFileSync(configFile, 'utf8')
  } catch {
    return ''
  }
}

function linkSharedCodexState(codexDir, sourceCodexHome = '') {
  const sourceCodexDir = resolveSourceCodexDir(sourceCodexHome)
  if (!sourceCodexDir || !existsSync(sourceCodexDir)) return
  if (resolve(sourceCodexDir) === resolve(codexDir)) return

  for (const relativePath of SHARED_CODEX_STATE_PATHS) {
    const sourcePath = join(sourceCodexDir, relativePath)
    if (!existsSync(sourcePath)) continue
    const targetPath = join(codexDir, relativePath)
    mkdirSync(dirname(targetPath), { recursive: true })
    symlinkSync(sourcePath, targetPath, statSync(sourcePath).isDirectory() ? 'dir' : 'file')
  }
}

export function materializeCodexHome({
  config = {},
  homeDir,
  projectPath,
  sourceCodexHome = '',
  includeSharedState = true,
}) {
  const normalized = normalizeCodexConfig(config)
  const codexDir = join(homeDir, '.codex')
  mkdirSync(homeDir, { recursive: true })
  rmSync(codexDir, { recursive: true, force: true })
  mkdirSync(codexDir, { recursive: true })
  if (includeSharedState) {
    linkSharedCodexState(codexDir, sourceCodexHome)
  }

  const sourceConfigToml = includeSharedState ? readSourceCodexConfigToml(sourceCodexHome) : ''
  const materializedConfigToml = disableRuntimeCodexFeatures(
    mergeSharedCodexConfigSections(
      buildCodexConfigToml(normalized, projectPath),
      sourceConfigToml,
    ),
  )
  writeFileSync(join(codexDir, 'config.toml'), materializedConfigToml, 'utf8')

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
