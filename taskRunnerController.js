import { createTaskRunnerLocalBackend } from './taskRunnerLocalBackend.js'
import { createTaskRunnerSidecarClient } from './taskRunnerSidecarClient.js'

const MAX_OUTPUT_LENGTH = 10000
const MAX_ERROR_LENGTH = 1000

/**
 * @typedef {{
 *   taskStore: {
 *     appendTask: (task: Record<string, unknown>) => void,
 *     updateTask: (id: string, updates: Record<string, unknown>) => void,
 *   },
 *   defaultTmuxSession?: string,
 *   now?: () => string,
 *   dateNow?: () => number,
 *   random?: () => number,
 *   mode?: string,
 *   createLocalBackend?: (options?: object) => any,
 *   createSidecarBackend?: (options?: object) => any,
 *   backendOptions?: object,
 *   log?: Console,
 * }} TaskRunnerControllerOptions
 */

/** @param {TaskRunnerControllerOptions} options */
export function createTaskRunnerController(options) {
  const {
    taskStore,
    defaultTmuxSession = '',
    now = () => new Date().toISOString(),
    dateNow = Date.now,
    random = Math.random,
    mode = 'local',
    createLocalBackend = createTaskRunnerLocalBackend,
    createSidecarBackend = createTaskRunnerSidecarClient,
    backendOptions = {},
    log = console,
  } = options

  const backend = mode === 'sidecar'
    ? createSidecarBackend({ log, ...backendOptions })
    : createLocalBackend({ log, ...backendOptions })

  const tasks = new Map()
  let closing = false

  function finalizeTask(taskId, result = {}) {
    const state = tasks.get(taskId)
    if (!state || state.completed) return

    state.completed = true
    tasks.delete(taskId)

    const exitCode = typeof result.exitCode === 'number' ? result.exitCode : null
    const errorMessage = String(result.errorMessage || '').trim()
    if (errorMessage && !state.errorOutput) {
      state.errorOutput = errorMessage
    }

    const status = exitCode === 0 ? 'success' : 'error'
    taskStore.updateTask(taskId, {
      status,
      output: state.output.slice(-MAX_OUTPUT_LENGTH),
      error: state.errorOutput.slice(-MAX_ERROR_LENGTH),
      completedAt: now(),
      exitCode,
    })

    state.onDone?.({
      taskId,
      status,
      output: state.output,
      errorOutput: state.errorOutput,
      exitCode,
    })
  }

  backend.onEvent((event) => {
    if (!event || typeof event !== 'object') return

    if (event.type === 'chunk') {
      const state = tasks.get(event.taskId)
      if (!state) return
      const chunk = String(event.chunk || '')
      if (event.isErr) state.errorOutput += chunk
      else state.output += chunk
      state.onChunk?.(chunk, Boolean(event.isErr))
      return
    }

    if (event.type === 'done') {
      finalizeTask(event.taskId, {
        exitCode: event.exitCode,
        errorMessage: event.errorMessage || '',
      })
      return
    }

    if (event.type === 'fatal') {
      if (!closing) {
        log.error?.(event.message || 'task runner controller fatal event')
      }
      for (const taskId of [...tasks.keys()]) {
        finalizeTask(taskId, {
          exitCode: null,
          errorMessage: event.message || 'task runner backend unavailable',
        })
      }
    }
  })

  return {
    runTask(prompt, cwd, opts = {}) {
      const { sessionName, source = 'web', tmuxSession, profile, onChunk, onDone } = opts
      const taskId = `task_${dateNow()}_${random().toString(36).slice(2, 8)}`
      const createdAt = now()

      taskStore.appendTask({
        id: taskId,
        session_name: sessionName || '',
        prompt: prompt.slice(0, 1000),
        status: 'running',
        output: '',
        error: '',
        createdAt,
        source,
        ...(tmuxSession && tmuxSession !== defaultTmuxSession ? { tmux_session: tmuxSession } : {}),
      })

      const state = {
        output: '',
        errorOutput: '',
        onChunk,
        onDone,
        completed: false,
      }
      tasks.set(taskId, state)

      let killImpl = () => {
        try {
          backend.killTask({ taskId })
        } catch {}
      }

      try {
        const startResult = backend.startTask({ taskId, prompt, cwd, profile })
        if (startResult && typeof startResult === 'object' && typeof startResult.kill === 'function') {
          killImpl = startResult.kill
        }

        Promise.resolve(startResult)
          .then((result) => {
            if (result && typeof result === 'object') {
              if (typeof result.kill === 'function') {
                killImpl = result.kill
              }
              if (result.error) {
                finalizeTask(taskId, {
                  exitCode: null,
                  errorMessage: String(result.error),
                })
              }
            }
          })
          .catch((error) => {
            finalizeTask(taskId, {
              exitCode: null,
              errorMessage: error?.message || 'task runner start failed',
            })
          })
      } catch (error) {
        finalizeTask(taskId, {
          exitCode: null,
          errorMessage: error?.message || 'task runner start failed',
        })
      }

      return {
        taskId,
        kill: () => {
          try {
            killImpl()
          } catch {}
        },
      }
    },
    async close() {
      closing = true
      await backend.close?.()
    },
  }
}
