import { createInterface } from 'node:readline'

const mode = process.env.FAKE_WINDOW_LAUNCH_RUNTIME_MODE || 'normal'
const state = {
  ready: true,
  source: 'fake-window-launch-rust-runtime',
  version: '0.0-test',
  capabilities: {
    launch: true,
    admin: true,
  },
  launches: 0,
}

if (mode === 'exit-immediately') {
  process.exit(7)
}

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

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  if (!line.trim()) return

  let message = null
  try {
    message = JSON.parse(line)
  } catch {
    return
  }

  if (message.kind !== 'request') return

  const { id, method } = message
  switch (method) {
    case 'ready':
      if (mode === 'exit-before-ready') process.exit(9)
      if (mode === 'hang-ready') return
      response(id, true, state)
      return
    case 'runtimeStatus':
      response(id, true, state)
      return
    case 'launchWindow':
      state.launches += 1
      response(id, true, { ok: true })
      return
    case 'shutdown':
      response(id, true, { ok: true })
      process.exit(0)
      return
    default:
      response(id, false, { message: `unsupported method: ${method}` })
      return
  }
})

process.on('SIGTERM', () => process.exit(0))
