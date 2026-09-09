import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const mode = process.env.FAKE_PTY_RUNTIME_MODE || 'normal'
const state = {
  ready: true,
  source: 'fake-pty-rust-runtime',
  version: '0.0-test',
  capabilities: {
    terminal: true,
    admin: true,
  },
  runningPtys: 0,
}
const entries = new Map()
const connections = new Map()

function preloadEntries() {
  const raw = process.env.FAKE_PTY_RUNTIME_SNAPSHOT_JSON || ''
  if (!raw) return

  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return

    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') continue
      const entry = {
        key,
        output: String(value.output || ''),
        outputSnapshot: typeof value.outputSnapshot === 'string' ? value.outputSnapshot : undefined,
        scrollbackSnapshot: typeof value.scrollbackSnapshot === 'string' ? value.scrollbackSnapshot : undefined,
        clients: new Set(),
      }
      const clientCount = Number(value.clients || 0)
      for (let index = 0; index < clientCount; index += 1) {
        entry.clients.add(`preloaded-${key}-${index}`)
      }
      entries.set(key, entry)
    }
    state.runningPtys = entries.size
  } catch {}
}

if (mode === 'exit-immediately') {
  process.exit(7)
}

preloadEntries()

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function response(id, ok, resultOrError) {
  if (ok) {
    send({ kind: 'response', id, ok: true, result: resultOrError })
    return
  }
  send({ kind: 'response', id, ok: false, error: resultOrError })
}

function event(eventName, params) {
  send({ kind: 'event', event: eventName, params })
}

function unicodeTail(value, maxChars) {
  const chars = Array.from(String(value))
  const limit = Number(maxChars)
  if (!Number.isFinite(limit) || limit < 0) return String(value)
  const count = Math.floor(limit)
  if (chars.length <= count) return String(value)
  return chars.slice(-count).join('')
}

function ensureEntry(session, windowIndex) {
  const key = `${session}:${windowIndex}`
  let entry = entries.get(key)
  if (!entry) {
    entry = {
      key,
      output: '',
      clients: new Set(),
    }
    entries.set(key, entry)
    state.runningPtys = entries.size
  }
  return entry
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  if (!line.trim()) return

  let message = null
  try {
    message = JSON.parse(line)
  } catch {
    return
  }

  if (message.kind === 'request') {
    const { id, method, params = {} } = message

    switch (method) {
      case 'ready':
        if (mode === 'exit-before-ready') process.exit(9)
        if (mode === 'hang-ready') return
        response(id, true, state)
        return
      case 'runtimeStatus':
        response(id, true, state)
        return
      case 'attachConnection': {
        const entry = ensureEntry(params.session, params.windowIndex)
        entry.clients.add(params.connectionId)
        connections.set(params.connectionId, entry.key)
        if (mode === 'tmux-redraw') {
          const requestLog = process.env.FAKE_PTY_RUNTIME_REQUEST_LOG
          if (requestLog) appendFileSync(requestLog, `${JSON.stringify({ method, params })}\n`)
          // Deliberately emit before the attach response to exercise server ordering.
          const frames = params.session === 'lag' ? 300 : 1
          for (let index = 0; index < frames; index++) {
            event('output', { connectionId: params.connectionId, data: 'INITIAL_REDRAW' })
          }
        }
        response(id, true, { key: entry.key, ...(mode === 'tmux-redraw' ? { replayPolicy: 'tmux-redraw' } : {}) })
        if (entry.output) {
          event('output', {
            connectionId: params.connectionId,
            data: entry.output,
          })
        }
        return
      }
      case 'getOutputSnapshot': {
        const requestLog = process.env.FAKE_PTY_RUNTIME_REQUEST_LOG
        if (requestLog) {
          try {
            appendFileSync(requestLog, `${JSON.stringify({ method: 'getOutputSnapshot', params })}\n`)
          } catch {}
        }
        const key = `${params.session}:${params.windowIndex}`
        const entry = entries.get(key)
        let output = ''
        let connected = false
        let clients = 0
        if (entry && typeof entry.outputSnapshot === 'string') {
          output = entry.outputSnapshot
          connected = true
          clients = entry.clients.size
        } else if (entry) {
          output = entry.output
          connected = true
          clients = entry.clients.size
        }
        if (params.tailChars !== undefined && params.tailChars !== null) {
          output = unicodeTail(output, params.tailChars)
        }
        response(id, true, connected
          ? { connected: true, output, clients, idleMs: 0 }
          : { connected: false, output, clients: 0 })
        return
      }
      case 'getScrollbackSnapshot': {
        const key = `${params.session}:${params.windowIndex}`
        const entry = entries.get(key)
        if (entry && typeof entry.scrollbackSnapshot === 'string') {
          response(id, true, { connected: true, output: entry.scrollbackSnapshot, clients: entry.clients.size, idleMs: 0 })
          return
        }
        response(id, true, entry
          ? { connected: true, output: entry.output, clients: entry.clients.size, idleMs: 0 }
          : { connected: false, output: '', clients: 0 })
        return
      }
      case 'shutdown':
        response(id, true, { ok: true })
        process.exit(0)
        return
      default:
        response(id, false, { message: `unsupported method: ${method}` })
        return
    }
  }

  if (message.kind === 'notify') {
    const { method, params = {} } = message
    if (method === 'handleConnectionMessage') {
      const entry = entries.get(params.key) || ensureEntry('main', 0)
      const raw = String(params.rawMessage || '')
      if (mode === 'tmux-redraw' && raw === '__client_exit__') {
        event('connectionClosed', { connectionId: params.connectionId })
        return
      }
      if (mode === 'tmux-redraw' && raw === '__fatal__') {
        event('fatal', { message: 'fixture fatal' })
        return
      }
      if (!raw.includes('resize')) {
        entry.output += raw
        for (const connectionId of entry.clients) {
          event('output', { connectionId, data: raw })
        }
      }
      return
    }

    if (method === 'closeConnection' || method === 'errorConnection') {
      const key = connections.get(params.connectionId)
      if (!key) return
      const entry = entries.get(key)
      if (!entry) return
      entry.clients.delete(params.connectionId)
      connections.delete(params.connectionId)
      if (entry.clients.size === 0) {
        entries.delete(key)
        state.runningPtys = entries.size
      }
    }
  }
})

process.on('SIGTERM', () => process.exit(0))
