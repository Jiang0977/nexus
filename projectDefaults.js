import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, normalize } from 'path'

import { normalizeShellType, usesShellProfile } from './frontend/src/shellType.js'

export function normalizeProjectPathKey(projectPath) {
  const normalized = normalize(String(projectPath || '').trim())
  if (!normalized || normalized === '.') return ''
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
}

export function readProjectDefaults(filePath) {
  try {
    if (!existsSync(filePath)) return {}
    const raw = JSON.parse(readFileSync(filePath, 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

export function getProjectDefault(filePath, projectPath) {
  const key = normalizeProjectPathKey(projectPath)
  if (!key) return null
  const defaults = readProjectDefaults(filePath)
  const value = defaults[key]
  if (!value || typeof value !== 'object') return null
  return {
    path: key,
    shell_type: normalizeShellType(value.shell_type),
    profile: value.profile || null,
  }
}

export function saveProjectDefault(filePath, { path, shellType, profile }) {
  const key = normalizeProjectPathKey(path)
  if (!key) return null

  const defaults = readProjectDefaults(filePath)
  const normalizedShellType = normalizeShellType(shellType)
  defaults[key] = {
    shell_type: normalizedShellType,
    profile: usesShellProfile(normalizedShellType) && profile ? String(profile) : null,
    updated_at: new Date().toISOString(),
  }

  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify(defaults, null, 2)}\n`, 'utf8')
  return {
    path: key,
    shell_type: defaults[key].shell_type,
    profile: defaults[key].profile,
  }
}
