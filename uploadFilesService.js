import { execSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { shellQuote } from './shellLaunch.js'

export class UploadFilesError extends Error {
  constructor(statusCode, message, options = {}) {
    super(message)
    this.name = 'UploadFilesError'
    this.statusCode = statusCode
    this.responseBody = options.responseBody || null
  }
}

/**
 * @typedef {{
 *   workspaceRoot: string,
 *   uploadsDir: string,
 *   tmuxSession: string,
 *   execSyncImpl?: typeof execSync,
 *   existsSyncImpl?: typeof existsSync,
 *   mkdirSyncImpl?: typeof mkdirSync,
 *   writeFileSyncImpl?: typeof writeFileSync,
 *   readdirSyncImpl?: typeof readdirSync,
 *   statSyncImpl?: typeof statSync,
 *   unlinkSyncImpl?: typeof unlinkSync,
 *   rmdirSyncImpl?: typeof rmdirSync,
 *   currentDateDirImpl?: () => string,
 * }} UploadFilesServiceOptions
 */

function readCommandOutput(execSyncImpl, command) {
  return String(execSyncImpl(command, { encoding: 'utf8' }) || '').trim()
}

/** @param {UploadFilesServiceOptions} options */
export function createUploadFilesService(options) {
  const {
    workspaceRoot,
    uploadsDir,
    tmuxSession,
    execSyncImpl = execSync,
    existsSyncImpl = existsSync,
    mkdirSyncImpl = mkdirSync,
    writeFileSyncImpl = writeFileSync,
    readdirSyncImpl = readdirSync,
    statSyncImpl = statSync,
    unlinkSyncImpl = unlinkSync,
    rmdirSyncImpl = rmdirSync,
    currentDateDirImpl = () => new Date().toISOString().slice(0, 10),
  } = options

  function resolveWorkspaceUploadDestination(sessionName) {
    let cwd = workspaceRoot

    try {
      const sessionWindows = readCommandOutput(
        execSyncImpl,
        `tmux list-windows -t ${shellQuote(tmuxSession)} -F "#I:#W:#{pane_current_path}"`,
      ).split('\n').filter(Boolean)

      for (const line of sessionWindows) {
        const parts = line.split(':')
        const name = parts[1]
        const path = parts.slice(2).join(':')
        if (sessionName && name === sessionName) {
          cwd = path
          break
        }

        if (!sessionName) {
          const activeWindows = readCommandOutput(
            execSyncImpl,
            `tmux list-windows -t ${shellQuote(tmuxSession)} -F "#I:#W:#{pane_current_path}:#{window_active}"`,
          ).split('\n').filter(Boolean)
          for (const activeLine of activeWindows) {
            const activeParts = activeLine.split(':')
            if (activeParts[activeParts.length - 1]?.trim() === '1') {
              cwd = activeParts.slice(2, activeParts.length - 1).join(':')
              break
            }
          }
          break
        }
      }
    } catch {}

    return existsSyncImpl(cwd) ? cwd : workspaceRoot
  }

  function sanitizeWorkspaceUploadFilename(originalName) {
    return String(originalName || '').replace(/[^a-zA-Z0-9._-]/g, '_')
  }

  function buildWorkspaceUploadResult(file) {
    return {
      ok: true,
      path: file.path,
      filename: file.filename,
      size: file.size,
    }
  }

  function ensureManagedUploadDir(dateDir) {
    const uploadDir = join(uploadsDir, dateDir)
    if (!existsSyncImpl(uploadDir)) {
      mkdirSyncImpl(uploadDir, { recursive: true })
    }
    return uploadDir
  }

  function saveManagedUploadFile({ fileBuffer, originalName, preferredName, size, overwrite }) {
    const dateDir = currentDateDirImpl()
    const uploadDir = ensureManagedUploadDir(dateDir)
    const resolvedOriginalName = preferredName || originalName
    const safe = String(resolvedOriginalName || '').replace(/[<>:"|?*\\/\x00-\x1f]/g, '_')
    const filePath = join(uploadDir, safe)

    if (!overwrite && existsSyncImpl(filePath)) {
      throw new UploadFilesError(409, 'file exists', {
        responseBody: {
          error: 'file exists',
          filename: safe,
          message: `文件 "${safe}" 已存在`,
        },
      })
    }

    try {
      writeFileSyncImpl(filePath, fileBuffer)
    } catch (error) {
      throw new UploadFilesError(500, error.message)
    }

    return {
      ok: true,
      filename: safe,
      url: `/uploads/${dateDir}/${safe}`,
      fullPath: filePath,
      size,
      originalName: resolvedOriginalName,
    }
  }

  function listManagedFiles() {
    try {
      const result = []
      const dateDirs = readdirSyncImpl(uploadsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left))

      for (const dateDir of dateDirs) {
        const dirPath = join(uploadsDir, dateDir)
        const files = readdirSyncImpl(dirPath, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => {
            const stat = statSyncImpl(join(dirPath, entry.name))
            return {
              name: entry.name,
              url: `/uploads/${dateDir}/${entry.name}`,
              fullPath: join(dirPath, entry.name),
              size: stat.size,
              created: stat.mtimeMs,
            }
          })
          .sort((left, right) => right.created - left.created)

        if (files.length > 0) {
          result.push({ date: dateDir, files })
        }
      }

      return result
    } catch (error) {
      throw new UploadFilesError(500, error.message)
    }
  }

  function deleteManagedFile({ date, filename }) {
    const dateDir = String(date || '').replace(/[^0-9-]/g, '')
    const safeFilename = sanitizeWorkspaceUploadFilename(filename)
    const filePath = join(uploadsDir, dateDir, safeFilename)

    if (!filePath.startsWith(uploadsDir)) {
      throw new UploadFilesError(400, 'invalid path')
    }

    try {
      if (!existsSyncImpl(filePath)) {
        throw new UploadFilesError(404, 'file not found')
      }
      unlinkSyncImpl(filePath)
      return { ok: true }
    } catch (error) {
      if (error instanceof UploadFilesError) throw error
      throw new UploadFilesError(500, error.message)
    }
  }

  function deleteAllManagedFiles() {
    try {
      const dateDirs = readdirSyncImpl(uploadsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
      let deletedCount = 0

      for (const dateDir of dateDirs) {
        const dirPath = join(uploadsDir, dateDir.name)
        const files = readdirSyncImpl(dirPath, { withFileTypes: true })
          .filter((entry) => entry.isFile())

        for (const file of files) {
          try {
            unlinkSyncImpl(join(dirPath, file.name))
            deletedCount += 1
          } catch {}
        }

        try {
          rmdirSyncImpl(dirPath)
        } catch {}
      }

      return { ok: true, deletedCount }
    } catch (error) {
      throw new UploadFilesError(500, error.message)
    }
  }

  return {
    resolveWorkspaceUploadDestination,
    sanitizeWorkspaceUploadFilename,
    buildWorkspaceUploadResult,
    saveManagedUploadFile,
    listManagedFiles,
    deleteManagedFile,
    deleteAllManagedFiles,
  }
}
