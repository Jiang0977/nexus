import { createTaskRunnerLocalBackend } from './taskRunnerLocalBackend.js'

const backend = createTaskRunnerLocalBackend({ log: console })
let shuttingDown = false

function sendMessage(message) {
  if (!process.send) return
  try {
    process.send(message)
  } catch {}
}

backend.onEvent((event) => {
  sendMessage({
    kind: 'event',
    event: event.type,
    params: {
      ...event,
      type: undefined,
    },
  })
})

async function closeAndExit(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  try {
    await backend.close()
  } catch {}
  process.exit(code)
}

async function handleRequest(message) {
  const { id, method, params = {} } = message

  try {
    switch (method) {
      case 'startTask':
        sendMessage({ kind: 'response', id, ok: true, result: await backend.startTask(params) })
        return
      case 'shutdown':
        sendMessage({ kind: 'response', id, ok: true, result: { ok: true } })
        void closeAndExit(0)
        return
      default:
        sendMessage({
          kind: 'response',
          id,
          ok: false,
          error: { message: `unsupported task runner sidecar request: ${method}` },
        })
    }
  } catch (error) {
    sendMessage({
      kind: 'response',
      id,
      ok: false,
      error: { message: error?.message || 'task runner sidecar request failed' },
    })
  }
}

function handleNotify(message) {
  const { method, params = {} } = message

  switch (method) {
    case 'killTask':
      backend.killTask(params)
      return
    default:
      console.warn(`unsupported task runner sidecar notify: ${method}`)
  }
}

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return
  const payload = /** @type {{ kind?: string, id?: string, method?: string, params?: any }} */ (message)
  if (payload.kind === 'request') {
    void handleRequest(payload)
    return
  }
  if (payload.kind === 'notify') {
    handleNotify(payload)
  }
})

process.on('disconnect', () => {
  void closeAndExit(0)
})

process.on('SIGTERM', () => {
  void closeAndExit(0)
})
