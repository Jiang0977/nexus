import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { createInterface } from 'node:readline'

import { resolveReleaseBinary } from './runtimeBinaryPath.js'

const DEFAULT_PTY_RUNTIME_EXECUTABLE = resolveReleaseBinary(import.meta.url, 'nexus-pty-runtime')
const DEFAULT_READY_TIMEOUT_MS = 5000

/**
 * @typedef {{
 *   spawnImpl?: typeof spawn,
 *   runtimeExecutable?: string,
 *   runtimeArgs?: string[],
 *   env?: NodeJS.ProcessEnv,
 *   readyTimeoutMs?: number,
 *   log?: Console,
 * }} PtyBrokerRustClientOptions
 */

/** @param {PtyBrokerRustClientOptions} options */
export function createPtyBrokerRustClient(options = {}) {
  const {
    spawnImpl = spawn,
    runtimeExecutable = DEFAULT_PTY_RUNTIME_EXECUTABLE,
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
    source: 'pty-broker-rust-runtime',
    runningPtys: 0,
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
    return `pty broker rust runtime exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
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
      log.error?.('pty broker rust runtime sent invalid JSON:', error)
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
          && ('ready' in message.result || 'capabilities' in message.result || 'runningPtys' in message.result)
        ) {
          updateRuntimeStatus(message.result)
        }
        pending.resolve(message.result)
      } else {
        pending.reject(new Error(message.error?.message || 'pty broker rust runtime request failed'))
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
      log.error?.('pty broker rust runtime stderr:', text)
    }
  })

  child.on('error', (error) => {
    if (closed) return
    log.error?.('pty broker rust runtime process error:', error)
    handleChildExit(null, 'spawn_error')
  })

  child.stdin?.on('error', (error) => {
    if (closed) return
    if (!closing) {
      log.error?.('pty broker rust runtime stdin error:', error)
    }
    handleChildExit(null, 'stdin_error')
  })

  child.on('exit', (code, signal) => {
    handleChildExit(code, signal)
  })

  function request(method, params = {}, options = {}) {
    if (closed || !child.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
      return Promise.reject(new Error('pty broker rust runtime is not available'))
    }

    const id = `pty_broker_rust_req_${++requestCounter}`
    const payload = JSON.stringify({ kind: 'request', id, method, params })
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 0

    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          pendingRequests.delete(id)
          reject(new Error(`pty broker rust runtime request timed out: ${method}`))
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
    ptyMap: new Map(),
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
    attachConnection(params) {
      return request('attachConnection', params)
    },
    handleConnectionMessage(params) {
      notify('handleConnectionMessage', {
        ...params,
        rawMessage: typeof params?.rawMessage === 'string' ? params.rawMessage : String(params?.rawMessage || ''),
      })
    },
    closeConnection(params) {
      notify('closeConnection', params)
    },
    errorConnection(params) {
      notify('errorConnection', params)
    },
    getOutputSnapshot(params) {
      return request('getOutputSnapshot', params)
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

export function createPtyBrokerSocketClient(options = {}) {
  const {
    socketPath,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    log = console,
  } = options

  const socket = createConnection(socketPath)
  const pendingRequests = new Map()
  let eventHandler = () => {}
  let requestCounter = 0
  let closed = false
  let runtimeStatus = {
    mode: 'rust',
    ready: false,
    source: 'pty-broker-rust-runtime',
    runningPtys: 0,
  }

  const reader = createInterface({
    input: socket,
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

  function rejectPending(error) {
    for (const pending of pendingRequests.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(error)
    }
    pendingRequests.clear()
  }

  reader.on('line', (line) => {
    if (!line.trim()) return

    let message = null
    try {
      message = JSON.parse(line)
    } catch (error) {
      log.error?.('pty broker socket sent invalid JSON:', error)
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
          && ('ready' in message.result || 'capabilities' in message.result || 'runningPtys' in message.result)
        ) {
          updateRuntimeStatus(message.result)
        }
        pending.resolve(message.result)
      } else {
        pending.reject(new Error(message.error?.message || 'pty broker socket request failed'))
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

  socket.on('error', (error) => {
    if (closed) return
    closed = true
    rejectPending(error)
  })

  socket.on('close', () => {
    if (closed) return
    closed = true
    rejectPending(new Error('pty broker socket closed'))
  })

  function request(method, params = {}, options = {}) {
    if (closed || socket.destroyed || socket.writableEnded) {
      return Promise.reject(new Error('pty broker socket is not available'))
    }

    const id = `pty_broker_socket_req_${++requestCounter}`
    const payload = JSON.stringify({ kind: 'request', id, method, params })
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 0

    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          pendingRequests.delete(id)
          reject(new Error(`pty broker socket request timed out: ${method}`))
        }, timeoutMs)
        : null

      pendingRequests.set(id, { resolve, reject, timer })
      socket.write(`${payload}\n`, (error) => {
        if (!error) return
        pendingRequests.delete(id)
        if (timer) clearTimeout(timer)
        reject(error)
      })
    })
  }

  function notify(method, params = {}) {
    if (closed || socket.destroyed || socket.writableEnded) return
    socket.write(`${JSON.stringify({ kind: 'notify', method, params })}\n`)
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
    attachConnection(params) {
      return request('attachConnection', params)
    },
    handleConnectionMessage(params) {
      notify('handleConnectionMessage', {
        ...params,
        rawMessage: typeof params?.rawMessage === 'string' ? params.rawMessage : String(params?.rawMessage || ''),
      })
    },
    closeConnection(params) {
      notify('closeConnection', params)
    },
    errorConnection(params) {
      notify('errorConnection', params)
    },
    getOutputSnapshot(params) {
      return request('getOutputSnapshot', params)
    },
    close() {
      closed = true
      try {
        socket.end()
      } catch {}
      try {
        reader.close()
      } catch {}
    },
  }
}
