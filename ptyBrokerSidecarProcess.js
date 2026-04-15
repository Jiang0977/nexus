import { createPtyBrokerLocalBackend } from './ptyBrokerLocalBackend.js'

const backend = createPtyBrokerLocalBackend({ log: console })
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
      case 'attachConnection':
        sendMessage({ kind: 'response', id, ok: true, result: await backend.attachConnection(params) })
        return
      case 'getOutputSnapshot':
        sendMessage({ kind: 'response', id, ok: true, result: await backend.getOutputSnapshot(params) })
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
          error: { message: `unsupported broker sidecar request: ${method}` },
        })
    }
  } catch (error) {
    sendMessage({
      kind: 'response',
      id,
      ok: false,
      error: { message: error?.message || 'broker sidecar request failed' },
    })
  }
}

function handleNotify(message) {
  const { method, params = {} } = message

  switch (method) {
    case 'handleConnectionMessage':
      backend.handleConnectionMessage(params)
      return
    case 'closeConnection':
      backend.closeConnection(params)
      return
    case 'errorConnection':
      backend.errorConnection(params)
      return
    default:
      console.warn(`unsupported broker sidecar notify: ${method}`)
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
