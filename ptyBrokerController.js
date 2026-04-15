import { createPtyBrokerLocalBackend } from './ptyBrokerLocalBackend.js'
import { createPtyBrokerSidecarClient } from './ptyBrokerSidecarClient.js'

/**
 * @typedef {{
 *   mode?: string,
 *   createLocalBackend?: (options?: object) => any,
 *   createSidecarBackend?: (options?: object) => any,
 *   backendOptions?: object,
 *   log?: Console,
 * }} PtyBrokerControllerOptions
 */

/** @param {PtyBrokerControllerOptions} options */
export function createPtyBrokerController(options = {}) {
  const {
    mode = 'local',
    createLocalBackend = createPtyBrokerLocalBackend,
    createSidecarBackend = createPtyBrokerSidecarClient,
    backendOptions = {},
    log = console,
  } = options

  const backend = mode === 'sidecar'
    ? createSidecarBackend({ log, ...backendOptions })
    : createLocalBackend({ log, ...backendOptions })

  const wsStateByClient = new WeakMap()
  const wsByConnectionId = new Map()
  const connectionsByKey = new Map()
  let connectionCounter = 0

  function addConnection(key, connectionId) {
    let connections = connectionsByKey.get(key)
    if (!connections) {
      connections = new Set()
      connectionsByKey.set(key, connections)
    }
    connections.add(connectionId)
    return connections.size
  }

  function removeConnection(key, connectionId) {
    const connections = connectionsByKey.get(key)
    if (!connections) return 0
    connections.delete(connectionId)
    if (connections.size === 0) {
      connectionsByKey.delete(key)
      return 0
    }
    return connections.size
  }

  function closeAllClients(reason = 'broker unavailable') {
    for (const ws of wsByConnectionId.values()) {
      try {
        ws.close?.(1011, reason)
      } catch {}
    }
    wsByConnectionId.clear()
    connectionsByKey.clear()
  }

  backend.onEvent((event) => {
    if (!event || typeof event !== 'object') return

    if (event.type === 'output') {
      const ws = wsByConnectionId.get(event.connectionId)
      if (!ws || ws.readyState !== 1) return
      try {
        ws.send(event.data)
      } catch {}
      return
    }

    if (event.type === 'fatal') {
      log.error?.(event.message || 'broker controller fatal event')
      closeAllClients()
    }
  })

  function getClientState(ws) {
    return wsStateByClient.get(ws) || null
  }

  return {
    ptyMap: backend.ptyMap || new Map(),
    async attachClient(session, windowIndex, ws) {
      const connectionId = `broker_conn_${++connectionCounter}`
      const attached = await backend.attachConnection({
        connectionId,
        session,
        windowIndex,
      })
      if (attached?.error) return attached

      wsStateByClient.set(ws, { connectionId, key: attached.key })
      wsByConnectionId.set(connectionId, ws)
      const clientsCount = addConnection(attached.key, connectionId)

      return {
        key: attached.key,
        clientsCount,
      }
    },
    handleClientMessage(key, ws, rawMessage) {
      const state = getClientState(ws)
      if (!state) return
      backend.handleConnectionMessage({
        connectionId: state.connectionId,
        key: state.key || key,
        rawMessage,
      })
    },
    handleClientClose(key, ws) {
      const state = getClientState(ws)
      if (!state) return { clientsCount: 0 }

      wsStateByClient.delete(ws)
      wsByConnectionId.delete(state.connectionId)
      const clientsCount = removeConnection(state.key, state.connectionId)
      backend.closeConnection({
        connectionId: state.connectionId,
        key: state.key || key,
      })
      return { clientsCount }
    },
    handleClientError(key, ws) {
      const state = getClientState(ws)
      if (!state) return { clientsCount: 0 }

      wsStateByClient.delete(ws)
      wsByConnectionId.delete(state.connectionId)
      const clientsCount = removeConnection(state.key, state.connectionId)
      backend.errorConnection({
        connectionId: state.connectionId,
        key: state.key || key,
      })
      return { clientsCount }
    },
    getOutputSnapshot(session, windowIndex) {
      return backend.getOutputSnapshot({ session, windowIndex })
    },
    async close() {
      closeAllClients()
      await backend.close?.()
    },
  }
}
