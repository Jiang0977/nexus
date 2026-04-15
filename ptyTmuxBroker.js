import * as pty from 'node-pty'
import { execSync } from 'node:child_process'

import { sanitizeInteractiveEnv } from './interactiveEnv.js'
import { resolvePassiveAttachTarget } from './tmuxSessionPolicy.js'

const DEFAULT_IDLE_CLEANUP_MS = 300000
const DEFAULT_RECREATE_DELAY_MS = 100
const MAX_OUTPUT_BUFFER = 10000
const RECENT_OUTPUT_REPLAY = 2000

export function createPtyTmuxBroker({
  execSyncImpl = execSync,
  ptyImpl = pty,
  sanitizeEnv = sanitizeInteractiveEnv,
  resolveAttachTarget = resolvePassiveAttachTarget,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  envSource = process.env,
  log = console,
  idleCleanupMs = DEFAULT_IDLE_CLEANUP_MS,
  recreateDelayMs = DEFAULT_RECREATE_DELAY_MS,
} = {}) {
  const ptyMap = new Map()

  function ptyKey(session, windowIndex) {
    return `${session}:${windowIndex}`
  }

  function getEntry(key) {
    return ptyMap.get(key)
  }

  function tmuxSessionExists(session) {
    try {
      execSyncImpl(`tmux has-session -t ${session} 2>/dev/null`)
      return true
    } catch {
      return false
    }
  }

  function listWindowIndices(session) {
    try {
      const output = execSyncImpl(`tmux list-windows -t ${session} -F "#I"`).toString().trim()
      if (!output) return []
      return output
        .split('\n')
        .map((line) => Number.parseInt(line, 10))
        .filter((index) => Number.isInteger(index) && index >= 0)
    } catch {
      return []
    }
  }

  function clearIdleTimer(entry) {
    if (entry?.idleTimer) {
      clearTimeoutImpl(entry.idleTimer)
      entry.idleTimer = null
    }
  }

  function scheduleIdleCleanup(key, entry) {
    clearIdleTimer(entry)
    entry.idleTimer = setTimeoutImpl(() => {
      const current = ptyMap.get(key)
      if (!current) return
      if (current.clients.size === 0 && Date.now() - current.lastActivity > idleCleanupMs) {
        current.pty.kill('SIGTERM')
        ptyMap.delete(key)
        log.log(`PTY ${key} cleaned up (idle)`)
      }
    }, idleCleanupMs)
  }

  function ensureWindowPty(session, windowIndex) {
    const requestedKey = ptyKey(session, windowIndex)
    if (ptyMap.has(requestedKey)) return { key: requestedKey, entry: ptyMap.get(requestedKey) }

    const target = resolveAttachTarget({
      sessionExists: tmuxSessionExists(session),
      existingWindows: listWindowIndices(session),
      requestedWindowIndex: windowIndex,
    })
    if (!target.ok) return { error: target.reason }

    const targetWindow = target.windowIndex
    const actualKey = ptyKey(session, targetWindow)
    if (ptyMap.has(actualKey)) return { key: actualKey, entry: ptyMap.get(actualKey) }

    const ptyProc = ptyImpl.spawn('tmux', ['attach-session', '-t', `${session}:${targetWindow}`], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      env: sanitizeEnv(envSource, { LANG: 'C.UTF-8', TERM: 'xterm-256color' }),
    })

    const entry = {
      pty: ptyProc,
      clients: new Set(),
      clientSizes: new Map(),
      lastOutput: '',
      lastActivity: Date.now(),
      idleTimer: null,
    }
    ptyMap.set(actualKey, entry)

    ptyProc.onData((data) => {
      const current = ptyMap.get(actualKey)
      if (!current) return
      current.lastOutput = (current.lastOutput + data).slice(-MAX_OUTPUT_BUFFER)
      current.lastActivity = Date.now()
      for (const client of current.clients) {
        if (client.readyState === 1) client.send(data)
      }
    })

    ptyProc.onExit(({ exitCode }) => {
      log.log(`PTY ${actualKey} exited with code ${exitCode}`)
      ptyMap.delete(actualKey)
      try {
        const windows = listWindowIndices(session)
        if (windows.includes(targetWindow)) {
          setTimeoutImpl(() => ensureWindowPty(session, targetWindow), recreateDelayMs)
        }
      } catch {}
    })

    return { key: actualKey, entry }
  }

  function attachClient(session, windowIndex, client) {
    const ensured = ensureWindowPty(session, windowIndex)
    if (ensured.error) return ensured

    const { key, entry } = ensured
    clearIdleTimer(entry)
    entry.clients.add(client)

    if (entry.lastOutput) {
      client.send(entry.lastOutput.slice(-RECENT_OUTPUT_REPLAY))
    }

    return { key, entry }
  }

  function handleClientMessage(key, client, rawMessage) {
    const entry = ptyMap.get(key)
    if (!entry) return

    const message = typeof rawMessage === 'string' ? rawMessage : rawMessage.toString()
    let isResize = false

    try {
      const data = JSON.parse(message)
      if (data && data.type === 'resize' && data.cols && data.rows) {
        isResize = true
        const cols = Number(data.cols)
        const rows = Number(data.rows)
        entry.clientSizes.set(client, { cols, rows })
        entry.pty.resize(Math.max(cols, 10), Math.max(rows, 5))
      }
    } catch {}

    if (!isResize) entry.pty.write(message)
  }

  function handleClientClose(key, client) {
    const entry = ptyMap.get(key)
    if (!entry) return

    entry.clients.delete(client)
    entry.clientSizes.delete(client)

    if (entry.clients.size > 0 && entry.clientSizes.size > 0) {
      let minCols = Infinity
      let minRows = Infinity
      for (const size of entry.clientSizes.values()) {
        if (size.cols < minCols) minCols = size.cols
        if (size.rows < minRows) minRows = size.rows
      }
      if (minCols !== Infinity) {
        entry.pty.resize(Math.max(minCols, 10), Math.max(minRows, 5))
      }
    } else if (entry.clients.size === 0) {
      scheduleIdleCleanup(key, entry)
    }
  }

  function handleClientError(key, client) {
    const entry = ptyMap.get(key)
    if (!entry) return
    entry.clients.delete(client)
    entry.clientSizes.delete(client)
  }

  return {
    ptyMap,
    ptyKey,
    getEntry,
    ensureWindowPty,
    attachClient,
    handleClientMessage,
    handleClientClose,
    handleClientError,
  }
}
