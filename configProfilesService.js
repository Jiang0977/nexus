import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import {
  buildCodexValidationConfig,
  deleteCodexConfig,
  detectCodexAuthMode,
  listCodexConfigs,
  materializeCodexHome,
  readCodexConfig,
  sanitizeCodexConfigId,
  saveCodexConfig,
} from './codexConfig.js'
import {
  importCcSwitchProvider,
  listCcSwitchProviders,
  resolveCcSwitchTargetProfileId,
} from './ccSwitchConfig.js'
import { sanitizeInteractiveEnv } from './interactiveEnv.js'
import { getProjectDefault } from './projectDefaults.js'
import { collectProxyVars } from './shellLaunch.js'
import { readGlobalClaudeConfig, readGlobalCodexConfig } from './systemConfig.js'

const SYNC_METADATA_KEYS = ['SYNC_SOURCE', 'SYNC_SOURCE_ID', 'SYNC_SOURCE_NAME']
const CODEX_LOGIN_STATUS_TIMEOUT_MS = 15000
const CODEX_EXEC_VALIDATE_TIMEOUT_MS = 120000

export class ConfigProfilesError extends Error {
  constructor(statusCode, message, options = {}) {
    super(message)
    this.name = 'ConfigProfilesError'
    this.statusCode = statusCode
    this.responseBody = options.responseBody || null
  }
}

function sanitizeProfileId(id) {
  return sanitizeCodexConfigId(id)
}

function mergeSyncMetadata(currentConfig = {}, nextConfig = {}) {
  const merged = { ...nextConfig }
  for (const key of SYNC_METADATA_KEYS) {
    if (!(key in merged) && currentConfig?.[key]) {
      merged[key] = currentConfig[key]
    }
  }
  return merged
}

function listStoredClaudeConfigs(configDir, { readdirSyncImpl, readFileSyncImpl, statSyncImpl }) {
  try {
    const files = readdirSyncImpl(configDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => ({
        name: entry.name,
        mtime: statSyncImpl(join(configDir, entry.name)).mtimeMs,
      }))
      .sort((left, right) => right.mtime - left.mtime)
      .map((entry) => entry.name)

    return files.map((fileName) => {
      const id = fileName.replace(/\.json$/, '')
      try {
        const data = JSON.parse(readFileSyncImpl(join(configDir, fileName), 'utf8'))
        return { id, label: data.label || id, ...data }
      } catch {
        return { id, label: id }
      }
    })
  } catch {
    return []
  }
}

function readStoredClaudeConfig(configDir, id, { existsSyncImpl, readFileSyncImpl }) {
  const sanitizedId = sanitizeProfileId(id)
  if (!sanitizedId) return null
  const filePath = join(configDir, `${sanitizedId}.json`)
  if (!existsSyncImpl(filePath)) return null
  try {
    const data = JSON.parse(readFileSyncImpl(filePath, 'utf8'))
    return { id: sanitizedId, label: data.label || sanitizedId, ...data }
  } catch {
    return { id: sanitizedId, label: sanitizedId }
  }
}

function saveStoredClaudeConfig(configDir, id, config, deps) {
  const sanitizedId = sanitizeProfileId(id)
  if (!sanitizedId) throw new Error('invalid id')
  mkdirSync(configDir, { recursive: true })
  const currentConfig = readStoredClaudeConfig(configDir, sanitizedId, deps) || {}
  const nextConfig = mergeSyncMetadata(currentConfig, config)
  deps.writeFileSyncImpl(join(configDir, `${sanitizedId}.json`), JSON.stringify(nextConfig, null, 2), 'utf8')
  return { id: sanitizedId, config: { id: sanitizedId, ...nextConfig } }
}

function summarizeCodexValidationFailure(result) {
  const stderr = String(result.stderr || '').trim()
  const stdout = String(result.stdout || '').trim()
  if (result.error?.message) return result.error.message
  if (stderr) return stderr.split('\n').slice(-8).join('\n')
  if (stdout) return stdout.split('\n').slice(-8).join('\n')
  return `codex exited with status ${result.status ?? 'unknown'}`
}

function summarizeCodexCommandSuccess(result) {
  const stdout = String(result.stdout || '').trim()
  const stderr = String(result.stderr || '').trim()
  return stdout || stderr || 'OK'
}

function codexTimeoutMessage(step, timeoutMs) {
  return `codex ${step} timed out after ${Math.round(timeoutMs / 1000)}s`
}

function resolveCodexExecutable(spawnSyncImpl) {
  try {
    const result = spawnSyncImpl('bash', ['-lc', 'which -a codex | tail -1'], { encoding: 'utf8' })
    const executable = result.status === 0 ? result.stdout.trim() : ''
    return executable || 'codex'
  } catch {
    return 'codex'
  }
}

/**
 * @typedef {{
 *   configsDir: string,
 *   codexConfigsDir: string,
 *   toolbarConfigFile: string,
 *   projectDefaultsFile: string,
 *   workspaceRoot: string,
 *   codexValidateDir: string,
 *   projectPath: string,
 *   claudeProxy?: string,
 *   env?: NodeJS.ProcessEnv,
 *   existsSyncImpl?: typeof existsSync,
 *   mkdirSyncImpl?: typeof mkdirSync,
 *   mkdtempSyncImpl?: typeof mkdtempSync,
 *   readdirSyncImpl?: typeof readdirSync,
 *   readFileSyncImpl?: typeof readFileSync,
 *   rmSyncImpl?: typeof rmSync,
 *   statSyncImpl?: typeof statSync,
 *   unlinkSyncImpl?: typeof unlinkSync,
 *   writeFileSyncImpl?: typeof writeFileSync,
 *   spawnSyncImpl?: typeof spawnSync,
 *   listCodexConfigsImpl?: typeof listCodexConfigs,
 *   readCodexConfigImpl?: typeof readCodexConfig,
 *   saveCodexConfigImpl?: typeof saveCodexConfig,
 *   deleteCodexConfigImpl?: typeof deleteCodexConfig,
 *   readGlobalClaudeConfigImpl?: typeof readGlobalClaudeConfig,
 *   readGlobalCodexConfigImpl?: typeof readGlobalCodexConfig,
 *   listCcSwitchProvidersImpl?: typeof listCcSwitchProviders,
 *   importCcSwitchProviderImpl?: typeof importCcSwitchProvider,
 *   resolveCcSwitchTargetProfileIdImpl?: typeof resolveCcSwitchTargetProfileId,
 *   getProjectDefaultImpl?: typeof getProjectDefault,
 *   buildCodexValidationConfigImpl?: typeof buildCodexValidationConfig,
 *   detectCodexAuthModeImpl?: typeof detectCodexAuthMode,
 *   materializeCodexHomeImpl?: typeof materializeCodexHome,
 *   collectProxyVarsImpl?: typeof collectProxyVars,
 *   runCodexValidationCommandImpl?: (tempHome: string, proxyVars: Record<string, string>, args: string[], timeoutMs: number) => any,
 * }} ConfigProfilesServiceOptions
 */

/** @param {ConfigProfilesServiceOptions} options */
export function createConfigProfilesService(options) {
  const {
    configsDir,
    codexConfigsDir,
    toolbarConfigFile,
    projectDefaultsFile,
    workspaceRoot,
    codexValidateDir,
    projectPath,
    claudeProxy = '',
    env = process.env,
    existsSyncImpl = existsSync,
    mkdirSyncImpl = mkdirSync,
    mkdtempSyncImpl = mkdtempSync,
    readdirSyncImpl = readdirSync,
    readFileSyncImpl = readFileSync,
    rmSyncImpl = rmSync,
    statSyncImpl = statSync,
    unlinkSyncImpl = unlinkSync,
    writeFileSyncImpl = writeFileSync,
    spawnSyncImpl = spawnSync,
    listCodexConfigsImpl = listCodexConfigs,
    readCodexConfigImpl = readCodexConfig,
    saveCodexConfigImpl = saveCodexConfig,
    deleteCodexConfigImpl = deleteCodexConfig,
    readGlobalClaudeConfigImpl = readGlobalClaudeConfig,
    readGlobalCodexConfigImpl = readGlobalCodexConfig,
    listCcSwitchProvidersImpl = listCcSwitchProviders,
    importCcSwitchProviderImpl = importCcSwitchProvider,
    resolveCcSwitchTargetProfileIdImpl = resolveCcSwitchTargetProfileId,
    getProjectDefaultImpl = getProjectDefault,
    buildCodexValidationConfigImpl = buildCodexValidationConfig,
    detectCodexAuthModeImpl = detectCodexAuthMode,
    materializeCodexHomeImpl = materializeCodexHome,
    collectProxyVarsImpl = collectProxyVars,
    runCodexValidationCommandImpl,
  } = options

  const fileDeps = {
    existsSyncImpl,
    readFileSyncImpl,
    readdirSyncImpl,
    statSyncImpl,
    writeFileSyncImpl,
  }

  const runCodexValidationCommand = runCodexValidationCommandImpl || ((tempHome, proxyVars, args, timeoutMs) => {
    return spawnSyncImpl(resolveCodexExecutable(spawnSyncImpl), args, {
      env: sanitizeInteractiveEnv(env, {
        HOME: tempHome,
        ...proxyVars,
      }),
      encoding: 'utf8',
      timeout: timeoutMs,
    })
  })

  function resolveWorkspacePath(inputPath) {
    if (!inputPath) return workspaceRoot
    return String(inputPath).startsWith('/') ? String(inputPath) : `${workspaceRoot}/${inputPath}`
  }

  function toConfigProfilesError(error, fallbackStatus = 500) {
    if (error instanceof ConfigProfilesError) return error
    const statusCode = error?.message === 'invalid id' ? 400 : fallbackStatus
    return new ConfigProfilesError(statusCode, error?.message || 'unknown error')
  }

  function saveCodexConfigWithMetadata(id, config = {}) {
    const currentConfig = readCodexConfigImpl(codexConfigsDir, id) || {}
    const mergedConfig = mergeSyncMetadata(currentConfig, config)
    const savedId = saveCodexConfigImpl(codexConfigsDir, id, mergedConfig)
    return { id: savedId, config: readCodexConfigImpl(codexConfigsDir, savedId) }
  }

  function ensureKind(kind) {
    if (kind !== 'claude' && kind !== 'codex') {
      throw new ConfigProfilesError(400, 'invalid kind')
    }
  }

  function buildValidationError(statusCode, message) {
    return new ConfigProfilesError(statusCode, message, {
      responseBody: { ok: false, error: message },
    })
  }

  function listClaudeConfigs() {
    return listStoredClaudeConfigs(configsDir, fileDeps)
  }

  function saveClaudeConfig(id, config = {}) {
    try {
      const saved = saveStoredClaudeConfig(configsDir, id, config, fileDeps)
      return { ok: true, id: saved.id }
    } catch (error) {
      throw toConfigProfilesError(error)
    }
  }

  function syncCurrentClaudeConfig(id) {
    const sanitizedId = sanitizeProfileId(id)
    if (!sanitizedId) {
      throw new ConfigProfilesError(400, 'invalid id')
    }

    const filePath = join(configsDir, `${sanitizedId}.json`)
    if (!existsSyncImpl(filePath)) {
      throw new ConfigProfilesError(404, 'config not found')
    }

    const imported = readGlobalClaudeConfigImpl()
    if (!imported) {
      throw new ConfigProfilesError(404, 'global ~/.claude/settings.json not found')
    }

    try {
      const current = readStoredClaudeConfig(configsDir, sanitizedId, fileDeps) || {}
      const saved = saveStoredClaudeConfig(configsDir, sanitizedId, {
        ...imported,
        label: String(current.label || imported.label || sanitizedId).trim() || sanitizedId,
      }, fileDeps)
      return { ok: true, id: saved.id, config: saved.config }
    } catch (error) {
      throw toConfigProfilesError(error)
    }
  }

  function deleteClaudeConfig(id) {
    const sanitizedId = sanitizeProfileId(id)
    if (!sanitizedId) {
      throw new ConfigProfilesError(400, 'invalid id')
    }
    try {
      const filePath = join(configsDir, `${sanitizedId}.json`)
      if (existsSyncImpl(filePath)) unlinkSyncImpl(filePath)
      return { ok: true }
    } catch (error) {
      throw toConfigProfilesError(error)
    }
  }

  function listStoredCodexConfigs() {
    return listCodexConfigsImpl(codexConfigsDir)
  }

  /** @param {{ id?: string }} [options] */
  function importGlobalCodexConfig({ id } = {}) {
    const imported = readGlobalCodexConfigImpl()
    if (!imported) {
      throw new ConfigProfilesError(404, 'global ~/.codex not found')
    }

    try {
      const preferredId = String(id || '').trim()
      const baseId = preferredId.replace(/[^a-z0-9_-]/gi, '-').toLowerCase() || 'imported'
      let nextId = baseId
      let counter = 1
      while (existsSyncImpl(join(codexConfigsDir, `${nextId}.json`))) {
        nextId = `${baseId}-${counter++}`
      }

      const saved = saveCodexConfigWithMetadata(nextId, imported)
      return { ok: true, id: saved.id, config: saved.config }
    } catch (error) {
      throw toConfigProfilesError(error)
    }
  }

  function syncCurrentCodexConfig(id) {
    const existing = readCodexConfigImpl(codexConfigsDir, id)
    if (!existing) {
      throw new ConfigProfilesError(404, 'config not found')
    }

    const imported = readGlobalCodexConfigImpl()
    if (!imported) {
      throw new ConfigProfilesError(404, 'global ~/.codex not found')
    }

    try {
      const saved = saveCodexConfigWithMetadata(id, {
        ...imported,
        label: String(existing.label || imported.label || id).trim() || id,
      })
      return { ok: true, id: saved.id, config: saved.config }
    } catch (error) {
      throw toConfigProfilesError(error)
    }
  }

  function validateCodexConfig(id) {
    const config = readCodexConfigImpl(codexConfigsDir, id)
    if (!config) {
      throw new ConfigProfilesError(404, 'config not found')
    }

    mkdirSyncImpl(codexValidateDir, { recursive: true })
    const tempHome = mkdtempSyncImpl(join(codexValidateDir, 'validate-'))
    const outputFile = join(tempHome, 'last-message.txt')

    try {
      const validationConfig = buildCodexValidationConfigImpl(config)
      const authMode = detectCodexAuthModeImpl(validationConfig)
      const requiresExecValidation = authMode !== 'chatgpt'
        || Boolean(validationConfig.OPENAI_API_KEY)
        || Boolean(validationConfig.BASE_URL)

      materializeCodexHomeImpl({
        config: validationConfig,
        homeDir: tempHome,
        projectPath,
        includeSharedState: false,
      })

      const proxyVars = collectProxyVarsImpl(env, claudeProxy)
      const loginStatusResult = runCodexValidationCommand(
        tempHome,
        proxyVars,
        ['login', 'status'],
        CODEX_LOGIN_STATUS_TIMEOUT_MS,
      )

      if (loginStatusResult.error) {
        const message = loginStatusResult.error.code === 'ETIMEDOUT'
          ? codexTimeoutMessage('login status', CODEX_LOGIN_STATUS_TIMEOUT_MS)
          : loginStatusResult.error.message
        throw buildValidationError(loginStatusResult.error.code === 'ETIMEDOUT' ? 504 : 500, message)
      }

      if (loginStatusResult.status !== 0) {
        throw buildValidationError(400, summarizeCodexValidationFailure(loginStatusResult))
      }

      const loginStatusMessage = summarizeCodexCommandSuccess(loginStatusResult)

      if (!requiresExecValidation) {
        return { ok: true, message: loginStatusMessage || 'Logged in using ChatGPT' }
      }

      const result = runCodexValidationCommand(
        tempHome,
        proxyVars,
        [
          'exec',
          '--skip-git-repo-check',
          '--ephemeral',
          '--dangerously-bypass-approvals-and-sandbox',
          '--color',
          'never',
          '-C',
          projectPath,
          '-o',
          outputFile,
          'Reply with EXACTLY: OK',
        ],
        CODEX_EXEC_VALIDATE_TIMEOUT_MS,
      )

      if (result.error) {
        const message = result.error.code === 'ETIMEDOUT'
          ? codexTimeoutMessage('exec validation', CODEX_EXEC_VALIDATE_TIMEOUT_MS)
          : result.error.message
        throw buildValidationError(result.error.code === 'ETIMEDOUT' ? 504 : 500, message)
      }

      if (result.status !== 0) {
        throw buildValidationError(400, summarizeCodexValidationFailure(result))
      }

      const message = existsSyncImpl(outputFile) ? readFileSyncImpl(outputFile, 'utf8').trim() : 'OK'
      return { ok: true, message: message || 'OK' }
    } finally {
      rmSyncImpl(tempHome, { recursive: true, force: true })
    }
  }

  function saveCodexConfigProfile(id, config = {}) {
    try {
      const saved = saveCodexConfigWithMetadata(id, config)
      return { ok: true, id: saved.id }
    } catch (error) {
      throw toConfigProfilesError(error)
    }
  }

  function listCcSwitchProvidersForKind(kind) {
    ensureKind(kind)
    const existingProfiles = kind === 'claude'
      ? listClaudeConfigs()
      : listStoredCodexConfigs()
    return listCcSwitchProvidersImpl({ kind, existingProfiles })
  }

  function importCcSwitchProviderProfile({ kind, providerId }) {
    ensureKind(kind)
    const existingProfiles = kind === 'claude'
      ? listClaudeConfigs()
      : listStoredCodexConfigs()

    const imported = importCcSwitchProviderImpl({ kind, providerId })
    if (!imported) {
      throw new ConfigProfilesError(404, 'provider not found')
    }

    const targetId = resolveCcSwitchTargetProfileIdImpl(existingProfiles, {
      id: providerId,
      name: imported.SYNC_SOURCE_NAME || imported.label,
    })

    try {
      if (kind === 'claude') {
        const saved = saveStoredClaudeConfig(configsDir, targetId, imported, fileDeps)
        return { ok: true, id: saved.id, config: saved.config }
      }

      const saved = saveCodexConfigWithMetadata(targetId, imported)
      return { ok: true, id: saved.id, config: saved.config }
    } catch (error) {
      throw toConfigProfilesError(error)
    }
  }

  function deleteCodexConfigProfile(id) {
    try {
      deleteCodexConfigImpl(codexConfigsDir, id)
      return { ok: true }
    } catch (error) {
      throw toConfigProfilesError(error)
    }
  }

  function getProjectDefaultForPath(rawPath) {
    const normalizedPath = String(rawPath || '').trim()
    if (!normalizedPath) return null
    return getProjectDefaultImpl(projectDefaultsFile, resolveWorkspacePath(normalizedPath))
  }

  function readToolbarConfig() {
    try {
      if (!existsSyncImpl(toolbarConfigFile)) return null
      return JSON.parse(readFileSyncImpl(toolbarConfigFile, 'utf8'))
    } catch {
      return null
    }
  }

  function saveToolbarConfig(config) {
    try {
      writeFileSyncImpl(toolbarConfigFile, JSON.stringify(config), 'utf8')
      return { ok: true }
    } catch (error) {
      throw toConfigProfilesError(error)
    }
  }

  return {
    listClaudeConfigs,
    saveClaudeConfig,
    syncCurrentClaudeConfig,
    deleteClaudeConfig,
    listCodexConfigs: listStoredCodexConfigs,
    importGlobalCodexConfig,
    syncCurrentCodexConfig,
    validateCodexConfig,
    saveCodexConfig: saveCodexConfigProfile,
    listCcSwitchProviders: listCcSwitchProvidersForKind,
    importCcSwitchProviderProfile,
    deleteCodexConfigProfile,
    getProjectDefaultForPath,
    readToolbarConfig,
    saveToolbarConfig,
  }
}
