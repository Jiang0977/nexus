export function installRuntimeGuards({
  processLike = process,
  server,
  shutdown,
  signals = ['SIGTERM', 'SIGINT'],
  exit = (code) => process.exit(code),
  log = console,
}) {
  const removers = []

  for (const signal of signals) {
    const onSignal = () => {
      Promise.resolve()
        .then(() => shutdown(signal))
        .catch((error) => {
          log.error(`Graceful shutdown failed after ${signal}:`, error)
          exit(1)
        })
    }
    processLike.on(signal, onSignal)
    removers.push(() => processLike.off?.(signal, onSignal))
  }

  const onUncaughtException = (error) => {
    log.error('Uncaught Exception:', error)
    exit(1)
  }
  processLike.on('uncaughtException', onUncaughtException)
  removers.push(() => processLike.off?.('uncaughtException', onUncaughtException))

  const onUnhandledRejection = (reason) => {
    log.error('Unhandled Rejection:', reason)
    exit(1)
  }
  processLike.on('unhandledRejection', onUnhandledRejection)
  removers.push(() => processLike.off?.('unhandledRejection', onUnhandledRejection))

  if (server?.on) {
    const onServerError = (error) => {
      log.error('Server error:', error)
      exit(1)
    }
    server.on('error', onServerError)
    removers.push(() => server.off?.('error', onServerError))
  }

  return () => {
    for (const remove of removers) remove()
  }
}
