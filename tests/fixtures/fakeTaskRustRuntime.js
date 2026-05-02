import { createInterface } from 'node:readline'

const mode = process.env.FAKE_TASK_RUNTIME_MODE || 'normal'
const defaultDelayMs = Number.parseInt(process.env.FAKE_TASK_RUNTIME_DELAY_MS || '10', 10)
const readyPayload = {
  ready: true,
  source: 'fake-task-rust-runtime',
  version: '0.0-test',
  capabilities: {
    tasks: true,
    admin: true,
  },
}

if (mode === 'exit-immediately') {
  process.exit(7)
}

const timers = new Map()
let runningTasks = 0

function parseChunkList(envKey) {
  const raw = process.env[envKey]
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : null
  } catch {
    return null
  }
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

function event(eventName, params) {
  send({ kind: 'event', event: eventName, params })
}

function runtimeStatus() {
  return {
    ...readyPayload,
    runningTasks,
  }
}

function finishTask(taskId, exitCode, errorMessage = '') {
  if (timers.has(taskId)) {
    clearTimeout(timers.get(taskId))
    timers.delete(taskId)
  }
  if (runningTasks > 0) runningTasks -= 1
  event('done', {
    taskId,
    exitCode,
    ...(errorMessage ? { errorMessage } : {}),
  })
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
        if (mode === 'hang-ready') return
        if (mode === 'exit-before-ready') {
          process.exit(9)
        }
        response(id, true, runtimeStatus())
        return
      case 'runtimeStatus':
        response(id, true, runtimeStatus())
        return
      case 'startTask': {
        if (mode === 'start-error') {
          response(id, false, { message: 'fake start failure' })
          return
        }

        const stdoutChunks = parseChunkList('FAKE_TASK_RUNTIME_STDOUT_CHUNKS_JSON') || [`fake:${params.prompt || ''}`]
        const stderrChunks = parseChunkList('FAKE_TASK_RUNTIME_STDERR_CHUNKS_JSON') || []
        const exitCode = Number.parseInt(process.env.FAKE_TASK_RUNTIME_EXIT_CODE || '0', 10)
        const errorMessage = process.env.FAKE_TASK_RUNTIME_ERROR_MESSAGE || ''
        const delayMs = Number.isFinite(defaultDelayMs) ? defaultDelayMs : 10

        runningTasks += 1
        response(id, true, { ok: true })
        const timer = setTimeout(() => {
          for (const chunk of stdoutChunks) {
            event('chunk', {
              taskId: params.taskId,
              chunk,
              isErr: false,
            })
          }
          for (const chunk of stderrChunks) {
            event('chunk', {
              taskId: params.taskId,
              chunk,
              isErr: true,
            })
          }
          finishTask(params.taskId, Number.isNaN(exitCode) ? 0 : exitCode, errorMessage)
        }, delayMs)
        timers.set(params.taskId, timer)
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

  if (message.kind === 'notify' && message.method === 'killTask') {
    finishTask(message.params?.taskId, null, 'killed')
  }
})

process.on('SIGTERM', () => {
  process.exit(0)
})
