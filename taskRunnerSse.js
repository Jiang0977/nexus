/**
 * @typedef {{
 *   res: {
 *     setHeader: (name: string, value: string) => void,
 *     write: (chunk: string) => void,
 *     end: () => void,
 *     once: (event: string, handler: () => void) => void,
 *     writableEnded?: boolean,
 *     destroyed?: boolean,
 *   },
 *   taskRunner: {
 *     runTask: (
 *       prompt: string,
 *       cwd: string,
 *       options: {
 *         sessionName?: string,
 *         source?: string,
 *         tmuxSession?: string,
 *         profile?: string,
 *         onChunk?: (chunk: string, isErr: boolean) => void,
 *         onDone?: (payload: { taskId: string, status: string, exitCode: number | null }) => void,
 *       },
 *     ) => { taskId: string, kill: () => void },
 *   },
 *   prompt: string,
 *   cwd: string,
 *   sessionName?: string,
 *   source?: string,
 *   tmuxSession?: string,
 *   profile?: string,
 *   now?: () => string,
 * }} TaskRunnerSseOptions
 */

/**
 * @param {TaskRunnerSseOptions} options
 * @returns {{ taskId: string, kill: () => void }}
 */
export function streamTaskToSse(options) {
  const {
    res,
    taskRunner,
    prompt,
    cwd,
    sessionName = '',
    source = 'web',
    tmuxSession,
    profile,
    now = () => new Date().toISOString(),
  } = options

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  let completed = false
  let responseClosed = false

  function writeEvent(event, payload) {
    if (responseClosed || res.writableEnded || res.destroyed) return false
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
    return true
  }

  const { taskId, kill } = taskRunner.runTask(prompt, cwd, {
    sessionName,
    source,
    tmuxSession,
    profile,
    onChunk: (chunk, isErr) => {
      writeEvent(isErr ? 'error' : 'output', { chunk })
    },
    onDone: ({ taskId: doneTaskId, status, exitCode }) => {
      completed = true
      if (writeEvent('done', { taskId: doneTaskId, status, exitCode })) {
        res.end()
      }
    },
  })

  writeEvent('start', {
    taskId,
    session_name: sessionName,
    prompt,
    createdAt: now(),
  })

  res.once('close', () => {
    responseClosed = true
    if (!completed) {
      kill()
    }
  })

  return { taskId, kill }
}
