import { spawn } from 'node:child_process'

import { sanitizeInteractiveEnv } from './interactiveEnv.js'

/**
 * @typedef {{
 *   type: 'chunk',
 *   taskId: string,
 *   chunk: string,
 *   isErr: boolean,
 * } | {
 *   type: 'done',
 *   taskId: string,
 *   exitCode: number | null,
 *   errorMessage?: string,
 * } | {
 *   type: 'fatal',
 *   message: string,
 * }} TaskRunnerBackendEvent
 */

/**
 * @typedef {{
 *   taskChildren?: Set<any>,
 *   spawnImpl?: typeof spawn,
 *   sanitizeEnv?: typeof sanitizeInteractiveEnv,
 *   envSource?: NodeJS.ProcessEnv,
 *   claudeProxy?: string,
 *   log?: Console,
 * }} TaskRunnerLocalBackendOptions
 */

/** @param {TaskRunnerLocalBackendOptions} options */
export function createTaskRunnerLocalBackend(options = {}) {
  const {
    taskChildren = new Set(),
    spawnImpl = spawn,
    sanitizeEnv = sanitizeInteractiveEnv,
    envSource = process.env,
    claudeProxy = '',
    log = console,
  } = options

  const tasks = new Map()
  /** @type {(event: TaskRunnerBackendEvent) => void} */
  let eventHandler = () => {}

  function emit(event) {
    eventHandler(event)
  }

  return {
    onEvent(handler) {
      eventHandler = typeof handler === 'function' ? handler : () => {}
    },
    startTask({ taskId, prompt, cwd, profile }) {
      const proxyEnv = claudeProxy ? {
        ALL_PROXY: claudeProxy,
        HTTPS_PROXY: claudeProxy,
        HTTP_PROXY: claudeProxy,
      } : {}
      const claudeArgs = ['-p', prompt, '--dangerously-skip-permissions']
      if (profile) claudeArgs.push('--profile', profile)

      const child = spawnImpl('claude', claudeArgs, {
        cwd,
        env: sanitizeEnv(envSource, proxyEnv),
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const entry = {
        child,
        settled: false,
      }
      tasks.set(taskId, entry)
      taskChildren.add(child)

      function finish(exitCode, errorMessage = '') {
        if (entry.settled) return
        entry.settled = true
        tasks.delete(taskId)
        taskChildren.delete(child)
        emit({
          type: 'done',
          taskId,
          exitCode,
          ...(errorMessage ? { errorMessage } : {}),
        })
      }

      child.stdout?.on('data', (data) => {
        emit({
          type: 'chunk',
          taskId,
          chunk: data.toString(),
          isErr: false,
        })
      })

      child.stderr?.on('data', (data) => {
        emit({
          type: 'chunk',
          taskId,
          chunk: data.toString(),
          isErr: true,
        })
      })

      child.on('error', (error) => {
        log.error?.('task runner child error:', error)
        finish(null, error?.message || 'task runner child error')
      })

      child.on('close', (code) => {
        finish(code ?? null)
      })

      return {
        kill() {
          if (!child.killed) child.kill()
        },
      }
    },
    killTask({ taskId }) {
      const entry = tasks.get(taskId)
      if (!entry?.child?.killed) {
        entry?.child?.kill?.()
      }
    },
    async close() {
      for (const entry of tasks.values()) {
        try {
          if (!entry.child?.killed) entry.child?.kill?.('SIGTERM')
        } catch {}
      }
      tasks.clear()
    },
  }
}
