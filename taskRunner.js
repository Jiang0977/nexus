import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import { createTaskRunnerController } from './taskRunnerController.js'

const DEFAULT_MAX_TASKS = 200

/**
 * @typedef {{
 *   tasksFile: string,
 *   maxTasks?: number,
 *   existsSyncImpl?: typeof existsSync,
 *   readFileSyncImpl?: typeof readFileSync,
 *   writeFileSyncImpl?: typeof writeFileSync,
 *   now?: () => string,
 * }} TaskStoreOptions
 */

/** @param {TaskStoreOptions} options */
export function createTaskStore(options) {
  const {
    tasksFile,
    maxTasks = DEFAULT_MAX_TASKS,
    existsSyncImpl = existsSync,
    readFileSyncImpl = readFileSync,
    writeFileSyncImpl = writeFileSync,
    now = () => new Date().toISOString(),
  } = options

  function loadTasks() {
    try {
      if (existsSyncImpl(tasksFile)) {
        return JSON.parse(readFileSyncImpl(tasksFile, 'utf8'))
      }
    } catch {}
    return []
  }

  function saveTasks(tasks) {
    const trimmed = tasks.length > maxTasks ? tasks.slice(-maxTasks) : tasks
    writeFileSyncImpl(tasksFile, JSON.stringify(trimmed, null, 2))
  }

  function appendTask(task) {
    const tasks = loadTasks()
    tasks.push(task)
    saveTasks(tasks)
  }

  function updateTask(id, updates) {
    const tasks = loadTasks()
    const idx = tasks.findIndex(task => task.id === id)
    if (idx !== -1) {
      Object.assign(tasks[idx], updates)
      saveTasks(tasks)
    }
  }

  function deleteTask(id) {
    const tasks = loadTasks()
    saveTasks(tasks.filter(task => task.id !== id))
  }

  function listRecent(limit = 50) {
    return loadTasks().slice(-limit).reverse()
  }

  function markRunningTasksInterrupted(message = '(服务重启，任务中断)') {
    const tasks = loadTasks()
    let changed = false
    for (const task of tasks) {
      if (task.status === 'running') {
        task.status = 'error'
        task.error = message
        task.completedAt = now()
        changed = true
      }
    }
    if (changed) saveTasks(tasks)
    return changed
  }

  return {
    loadTasks,
    saveTasks,
    appendTask,
    updateTask,
    deleteTask,
    listRecent,
    markRunningTasksInterrupted,
  }
}

/**
 * @typedef {import('./taskRunnerController.js').TaskRunnerControllerOptions & {
 *   taskChildren?: Set<any>,
 *   spawnImpl?: import('node:child_process').spawn,
 *   sanitizeEnv?: typeof import('./interactiveEnv.js').sanitizeInteractiveEnv,
 *   envSource?: NodeJS.ProcessEnv,
 *   claudeProxy?: string,
 *   spawnChildImpl?: (options: {
 *     nodeExecutable: string,
 *     sidecarProcessPath: string,
 *     env: NodeJS.ProcessEnv,
 *     log?: Console,
 *   }) => any,
 *   nodeExecutable?: string,
 *   sidecarProcessPath?: string,
 *   env?: NodeJS.ProcessEnv,
 * }} TaskRunnerOptions
 */

/** @param {TaskRunnerOptions} options */
export function createTaskRunner(options) {
  const {
    taskChildren,
    spawnImpl,
    sanitizeEnv,
    envSource,
    claudeProxy,
    spawnChildImpl,
    nodeExecutable,
    sidecarProcessPath,
    env,
    backendOptions = {},
    ...controllerOptions
  } = options

  return createTaskRunnerController({
    ...controllerOptions,
    backendOptions: {
      ...backendOptions,
      ...(taskChildren ? { taskChildren } : {}),
      ...(spawnImpl ? { spawnImpl } : {}),
      ...(sanitizeEnv ? { sanitizeEnv } : {}),
      ...(envSource ? { envSource } : {}),
      ...(claudeProxy ? { claudeProxy } : {}),
      ...(spawnChildImpl ? { spawnChildImpl } : {}),
      ...(nodeExecutable ? { nodeExecutable } : {}),
      ...(sidecarProcessPath ? { sidecarProcessPath } : {}),
      ...(env ? { env } : {}),
    },
  })
}
