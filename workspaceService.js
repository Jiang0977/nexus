import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'

export class WorkspaceError extends Error {
  constructor(statusCode, message) {
    super(message)
    this.name = 'WorkspaceError'
    this.statusCode = statusCode
  }
}

/**
 * @typedef {{
 *   workspaceRoot: string,
 *   existsSyncImpl?: typeof existsSync,
 *   mkdirSyncImpl?: typeof mkdirSync,
 *   readdirSyncImpl?: typeof readdirSync,
 *   readFileSyncImpl?: typeof readFileSync,
 *   renameSyncImpl?: typeof renameSync,
 *   rmSyncImpl?: typeof rmSync,
 *   statSyncImpl?: typeof statSync,
 *   writeFileSyncImpl?: typeof writeFileSync,
 *   cpSyncImpl?: typeof cpSync,
 * }} WorkspaceServiceOptions
 */

/** @param {WorkspaceServiceOptions} options */
export function createWorkspaceService(options) {
  const {
    workspaceRoot,
    existsSyncImpl = existsSync,
    mkdirSyncImpl = mkdirSync,
    readdirSyncImpl = readdirSync,
    readFileSyncImpl = readFileSync,
    renameSyncImpl = renameSync,
    rmSyncImpl = rmSync,
    statSyncImpl = statSync,
    writeFileSyncImpl = writeFileSync,
    cpSyncImpl = cpSync,
  } = options

  function resolveInputPath(inputPath, { allowEmpty = false } = {}) {
    let resolved = inputPath || ''
    if (!allowEmpty && !resolved) {
      throw new WorkspaceError(400, 'path required')
    }
    if (resolved === '~' || !resolved) resolved = workspaceRoot
    if (!isAbsolute(resolved)) resolved = join(workspaceRoot, resolved)
    resolved = normalize(resolved)
    if (resolved.includes('..')) {
      throw new WorkspaceError(403, 'invalid path')
    }
    return resolved
  }

  function ensureExistingPath(pathValue, notFoundMessage = 'not found') {
    if (!existsSyncImpl(pathValue)) {
      throw new WorkspaceError(404, notFoundMessage)
    }
  }

  function browseDirectories(pathValue) {
    const resolvedPath = resolveInputPath(pathValue, { allowEmpty: true })
    const entries = readdirSyncImpl(resolvedPath, { withFileTypes: true })
    const dirs = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => ({ name: entry.name, path: join(resolvedPath, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    const parent = dirname(resolvedPath) !== resolvedPath ? dirname(resolvedPath) : null
    return { path: resolvedPath, parent, dirs }
  }

  function listEntries(pathValue) {
    const resolvedPath = resolveInputPath(pathValue, { allowEmpty: true })
    const dirents = readdirSyncImpl(resolvedPath, { withFileTypes: true })
    const entries = dirents
      .filter((entry) => !entry.name.startsWith('.'))
      .map((entry) => {
        const fullPath = join(resolvedPath, entry.name)
        const stat = statSyncImpl(fullPath)
        return {
          name: entry.name,
          type: entry.isDirectory() ? 'dir' : 'file',
          size: entry.isFile() ? stat.size : undefined,
          mtime: stat.mtimeMs,
        }
      })
    return { path: resolvedPath, entries }
  }

  function resolveServeFilePath({ queryPath, requestPath }) {
    let fullPath
    if (queryPath) {
      fullPath = normalize(decodeURIComponent(queryPath))
    } else {
      let relativePath = decodeURIComponent(requestPath || '')
      relativePath = normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, '')
      fullPath = join(workspaceRoot, relativePath)
    }
    if (fullPath.includes('..')) {
      throw new WorkspaceError(403, 'access denied: invalid path')
    }
    if (!existsSyncImpl(fullPath) || !statSyncImpl(fullPath).isFile()) {
      throw new WorkspaceError(404, 'not found')
    }
    return fullPath
  }

  function createDirectory({ path: targetPath, name }) {
    if (!name) throw new WorkspaceError(400, 'name required')
    const resolvedPath = resolveInputPath(targetPath, { allowEmpty: true })
    const dirPath = join(resolvedPath, name)
    if (dirPath.includes('..')) throw new WorkspaceError(403, 'invalid path')
    if (existsSyncImpl(dirPath)) throw new WorkspaceError(409, 'already exists')
    mkdirSyncImpl(dirPath, { recursive: true })
    return { ok: true, path: dirPath }
  }

  function createFile({ path: targetPath, name, content = '' }) {
    if (!name) throw new WorkspaceError(400, 'name required')
    const resolvedPath = resolveInputPath(targetPath, { allowEmpty: true })
    const filePath = join(resolvedPath, name)
    if (filePath.includes('..')) throw new WorkspaceError(403, 'invalid path')
    if (existsSyncImpl(filePath)) throw new WorkspaceError(409, 'already exists')
    writeFileSyncImpl(filePath, content, 'utf8')
    return { ok: true, path: filePath }
  }

  function readFileContent(pathValue) {
    const resolvedPath = resolveInputPath(pathValue)
    if (!existsSyncImpl(resolvedPath) || !statSyncImpl(resolvedPath).isFile()) {
      throw new WorkspaceError(404, 'not found')
    }
    return { path: resolvedPath, content: readFileSyncImpl(resolvedPath, 'utf8') }
  }

  function writeFileContent({ path: filePath, content = '' }) {
    const resolvedPath = resolveInputPath(filePath)
    writeFileSyncImpl(resolvedPath, content, 'utf8')
    return { ok: true, path: resolvedPath }
  }

  function deleteEntry(pathValue) {
    const resolvedPath = resolveInputPath(pathValue)
    ensureExistingPath(resolvedPath)
    rmSyncImpl(resolvedPath, { recursive: true, force: true })
    return { ok: true }
  }

  function renameEntry({ path: srcPath, newName }) {
    if (!srcPath || !newName) throw new WorkspaceError(400, 'path and newName required')
    const resolvedSource = resolveInputPath(srcPath)
    ensureExistingPath(resolvedSource)
    const destPath = normalize(join(dirname(resolvedSource), newName))
    if (destPath.includes('..')) throw new WorkspaceError(403, 'invalid newName')
    if (existsSyncImpl(destPath)) throw new WorkspaceError(409, 'already exists')
    renameSyncImpl(resolvedSource, destPath)
    return { ok: true, path: destPath }
  }

  function copyEntry({ sourcePath, targetPath }) {
    if (!sourcePath || !targetPath) throw new WorkspaceError(400, 'sourcePath and targetPath required')
    const resolvedSource = resolveInputPath(sourcePath)
    const resolvedTarget = resolveInputPath(targetPath)
    ensureExistingPath(resolvedSource, 'source not found')
    if (existsSyncImpl(resolvedTarget)) throw new WorkspaceError(409, 'target already exists')
    cpSyncImpl(resolvedSource, resolvedTarget, { recursive: true })
    return { ok: true, path: resolvedTarget }
  }

  function moveEntry({ sourcePath, targetPath }) {
    if (!sourcePath || !targetPath) throw new WorkspaceError(400, 'sourcePath and targetPath required')
    const resolvedSource = resolveInputPath(sourcePath)
    const resolvedTarget = resolveInputPath(targetPath)
    ensureExistingPath(resolvedSource, 'source not found')
    if (existsSyncImpl(resolvedTarget)) throw new WorkspaceError(409, 'target already exists')
    try {
      renameSyncImpl(resolvedSource, resolvedTarget)
    } catch (error) {
      if (error?.code === 'EXDEV') {
        cpSyncImpl(resolvedSource, resolvedTarget, { recursive: true })
        rmSyncImpl(resolvedSource, { recursive: true, force: true })
      } else {
        throw error
      }
    }
    return { ok: true, path: resolvedTarget }
  }

  return {
    browseDirectories,
    listEntries,
    resolveServeFilePath,
    createDirectory,
    createFile,
    readFileContent,
    writeFileContent,
    deleteEntry,
    renameEntry,
    copyEntry,
    moveEntry,
    basename,
  }
}
