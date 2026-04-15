import { execSync } from 'node:child_process'
import { rmSync } from 'node:fs'

import { resolveCodexRuntimeDir } from './codexConfig.js'
import {
  closeTmuxWindowsForCodexSession,
  markTmuxWindowAsCodexResumeSession,
} from './codexSessionWindows.js'
import {
  deleteCodexSession,
  findProjectCodexSession,
  listProjectCodexSessions,
} from './codexSessions.js'
import { shellQuote } from './shellLaunch.js'

export class SessionManagementError extends Error {
  constructor(statusCode, message, options = {}) {
    super(message)
    this.name = 'SessionManagementError'
    this.statusCode = statusCode
    this.responseBody = options.responseBody || null
  }
}

function readCommandOutput(execSyncImpl, command) {
  return String(execSyncImpl(command, { encoding: 'utf8' }) || '').trim()
}

/**
 * @typedef {{
 *   ok: true,
 *   project: string,
 *   channelIndex: number,
 *   channelName: string,
 *   sessionId: string,
 * }} CodexResumeResult
 *
 * @typedef {{
 *   expiresAt: number,
 *   promise?: Promise<CodexResumeResult>,
 *   result?: CodexResumeResult,
 * }} CodexResumeDedupEntry
 */

/**
 * @typedef {{
 *   tmuxSession: string,
 *   workspaceRoot: string,
 *   sharedCodexHome: string,
 *   codexRuntimeDir: string,
 *   defaultInteractiveShell: string,
 *   execSyncImpl?: typeof execSync,
 *   rmSyncImpl?: typeof rmSync,
 *   nowImpl?: () => number,
 *   resolveWorkspacePathImpl?: (inputPath: string) => string,
 *   readSessionWorkspacePathImpl?: (sessionName: string) => string,
 *   resolveProjectPathImpl?: (sessionName: string) => string,
 *   rememberProjectDefaultImpl?: (cwd: string, shellType: string, profile?: string) => void,
 *   setTmuxSessionEnvImpl?: (sessionName: string, key: string, value: string) => void,
 *   applyProxyEnvToSessionImpl?: (sessionName: string, proxyVars: Record<string, string>) => void,
 *   ensureTmuxSessionImpl?: (sessionName: string) => void,
 *   buildShellCommandImpl?: (shellType: string, profile: string, cwd: string, options?: Record<string, unknown>) => { proxyVars: Record<string, string>, shellCmd: string },
 *   buildCodexResumeWindowNameImpl?: (projectName: string, sessionInfo: Record<string, any>) => string,
 *   createTmuxWindowSyncImpl?: (sessionName: string, cwd: string, windowName: string, shellCmd: string) => Promise<{ windowId: string, index: number, name: string }> | { windowId: string, index: number, name: string },
 *   listProjectCodexSessionsImpl?: typeof listProjectCodexSessions,
 *   findProjectCodexSessionImpl?: typeof findProjectCodexSession,
 *   deleteCodexSessionImpl?: typeof deleteCodexSession,
 *   closeTmuxWindowsForCodexSessionImpl?: typeof closeTmuxWindowsForCodexSession,
 *   markTmuxWindowAsCodexResumeSessionImpl?: typeof markTmuxWindowAsCodexResumeSession,
 *   resolveCodexRuntimeDirImpl?: typeof resolveCodexRuntimeDir,
 * }} SessionManagementServiceOptions
 */

/** @param {SessionManagementServiceOptions} options */
export function createSessionManagementService(options) {
  const {
    tmuxSession,
    workspaceRoot,
    sharedCodexHome,
    codexRuntimeDir,
    defaultInteractiveShell,
    execSyncImpl = execSync,
    rmSyncImpl = rmSync,
    nowImpl = Date.now,
    resolveWorkspacePathImpl = (inputPath) => {
      if (!inputPath) return workspaceRoot
      return String(inputPath).startsWith('/') ? String(inputPath) : `${workspaceRoot}/${inputPath}`
    },
    readSessionWorkspacePathImpl,
    resolveProjectPathImpl,
    rememberProjectDefaultImpl = () => {},
    setTmuxSessionEnvImpl = (sessionName, key, value) => {
      execSyncImpl(
        `tmux set-environment -t ${shellQuote(sessionName)} ${key} ${shellQuote(value)} 2>/dev/null`,
        { encoding: 'utf8' },
      )
    },
    applyProxyEnvToSessionImpl = (sessionName, proxyVars) => {
      for (const [key, value] of Object.entries(proxyVars || {})) {
        setTmuxSessionEnvImpl(sessionName, key, value)
      }
    },
    ensureTmuxSessionImpl = (sessionName) => {
      execSyncImpl(
        `tmux has-session -t ${shellQuote(sessionName)} 2>/dev/null || tmux new-session -d -s ${shellQuote(sessionName)} -n shell ${shellQuote(defaultInteractiveShell)}`,
        { encoding: 'utf8' },
      )
    },
    buildShellCommandImpl = () => ({ proxyVars: {}, shellCmd: defaultInteractiveShell }),
    buildCodexResumeWindowNameImpl = (projectName, sessionInfo) => {
      const titleSlug = String(sessionInfo?.title || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 18)
      const shortId = String(sessionInfo?.id || '').slice(0, 8) || 'history'
      const baseName = titleSlug ? `codex-${titleSlug}` : `codex-${shortId}`

      try {
        const existing = readCommandOutput(
          execSyncImpl,
          `tmux list-windows -t ${shellQuote(projectName)} -F "#{window_name}" 2>/dev/null`,
        ).split('\n').filter(Boolean)
        let candidate = baseName
        let counter = 1
        while (existing.includes(candidate)) {
          candidate = `${baseName}-${counter++}`
        }
        return candidate
      } catch {
        return baseName
      }
    },
    createTmuxWindowSyncImpl = (sessionName, cwd, windowName, shellCmd) => {
      const output = readCommandOutput(
        execSyncImpl,
        `tmux new-window -P -F "#{window_id}|#{window_index}|#{window_name}" -t ${shellQuote(sessionName)} -c ${shellQuote(cwd)} -n ${shellQuote(windowName)} ${shellQuote(shellCmd)}`,
      )
      const [windowId, index, name] = output.split('|')
      return {
        windowId: windowId || '',
        index: Number(index),
        name: name || windowName,
      }
    },
    listProjectCodexSessionsImpl = listProjectCodexSessions,
    findProjectCodexSessionImpl = findProjectCodexSession,
    deleteCodexSessionImpl = deleteCodexSession,
    closeTmuxWindowsForCodexSessionImpl = closeTmuxWindowsForCodexSession,
    markTmuxWindowAsCodexResumeSessionImpl = markTmuxWindowAsCodexResumeSession,
    resolveCodexRuntimeDirImpl = resolveCodexRuntimeDir,
  } = options

  /** @type {Map<string, CodexResumeDedupEntry>} */
  const codexResumeDedupMap = new Map()

  const readSessionWorkspacePath = readSessionWorkspacePathImpl || ((sessionName) => {
    try {
      const envOutput = readCommandOutput(
        execSyncImpl,
        `tmux show-environment -t ${shellQuote(sessionName)} NEXUS_CWD 2>/dev/null`,
      )
      const match = envOutput.match(/^NEXUS_CWD=(.+)$/)
      return match ? match[1] : workspaceRoot
    } catch {
      return workspaceRoot
    }
  })

  const resolveProjectPath = resolveProjectPathImpl || ((sessionName) => {
    const sessionPath = readSessionWorkspacePath(sessionName)
    if (sessionPath && sessionPath !== workspaceRoot) return sessionPath

    try {
      const panePath = readCommandOutput(
        execSyncImpl,
        `tmux display-message -t ${shellQuote(sessionName)} -p '#{pane_current_path}' 2>/dev/null`,
      )
      return panePath || sessionPath || workspaceRoot
    } catch {
      return sessionPath || workspaceRoot
    }
  })

  function ensureSessionExists(sessionName, notFoundMessage = 'project not found') {
    try {
      execSyncImpl(`tmux has-session -t ${shellQuote(sessionName)} 2>/dev/null`, { encoding: 'utf8' })
    } catch {
      throw new SessionManagementError(404, notFoundMessage)
    }
  }

  function getTmuxWindowId(sessionName, windowIndex) {
    try {
      return readCommandOutput(
        execSyncImpl,
        `tmux display-message -t ${shellQuote(`${sessionName}:${windowIndex}`)} -p '#{window_id}' 2>/dev/null`,
      )
    } catch {
      return ''
    }
  }

  function cleanupCodexRuntime(windowId) {
    if (!windowId) return
    rmSyncImpl(resolveCodexRuntimeDirImpl(codexRuntimeDir, windowId), { recursive: true, force: true })
  }

  function listTmuxWindowIds(sessionName) {
    try {
      const stdout = readCommandOutput(
        execSyncImpl,
        `tmux list-windows -t ${shellQuote(sessionName)} -F '#{window_id}' 2>/dev/null`,
      )
      return stdout ? stdout.split('\n').filter(Boolean) : []
    } catch {
      return []
    }
  }

  /**
   * @param {string} key
   * @param {() => Promise<CodexResumeResult>} action
   * @returns {Promise<CodexResumeResult & { deduped: boolean }>}
   */
  async function runDedupedCodexResume(key, action) {
    const now = nowImpl()
    for (const [entryKey, entry] of codexResumeDedupMap.entries()) {
      if (entry.expiresAt <= now) codexResumeDedupMap.delete(entryKey)
    }

    const existing = codexResumeDedupMap.get(key)
    if (existing && existing.expiresAt > now) {
      if (existing.promise) {
        const result = await existing.promise
        return { ...result, deduped: true }
      }
      if (existing.result) {
        return { ...existing.result, deduped: true }
      }
    }

    const promise = Promise.resolve().then(action)
    codexResumeDedupMap.set(key, { expiresAt: now + 15000, promise })

    try {
      const result = await promise
      codexResumeDedupMap.set(key, { expiresAt: nowImpl() + 15000, result })
      return { ...result, deduped: false }
    } catch (error) {
      codexResumeDedupMap.delete(key)
      throw error
    }
  }

  function listTmuxSessions() {
    try {
      const stdout = readCommandOutput(
        execSyncImpl,
        'tmux list-sessions -F "#{session_name}|#{session_windows}|#{session_attached}"',
      )
      return stdout.split('\n').filter(Boolean).map((line) => {
        const [name, windows, attached] = line.split('|')
        return { name, windows: Number(windows), attached: Number(attached) > 0 }
      })
    } catch {
      return [{ name: tmuxSession, windows: 0, attached: false }]
    }
  }

  function listProjects() {
    try {
      const stdout = readCommandOutput(
        execSyncImpl,
        'tmux list-sessions -F "#{session_name}|#{session_windows}|#{session_attached}"',
      )
      const lines = stdout.split('\n').filter(Boolean)
      const projects = lines.map((line) => {
        const [name, windows] = line.split('|')
        let path = ''
        try {
          const envOutput = readCommandOutput(
            execSyncImpl,
            `tmux show-environment -t ${name} NEXUS_CWD 2>/dev/null`,
          )
          const match = envOutput.match(/^NEXUS_CWD=(.+)$/)
          if (match) path = match[1]
        } catch {}
        if (!path && windows !== '0') {
          try {
            const cwdOutput = readCommandOutput(
              execSyncImpl,
              `tmux list-windows -t ${name} -F '#{pane_current_path}' 2>/dev/null | head -1`,
            )
            if (cwdOutput) path = cwdOutput.split('\n')[0]
          } catch {}
        }
        return {
          name,
          path: path || workspaceRoot,
          active: name === tmuxSession,
          channelCount: Number(windows) || 0,
        }
      })
      projects.reverse()
      return projects
    } catch {
      return []
    }
  }

  function getSessionCwd(sessionName = tmuxSession) {
    let cwd = workspaceRoot
    try {
      const envOutput = readCommandOutput(
        execSyncImpl,
        `tmux show-environment -t ${shellQuote(sessionName)} NEXUS_CWD 2>/dev/null`,
      )
      const match = envOutput.match(/^NEXUS_CWD=(.+)$/)
      if (match) cwd = match[1]
    } catch {}

    if (cwd === workspaceRoot) {
      try {
        const panePath = readCommandOutput(
          execSyncImpl,
          `tmux display-message -t ${shellQuote(sessionName)} -p '#{pane_current_path}' 2>/dev/null`,
        )
        if (panePath) cwd = panePath
      } catch {}
    }

    const relative = cwd.startsWith(workspaceRoot)
      ? cwd.slice(workspaceRoot.length).replace(/^\/+/, '')
      : ''
    return { cwd, relative }
  }

  function listCodexSessions({ projectName, limit, cursor }) {
    if (!projectName) {
      throw new SessionManagementError(400, 'project required')
    }
    ensureSessionExists(projectName)

    try {
      return listProjectCodexSessionsImpl({
        projectName,
        projectPath: resolveProjectPath(projectName),
        codexHome: sharedCodexHome,
        limit,
        cursor,
      })
    } catch (error) {
      throw new SessionManagementError(500, error?.message || 'failed to list codex sessions')
    }
  }

  async function resumeCodexSession({ sessionId, projectName }) {
    const normalizedSessionId = String(sessionId || '').trim()
    const normalizedProjectName = String(projectName || '').trim()

    if (!normalizedSessionId) {
      throw new SessionManagementError(400, 'session id required')
    }
    if (!normalizedProjectName) {
      throw new SessionManagementError(400, 'project required')
    }
    ensureSessionExists(normalizedProjectName)

    const projectPath = resolveProjectPath(normalizedProjectName)
    const sessionInfo = findProjectCodexSessionImpl({
      sessionId: normalizedSessionId,
      projectName: normalizedProjectName,
      projectPath,
      codexHome: sharedCodexHome,
    })
    if (!sessionInfo) {
      throw new SessionManagementError(404, 'codex session not found in project')
    }

    try {
      return await runDedupedCodexResume(`${normalizedProjectName}:${normalizedSessionId}`, async () => {
        const resumeCwd = sessionInfo.cwd || projectPath
        const { proxyVars, shellCmd } = buildShellCommandImpl('codex', '', resumeCwd, {
          resumeSessionId: normalizedSessionId,
        })

        ensureTmuxSessionImpl(normalizedProjectName)
        applyProxyEnvToSessionImpl(normalizedProjectName, proxyVars)

        const createdWindow = await Promise.resolve(
          createTmuxWindowSyncImpl(
            normalizedProjectName,
            resumeCwd,
            buildCodexResumeWindowNameImpl(normalizedProjectName, sessionInfo),
            shellCmd,
          ),
        )

        markTmuxWindowAsCodexResumeSessionImpl({
          windowTarget: createdWindow.windowId || `${normalizedProjectName}:${createdWindow.index}`,
          sessionId: normalizedSessionId,
        })

        try {
          execSyncImpl(
            `tmux select-window -t ${shellQuote(`${normalizedProjectName}:${createdWindow.index}`)} 2>/dev/null`,
            { encoding: 'utf8' },
          )
        } catch {}
        try {
          execSyncImpl(
            `tmux set-environment -t ${shellQuote(normalizedProjectName)} NEXUS_LAST_CHANNEL ${createdWindow.index} 2>/dev/null`,
            { encoding: 'utf8' },
          )
        } catch {}

        return {
          ok: true,
          project: normalizedProjectName,
          channelIndex: createdWindow.index,
          channelName: createdWindow.name,
          sessionId: normalizedSessionId,
        }
      })
    } catch (error) {
      if (error instanceof SessionManagementError) throw error
      throw new SessionManagementError(500, error?.message || 'failed to resume codex session')
    }
  }

  function deleteProjectCodexSession({ sessionId, projectName }) {
    const normalizedSessionId = String(sessionId || '').trim()
    const normalizedProjectName = String(projectName || '').trim()

    if (!normalizedSessionId) {
      throw new SessionManagementError(400, 'session id required')
    }
    if (!/^[A-Za-z0-9._-]+$/.test(normalizedSessionId)) {
      throw new SessionManagementError(400, 'invalid session id')
    }
    if (!normalizedProjectName) {
      throw new SessionManagementError(400, 'project required')
    }
    ensureSessionExists(normalizedProjectName)

    const projectPath = resolveProjectPath(normalizedProjectName)
    const sessionInfo = findProjectCodexSessionImpl({
      sessionId: normalizedSessionId,
      projectName: normalizedProjectName,
      projectPath,
      codexHome: sharedCodexHome,
    })
    if (!sessionInfo) {
      throw new SessionManagementError(404, 'codex session not found in project')
    }

    try {
      const result = deleteCodexSessionImpl({
        sessionId: normalizedSessionId,
        codexHome: sharedCodexHome,
      })
      const closedWindows = closeTmuxWindowsForCodexSessionImpl({
        sessionName: normalizedProjectName,
        sessionId: normalizedSessionId,
        defaultInteractiveShell,
        cleanupRuntime: cleanupCodexRuntime,
      })
      return {
        ok: true,
        sessionId: result.id,
        closedWindowIndexes: closedWindows.map((window) => window.index),
      }
    } catch (error) {
      throw new SessionManagementError(500, error?.message || 'failed to delete codex session')
    }
  }

  function listProjectChannels(projectName) {
    const normalizedProjectName = String(projectName || '').trim()
    try {
      const stdout = readCommandOutput(
        execSyncImpl,
        `tmux list-windows -t ${shellQuote(normalizedProjectName)} -F "#{window_index}|#{window_name}|#{window_active}|#{pane_current_path}"`,
      )
      const channels = stdout.split('\n').filter(Boolean).map((line) => {
        const parts = line.split('|')
        return {
          index: Number(parts[0]),
          name: parts[1],
          active: parts[2]?.trim() === '1',
          cwd: parts.slice(3).join('|') || '',
        }
      })
      channels.reverse()
      return { project: normalizedProjectName, channels }
    } catch (error) {
      throw new SessionManagementError(500, error?.message || 'failed to list project channels')
    }
  }

  function createProject({ path, shellType, profile }) {
    if (!path) {
      throw new SessionManagementError(400, 'path required')
    }
    const cwd = resolveWorkspacePathImpl(path)

    let projectName = cwd.replace(/^\/+|\/+$/g, '').replace(/\//g, '-')
    if (!projectName) projectName = 'home'
    const safeName = projectName.replace(/[^a-zA-Z0-9._~-]/g, '-').substring(0, 50) || 'project'

    let finalName = safeName
    try {
      const existing = readCommandOutput(
        execSyncImpl,
        'tmux list-sessions -F "#{session_name}" 2>/dev/null',
      ).split('\n').filter(Boolean)
      let counter = 1
      while (existing.includes(finalName)) {
        finalName = `${safeName}-${counter++}`
      }
    } catch {}

    const { proxyVars, shellCmd } = buildShellCommandImpl(shellType, profile, cwd)
    const dirName = cwd.replace(/^\/+|\/+$/g, '').split('/').pop() || '~'
    const initialWindowName = profile ? `${dirName}-${profile}` : dirName

    try {
      execSyncImpl(
        `tmux new-session -d -s ${shellQuote(finalName)} -n ${shellQuote(initialWindowName)} -c ${shellQuote(cwd)} ${shellQuote(shellCmd)}`,
        { encoding: 'utf8' },
      )
      setTmuxSessionEnvImpl(finalName, 'NEXUS_CWD', cwd)
      applyProxyEnvToSessionImpl(finalName, proxyVars)
    } catch (error) {
      throw new SessionManagementError(500, `failed to create project: ${error.message}`)
    }

    rememberProjectDefaultImpl(cwd, shellType, profile)
    return { name: finalName, path: cwd, shell_type: shellType, profile: profile || null }
  }

  function createProjectChannel({ projectName, path, shellType, profile }) {
    const normalizedProjectName = String(projectName || '').trim()
    let cwd = workspaceRoot
    if (path) cwd = resolveWorkspacePathImpl(path)
    else cwd = readSessionWorkspacePath(normalizedProjectName)

    const baseName = profile || 'channel'
    let channelName = baseName
    try {
      const existing = readCommandOutput(
        execSyncImpl,
        `tmux list-windows -t ${shellQuote(normalizedProjectName)} -F "#{window_name}"`,
      ).split('\n').filter(Boolean)
      let counter = 1
      while (existing.includes(channelName)) {
        channelName = `${baseName}-${counter++}`
      }
    } catch {}

    const { proxyVars, shellCmd } = buildShellCommandImpl(shellType, profile, cwd)
    ensureTmuxSessionImpl(normalizedProjectName)
    applyProxyEnvToSessionImpl(normalizedProjectName, proxyVars)

    try {
      execSyncImpl(
        `tmux new-window -t ${shellQuote(normalizedProjectName)} -c ${shellQuote(cwd)} -n ${shellQuote(channelName)} ${shellQuote(shellCmd)}`,
        { encoding: 'utf8' },
      )
    } catch (error) {
      throw new SessionManagementError(500, error.message)
    }

    rememberProjectDefaultImpl(cwd, shellType, profile)
    return {
      name: channelName,
      cwd,
      shell_type: shellType,
      profile: profile || null,
      project: normalizedProjectName,
    }
  }

  function activateProject(projectName) {
    const normalizedProjectName = String(projectName || '').trim()
    ensureSessionExists(normalizedProjectName)

    let lastChannel = null
    try {
      const envOutput = readCommandOutput(
        execSyncImpl,
        `tmux show-environment -t ${shellQuote(normalizedProjectName)} NEXUS_LAST_CHANNEL 2>/dev/null`,
      )
      const match = envOutput.match(/^NEXUS_LAST_CHANNEL=(\d+)$/)
      if (match) lastChannel = Number.parseInt(match[1], 10)
    } catch {}

    if (lastChannel !== null) {
      try {
        const windows = readCommandOutput(
          execSyncImpl,
          `tmux list-windows -t ${shellQuote(normalizedProjectName)} -F "#I"`,
        ).split('\n').filter(Boolean)
        if (!windows.includes(String(lastChannel))) {
          lastChannel = null
        }
      } catch {
        lastChannel = null
      }
    }

    return { active: true, project: normalizedProjectName, lastChannel }
  }

  function renameProject({ oldName, newName }) {
    const normalizedOldName = String(oldName || '').trim()
    const sanitizedNewName = String(newName || '').trim().replace(/[^a-zA-Z0-9_\-]/g, '')
    if (!String(newName || '').trim()) {
      throw new SessionManagementError(400, 'new name required')
    }
    if (!sanitizedNewName) {
      throw new SessionManagementError(400, 'invalid name format')
    }
    ensureSessionExists(normalizedOldName)

    try {
      execSyncImpl(`tmux has-session -t ${shellQuote(sanitizedNewName)} 2>/dev/null`, { encoding: 'utf8' })
      throw new SessionManagementError(409, 'project name already exists')
    } catch (error) {
      if (error instanceof SessionManagementError) throw error
    }

    try {
      execSyncImpl(
        `tmux rename-session -t ${shellQuote(normalizedOldName)} ${shellQuote(sanitizedNewName)}`,
        { encoding: 'utf8' },
      )
      return { ok: true, oldName: normalizedOldName, newName: sanitizedNewName }
    } catch (error) {
      throw new SessionManagementError(500, error.message)
    }
  }

  function deleteProject(projectName) {
    const normalizedProjectName = String(projectName || '').trim()
    ensureSessionExists(normalizedProjectName)

    const windowIds = listTmuxWindowIds(normalizedProjectName)
    try {
      execSyncImpl(`tmux kill-session -t ${shellQuote(normalizedProjectName)}`, { encoding: 'utf8' })
      windowIds.forEach(cleanupCodexRuntime)
      return { ok: true }
    } catch (error) {
      throw new SessionManagementError(500, error.message)
    }
  }

  function listSessionWindows(sessionName = tmuxSession) {
    const normalizedSessionName = String(sessionName || '').trim() || tmuxSession
    try {
      const stdout = readCommandOutput(
        execSyncImpl,
        `tmux list-windows -t ${shellQuote(normalizedSessionName)} -F "#{window_index}|#{window_name}|#{window_active}"`,
      )
      const windows = stdout.split('\n').filter(Boolean).map((line) => {
        const [index, name, active] = line.split('|')
        return { index: Number(index), name, active: active?.trim() === '1' }
      })
      return { session: normalizedSessionName, windows }
    } catch (error) {
      throw new SessionManagementError(500, error.message)
    }
  }

  function deleteSessionWindow({ session = tmuxSession, index }) {
    const normalizedSessionName = String(session || '').trim() || tmuxSession
    const windowId = getTmuxWindowId(normalizedSessionName, index)
    try {
      const windows = readCommandOutput(
        execSyncImpl,
        `tmux list-windows -t ${shellQuote(normalizedSessionName)} -F "#{window_index}" 2>/dev/null`,
      ).split('\n').filter(Boolean)
      if (windows.length <= 1) {
        execSyncImpl(
          `tmux new-window -t ${shellQuote(normalizedSessionName)} -n shell ${shellQuote(defaultInteractiveShell)}`,
          { encoding: 'utf8' },
        )
      }
      execSyncImpl(
        `tmux kill-window -t ${shellQuote(`${normalizedSessionName}:${index}`)}`,
        { encoding: 'utf8' },
      )
      cleanupCodexRuntime(windowId)
      return { ok: true }
    } catch (error) {
      throw new SessionManagementError(500, error.message)
    }
  }

  function attachSessionWindow({ session = tmuxSession, index }) {
    const normalizedSessionName = String(session || '').trim() || tmuxSession
    try {
      execSyncImpl(
        `tmux select-window -t ${shellQuote(`${normalizedSessionName}:${index}`)}`,
        { encoding: 'utf8' },
      )
      try {
        execSyncImpl(
          `tmux set-environment -t ${shellQuote(normalizedSessionName)} NEXUS_LAST_CHANNEL ${index}`,
          { encoding: 'utf8' },
        )
      } catch {}
      return { ok: true }
    } catch (error) {
      throw new SessionManagementError(500, error.message)
    }
  }

  function renameSessionWindow({ session = tmuxSession, index, name }) {
    if (!name) {
      throw new SessionManagementError(400, 'name required')
    }
    const normalizedSessionName = String(session || '').trim() || tmuxSession
    const safeName = String(name).replace(/[^a-zA-Z0-9._-]/g, '-').substring(0, 50)
    try {
      execSyncImpl(
        `tmux rename-window -t ${shellQuote(`${normalizedSessionName}:${index}`)} ${shellQuote(safeName)}`,
        { encoding: 'utf8' },
      )
      return { ok: true, name: safeName }
    } catch (error) {
      throw new SessionManagementError(500, error.message)
    }
  }

  return {
    listTmuxSessions,
    listProjects,
    getSessionCwd,
    listCodexSessions,
    resumeCodexSession,
    deleteProjectCodexSession,
    listProjectChannels,
    createProject,
    createProjectChannel,
    activateProject,
    renameProject,
    deleteProject,
    listSessionWindows,
    deleteSessionWindow,
    attachSessionWindow,
    renameSessionWindow,
  }
}
