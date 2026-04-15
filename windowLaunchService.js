import { exec } from 'node:child_process'

import { shellQuote } from './shellLaunch.js'

export class WindowLaunchError extends Error {
  constructor(statusCode, message, options = {}) {
    super(message)
    this.name = 'WindowLaunchError'
    this.statusCode = statusCode
    this.responseBody = options.responseBody || null
  }
}

/**
 * @typedef {{
 *   tmuxSession: string,
 *   workspaceRoot: string,
 *   execImpl?: typeof exec,
 *   resolveWorkspacePathImpl?: (inputPath: string) => string,
 *   readSessionWorkspacePathImpl?: (sessionName: string) => string,
 *   setTmuxSessionEnvImpl?: (sessionName: string, key: string, value: string) => void,
 *   buildShellCommandImpl?: (shellType: string, profile: string, cwd: string) => { proxyVars: Record<string, string>, shellCmd: string },
 *   ensureTmuxSessionImpl?: (sessionName: string) => void,
 *   applyProxyEnvToSessionImpl?: (sessionName: string, proxyVars: Record<string, string>) => void,
 *   rememberProjectDefaultImpl?: (cwd: string, shellType: string, profile?: string) => void,
 * }} WindowLaunchServiceOptions
 */

function buildWindowName(cwd, fallbackName) {
  return cwd.replace(/^\/+|\/+$/g, '').replace(/\//g, '-') || fallbackName
}

function runExecCommand(execImpl, command) {
  return new Promise((resolve, reject) => {
    execImpl(command, (error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

/** @param {WindowLaunchServiceOptions} options */
export function createWindowLaunchService(options) {
  const {
    tmuxSession,
    workspaceRoot,
    execImpl = exec,
    resolveWorkspacePathImpl = (inputPath) => {
      if (!inputPath) return workspaceRoot
      return String(inputPath).startsWith('/') ? String(inputPath) : `${workspaceRoot}/${inputPath}`
    },
    readSessionWorkspacePathImpl = () => workspaceRoot,
    setTmuxSessionEnvImpl = () => {},
    buildShellCommandImpl = () => ({ proxyVars: {}, shellCmd: 'exec zsh -i' }),
    ensureTmuxSessionImpl = () => {},
    applyProxyEnvToSessionImpl = () => {},
    rememberProjectDefaultImpl = () => {},
  } = options

  async function createWindow({
    relPath,
    profile,
    shellType,
    sessionName = tmuxSession,
    updateSessionCwd = false,
    fallbackName,
  }) {
    let cwd = workspaceRoot
    if (relPath) {
      cwd = resolveWorkspacePathImpl(relPath)
    } else {
      cwd = readSessionWorkspacePathImpl(sessionName)
    }

    if (updateSessionCwd && relPath) {
      try {
        setTmuxSessionEnvImpl(sessionName, 'NEXUS_CWD', cwd)
      } catch (error) {
        throw new WindowLaunchError(500, `failed to set NEXUS_CWD: ${error.message}`)
      }
    }

    const name = buildWindowName(cwd, fallbackName)
    const { proxyVars, shellCmd } = buildShellCommandImpl(shellType, profile, cwd)
    ensureTmuxSessionImpl(sessionName)
    applyProxyEnvToSessionImpl(sessionName, proxyVars)

    try {
      await runExecCommand(
        execImpl,
        `tmux new-window -t ${shellQuote(sessionName)} -c ${shellQuote(cwd)} -n ${shellQuote(name)} ${shellQuote(shellCmd)}`,
      )
    } catch (error) {
      throw new WindowLaunchError(500, error.message)
    }

    rememberProjectDefaultImpl(cwd, shellType, profile)
    return {
      name,
      cwd,
      shell_type: shellType,
      profile: profile || null,
      session: sessionName,
    }
  }

  async function launchWindow({ relPath, profile, shellType, sessionName = tmuxSession }) {
    return createWindow({
      relPath,
      profile,
      shellType,
      sessionName,
      updateSessionCwd: Boolean(relPath),
      fallbackName: 'window',
    })
  }

  async function createSessionWindow({ relPath, profile, shellType, sessionName = tmuxSession }) {
    if (!relPath) {
      throw new WindowLaunchError(400, 'rel_path required')
    }
    return createWindow({
      relPath,
      profile,
      shellType,
      sessionName,
      updateSessionCwd: false,
      fallbackName: 'session',
    })
  }

  return {
    launchWindow,
    createSessionWindow,
  }
}
