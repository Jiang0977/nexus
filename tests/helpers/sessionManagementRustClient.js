import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

import { resolveReleaseBinary } from './runtimeBinaryPath.js'

const DEFAULT_SESSION_RUNTIME_EXECUTABLE = resolveReleaseBinary(import.meta.url, 'nexus-session-runtime')
const DEFAULT_READY_TIMEOUT_MS = 5000

/**
 * @typedef {{
 *   spawnImpl?: typeof spawn,
 *   runtimeExecutable?: string,
 *   runtimeArgs?: string[],
 *   env?: NodeJS.ProcessEnv,
 *   readyTimeoutMs?: number,
 *   log?: Console,
 * }} SessionManagementRustClientOptions
 */

/** @param {SessionManagementRustClientOptions} options */
export function createSessionManagementRustClient(options = {}) {
  const {
    spawnImpl = spawn,
    runtimeExecutable = DEFAULT_SESSION_RUNTIME_EXECUTABLE,
    runtimeArgs = [],
    env = process.env,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    log = console,
  } = options

  const child = spawnImpl(runtimeExecutable, runtimeArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  })

  const pendingRequests = new Map()
  /** @type {(event: any) => void} */
  let eventHandler = () => {}
  let requestCounter = 0
  let closed = false
  let closing = false
  let runtimeStatus = {
    mode: 'rust',
    ready: false,
    source: 'session-management-rust-runtime',
    projectsCreated: 0,
    windowsCreated: 0,
  }

  const stdoutReader = createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  })

  function updateRuntimeStatus(next = {}) {
    if (!next || typeof next !== 'object') return runtimeStatus
    runtimeStatus = {
      ...runtimeStatus,
      ...next,
      mode: 'rust',
    }
    return runtimeStatus
  }

  function buildExitMessage(code, signal) {
    return `session management rust runtime exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
  }

  function rejectPending(error) {
    for (const pending of pendingRequests.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(error)
    }
    pendingRequests.clear()
  }

  function handleChildExit(code, signal) {
    if (closed) return
    closed = true
    const error = new Error(buildExitMessage(code, signal))
    updateRuntimeStatus({
      ready: false,
      error: error.message,
    })
    rejectPending(error)
    if (!closing) {
      eventHandler({ type: 'fatal', message: error.message })
    }
    try {
      stdoutReader.close()
    } catch {}
  }

  stdoutReader.on('line', (line) => {
    if (!line.trim()) return

    /** @type {{ kind?: string, id?: string, ok?: boolean, result?: any, error?: { message?: string }, event?: string, params?: any } | null } */
    let message = null
    try {
      message = JSON.parse(line)
    } catch (error) {
      log.error?.('session management rust runtime sent invalid JSON:', error)
      return
    }

    if (!message || typeof message !== 'object') return

    if (message.kind === 'response') {
      const pending = pendingRequests.get(message.id)
      if (!pending) return
      pendingRequests.delete(message.id)
      if (pending.timer) clearTimeout(pending.timer)

      if (message.ok) {
        if (
          message.result
          && typeof message.result === 'object'
          && ('ready' in message.result || 'capabilities' in message.result || 'projectsCreated' in message.result || 'windowsCreated' in message.result)
        ) {
          updateRuntimeStatus(message.result)
        }
        pending.resolve(message.result)
      } else {
        pending.reject(new Error(message.error?.message || 'session management rust runtime request failed'))
      }
      return
    }

    if (message.kind === 'event') {
      eventHandler({
        type: message.event,
        ...(message.params || {}),
      })
    }
  })

  child.stderr?.on('data', (chunk) => {
    const text = String(chunk).trim()
    if (text) {
      log.error?.('session management rust runtime stderr:', text)
    }
  })

  child.on('error', (error) => {
    if (closed) return
    log.error?.('session management rust runtime process error:', error)
    handleChildExit(null, 'spawn_error')
  })

  child.stdin?.on('error', (error) => {
    if (closed) return
    if (!closing) {
      log.error?.('session management rust runtime stdin error:', error)
    }
    handleChildExit(null, 'stdin_error')
  })

  child.on('exit', (code, signal) => {
    handleChildExit(code, signal)
  })

  function request(method, params = {}, options = {}) {
    if (closed || !child.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
      return Promise.reject(new Error('session management rust runtime is not available'))
    }

    const id = `session_management_rust_req_${++requestCounter}`
    const payload = JSON.stringify({ kind: 'request', id, method, params })
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 0

    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          pendingRequests.delete(id)
          reject(new Error(`session management rust runtime request timed out: ${method}`))
        }, timeoutMs)
        : null

      pendingRequests.set(id, { resolve, reject, timer })
      try {
        child.stdin.write(`${payload}\n`)
      } catch (error) {
        pendingRequests.delete(id)
        if (timer) clearTimeout(timer)
        reject(error)
      }
    })
  }

  return {
    onEvent(handler) {
      eventHandler = typeof handler === 'function' ? handler : () => {}
    },
    ready() {
      return request('ready', {}, { timeoutMs: readyTimeoutMs }).then((status) => updateRuntimeStatus(status))
    },
    getStatus() {
      if (closed) return Promise.resolve(runtimeStatus)
      return request('runtimeStatus', {}, { timeoutMs: readyTimeoutMs }).then((status) => updateRuntimeStatus(status))
    },
    listTmuxSessions() {
      return request('listTmuxSessions')
    },
    listProjects() {
      return request('listProjects')
    },
    getSessionCwd(params) {
      return request('getSessionCwd', params)
    },
    listProjectChannels(params) {
      return request('listProjectChannels', params)
    },
    listSessionWindows(params) {
      return request('listSessionWindows', params)
    },
    activateProject(params) {
      return request('activateProject', params)
    },
    listCodexSessions(params) {
      return request('listCodexSessions', params)
    },
    getCodexSessionDetail(params) {
      return request('getCodexSessionDetail', params)
    },
    resumeCodexSession(params) {
      return request('resumeCodexSession', params)
    },
    deleteProjectCodexSession(params) {
      return request('deleteProjectCodexSession', params)
    },
    createProject(params) {
      return request('createProject', params)
    },
    createProjectChannel(params) {
      return request('createProjectChannel', params)
    },
    createResumeWindow(params) {
      return request('createResumeWindow', params)
    },
    renameProject(params) {
      return request('renameProject', params)
    },
    deleteProject(params) {
      return request('deleteProject', params)
    },
    attachSessionWindow(params) {
      return request('attachSessionWindow', params)
    },
    renameSessionWindow(params) {
      return request('renameSessionWindow', params)
    },
    deleteSessionWindow(params) {
      return request('deleteSessionWindow', params)
    },
    async close() {
      if (closed || closing) return
      closing = true
      try {
        await request('shutdown', {}, { timeoutMs: 1000 })
      } catch {}
      try {
        child.stdin.end()
      } catch {}
      try {
        child.kill?.('SIGTERM')
      } catch {}
    },
  }
}
