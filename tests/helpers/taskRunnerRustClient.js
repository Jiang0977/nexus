import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

import { resolveReleaseBinary } from './runtimeBinaryPath.js'

const DEFAULT_TASK_RUNTIME_EXECUTABLE = resolveReleaseBinary(import.meta.url, 'nexus-task-runtime')
const DEFAULT_READY_TIMEOUT_MS = 5000

/**
 * @typedef {{
 *   spawnImpl?: typeof spawn,
 *   runtimeExecutable?: string,
 *   runtimeArgs?: string[],
 *   env?: NodeJS.ProcessEnv,
 *   readyTimeoutMs?: number,
 *   log?: Console,
 * }} TaskRunnerRustClientOptions
 */

/** @param {TaskRunnerRustClientOptions} options */
export function createTaskRunnerRustClient(options = {}) {
  const {
    spawnImpl = spawn,
    runtimeExecutable = DEFAULT_TASK_RUNTIME_EXECUTABLE,
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
    source: 'task-runner-rust-runtime',
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
    return `task runner rust runtime exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
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

    /** @type {{ kind?: string, id?: string, ok?: boolean, result?: any, error?: { message?: string }, event?: string, params?: any } | null} */
    let message = null
    try {
      message = JSON.parse(line)
    } catch (error) {
      log.error?.('task runner rust runtime sent invalid JSON:', error)
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
          && ('ready' in message.result || 'capabilities' in message.result || 'runningTasks' in message.result)
        ) {
          updateRuntimeStatus(message.result)
        }
        pending.resolve(message.result)
      } else {
        pending.reject(new Error(message.error?.message || 'task runner rust runtime request failed'))
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
      log.error?.('task runner rust runtime stderr:', text)
    }
  })

  child.on('error', (error) => {
    if (closed) return
    log.error?.('task runner rust runtime process error:', error)
    handleChildExit(null, 'spawn_error')
  })

  child.stdin?.on('error', (error) => {
    if (closed) return
    if (!closing) {
      log.error?.('task runner rust runtime stdin error:', error)
    }
    handleChildExit(null, 'stdin_error')
  })

  child.on('exit', (code, signal) => {
    handleChildExit(code, signal)
  })

  function request(method, params = {}, options = {}) {
    if (closed || !child.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
      return Promise.reject(new Error('task runner rust runtime is not available'))
    }

    const id = `task_runner_rust_req_${++requestCounter}`
    const payload = JSON.stringify({ kind: 'request', id, method, params })
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 0

    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          pendingRequests.delete(id)
          reject(new Error(`task runner rust runtime request timed out: ${method}`))
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

  function notify(method, params = {}) {
    if (closed || !child.stdin || child.stdin.destroyed || child.stdin.writableEnded) return
    try {
      child.stdin.write(`${JSON.stringify({ kind: 'notify', method, params })}\n`)
    } catch {}
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
    startTask(params) {
      return request('startTask', params)
    },
    killTask(params) {
      notify('killTask', params)
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
