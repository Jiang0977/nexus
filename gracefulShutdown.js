function closeTarget(target) {
  return new Promise((resolve) => {
    if (!target || typeof target.close !== 'function') {
      resolve()
      return
    }

    let resolved = false
    const done = () => {
      if (resolved) return
      resolved = true
      resolve()
    }

    try {
      target.close(done)
    } catch {
      done()
    }
  })
}

function killPtys(ptys, signal = 'SIGTERM') {
  for (const pty of ptys) {
    try {
      pty?.kill?.(signal)
    } catch {}
  }
}

function killChildren(children, signal = 'SIGTERM') {
  for (const child of children) {
    try {
      if (!child?.killed) child?.kill?.(signal)
    } catch {}
  }
}

function closeClients(clients) {
  for (const client of clients) {
    try {
      client?.close?.(1001, 'server shutdown')
    } catch {}
  }
}

function terminateClients(clients) {
  for (const client of clients) {
    try {
      client?.terminate?.()
    } catch {}
  }
}

export function createGracefulShutdown({
  server,
  wss,
  ptyMap,
  taskChildren,
  exit = (code) => process.exit(code),
  log = console,
  forceExitTimeoutMs = 10000,
}) {
  let shutdownPromise = null

  return function shutdown(signal = 'SIGTERM') {
    if (shutdownPromise) return shutdownPromise

    const trackedPtys = [...ptyMap.values()].map((entry) => entry?.pty).filter(Boolean)
    const trackedChildren = [...taskChildren]
    const trackedClients = [...(wss?.clients ?? [])]

    ptyMap.clear?.()
    taskChildren.clear?.()

    log.log(`Received ${signal}, shutting down Nexus...`)
    killPtys(trackedPtys)
    killChildren(trackedChildren)
    closeClients(trackedClients)

    let forceTimer = null
    if (forceExitTimeoutMs > 0) {
      forceTimer = setTimeout(() => {
        log.error(`Graceful shutdown timed out after ${forceExitTimeoutMs}ms; forcing exit.`)
        killPtys(trackedPtys, 'SIGKILL')
        killChildren(trackedChildren, 'SIGKILL')
        terminateClients(trackedClients)
        exit(1)
      }, forceExitTimeoutMs)
      forceTimer.unref?.()
    }

    shutdownPromise = Promise.allSettled([
      closeTarget(wss),
      closeTarget(server),
    ]).then(() => {
      if (forceTimer) clearTimeout(forceTimer)
      exit(0)
    })

    return shutdownPromise
  }
}
