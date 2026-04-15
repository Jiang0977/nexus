import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_SIDECAR_PATH = join(dirname(fileURLToPath(import.meta.url)), 'taskRunnerSidecarProcess.js')

/**
 * @typedef {{
 *   spawnChildImpl?: (options: { nodeExecutable: string, sidecarProcessPath: string, env: NodeJS.ProcessEnv, log?: Console }) => any,
 *   nodeExecutable?: string,
 *   sidecarProcessPath?: string,
 *   env?: NodeJS.ProcessEnv,
 *   taskChildren?: Set<any>,
 *   log?: Console,
 * }} TaskRunnerSidecarClientOptions
 */

function defaultSpawnChild({ nodeExecutable, sidecarProcessPath, env }) {
  return spawn(nodeExecutable, [sidecarProcessPath], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env,
  })
}

/** @param {TaskRunnerSidecarClientOptions} options */
export function createTaskRunnerSidecarClient(options = {}) {
  const {
    spawnChildImpl = defaultSpawnChild,
    nodeExecutable = process.execPath,
    sidecarProcessPath = DEFAULT_SIDECAR_PATH,
    env = process.env,
    taskChildren = null,
    log = console,
  } = options

  const child = spawnChildImpl({
    nodeExecutable,
    sidecarProcessPath,
    env,
    log,
  })

  taskChildren?.add?.(child)

  const pendingRequests = new Map()
  /** @type {(event: any) => void} */
  let eventHandler = () => {}
  let requestCounter = 0
  let closed = false
  let closing = false

  function buildExitMessage(code, signal) {
    return `task runner sidecar exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
  }

  function rejectPending(error) {
    for (const pending of pendingRequests.values()) {
      pending.reject(error)
    }
    pendingRequests.clear()
  }

  function handleChildExit(code, signal) {
    taskChildren?.delete?.(child)
    if (closed) return
    closed = true
    const error = new Error(buildExitMessage(code, signal))
    rejectPending(error)
    if (!closing) {
      eventHandler({ type: 'fatal', message: error.message })
    }
  }

  child.on('message', (message) => {
    if (!message || typeof message !== 'object') return

    if (message.kind === 'response') {
      const pending = pendingRequests.get(message.id)
      if (!pending) return
      pendingRequests.delete(message.id)
      if (message.ok) {
        pending.resolve(message.result)
      } else {
        pending.reject(new Error(message.error?.message || 'task runner sidecar request failed'))
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

  child.on('error', (error) => {
    if (closed) return
    log.error?.('task runner sidecar process error:', error)
    handleChildExit(null, 'spawn_error')
  })

  child.on('exit', (code, signal) => {
    handleChildExit(code, signal)
  })

  function request(method, params) {
    if (closed) {
      return Promise.reject(new Error('task runner sidecar is not available'))
    }

    const id = `task_runner_req_${++requestCounter}`
    const payload = { kind: 'request', id, method, params }

    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject })
      try {
        child.send(payload)
      } catch (error) {
        pendingRequests.delete(id)
        reject(error)
      }
    })
  }

  function notify(method, params) {
    if (closed) return
    try {
      child.send({ kind: 'notify', method, params })
    } catch {}
  }

  return {
    onEvent(handler) {
      eventHandler = typeof handler === 'function' ? handler : () => {}
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
        await request('shutdown', {})
      } catch {}
      try {
        child.kill?.('SIGTERM')
      } catch {}
    },
  }
}
