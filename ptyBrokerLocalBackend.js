import { createPtyTmuxBroker } from './ptyTmuxBroker.js'

/**
 * @typedef {{
 *   type: 'output',
 *   connectionId: string,
 *   data: string,
 * } | {
 *   type: 'fatal',
 *   message: string,
 * }} PtyBrokerBackendEvent
 */

/**
 * @typedef {{
 *   onEvent: (handler: (event: PtyBrokerBackendEvent) => void) => void,
 *   attachConnection: (params: { connectionId: string, session: string, windowIndex: number }) => Promise<{ key: string } | { error: string }>,
 *   handleConnectionMessage: (params: { connectionId: string, key: string, rawMessage: string | Buffer }) => void,
 *   closeConnection: (params: { connectionId: string, key: string }) => void,
 *   errorConnection: (params: { connectionId: string, key: string }) => void,
 *   getOutputSnapshot: (params: { session: string, windowIndex: number }) => Promise<{ connected: boolean, output: string, clients: number, idleMs?: number }>,
 *   close: () => Promise<void>,
 *   ptyMap: Map<string, any>,
 * }} PtyBrokerBackend
 */

/** @param {object} options */
export function createPtyBrokerLocalBackend(options = {}) {
  const broker = createPtyTmuxBroker(options)
  const clientsByConnectionId = new Map()
  /** @type {(event: PtyBrokerBackendEvent) => void} */
  let eventHandler = () => {}

  function emit(event) {
    eventHandler(event)
  }

  function buildClient(connectionId) {
    return {
      id: connectionId,
      readyState: 1,
      send(data) {
        emit({ type: 'output', connectionId, data: String(data) })
      },
    }
  }

  function getClient(connectionId) {
    let client = clientsByConnectionId.get(connectionId)
    if (!client) {
      client = buildClient(connectionId)
      clientsByConnectionId.set(connectionId, client)
    }
    return client
  }

  return {
    ptyMap: broker.ptyMap,
    onEvent(handler) {
      eventHandler = typeof handler === 'function' ? handler : () => {}
    },
    async attachConnection({ connectionId, session, windowIndex }) {
      const client = getClient(connectionId)
      client.readyState = 1
      const attached = broker.attachClient(session, windowIndex, client)
      if (attached.error) return attached
      return { key: attached.key }
    },
    handleConnectionMessage({ connectionId, key, rawMessage }) {
      const client = clientsByConnectionId.get(connectionId)
      if (!client) return
      broker.handleClientMessage(key, client, rawMessage)
    },
    closeConnection({ connectionId, key }) {
      const client = clientsByConnectionId.get(connectionId)
      if (!client) return
      client.readyState = 3
      broker.handleClientClose(key, client)
      clientsByConnectionId.delete(connectionId)
    },
    errorConnection({ connectionId, key }) {
      const client = clientsByConnectionId.get(connectionId)
      if (!client) return
      client.readyState = 3
      broker.handleClientError(key, client)
      clientsByConnectionId.delete(connectionId)
    },
    async getOutputSnapshot({ session, windowIndex }) {
      const entry = broker.getEntry(broker.ptyKey(session, windowIndex))
      if (!entry) {
        return { connected: false, output: '', clients: 0 }
      }
      return {
        connected: true,
        output: entry.lastOutput.slice(-2000),
        clients: entry.clients.size,
        idleMs: Date.now() - entry.lastActivity,
      }
    },
    async close() {
      for (const entry of broker.ptyMap.values()) {
        try {
          entry?.pty?.kill?.('SIGTERM')
        } catch {}
      }
      broker.ptyMap.clear()
      clientsByConnectionId.clear()
    },
  }
}
