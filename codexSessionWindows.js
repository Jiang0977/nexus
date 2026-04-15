import { execSync } from 'node:child_process'

import { shellQuote } from './shellLaunch.js'

export const TMUX_CODEX_RESUME_SESSION_OPTION = '@nexus_codex_resume_session_id'

/**
 * @typedef {{
 *   windowId: string,
 *   index: number,
 *   resumeSessionId: string,
 * }} TmuxCodexResumeWindow
 *
 * @typedef {{
 *   sessionName?: string,
 *   execSyncImpl?: typeof execSync,
 * }} ListTmuxCodexResumeWindowsOptions
 *
 * @typedef {{
 *   windowTarget?: string,
 *   sessionId?: string,
 *   execSyncImpl?: typeof execSync,
 * }} MarkTmuxWindowAsCodexResumeSessionOptions
 *
 * @typedef {{
 *   sessionName?: string,
 *   sessionId?: string,
 *   defaultInteractiveShell?: string,
 *   execSyncImpl?: typeof execSync,
 *   cleanupRuntime?: (windowId: string) => void,
 * }} CloseTmuxWindowsForCodexSessionOptions
 */

/**
 * @param {string} output
 * @returns {TmuxCodexResumeWindow[]}
 */
export function parseTmuxCodexResumeWindows(output) {
  return String(output || '')
    .split('\n')
    .reduce((windows, rawLine) => {
      const line = rawLine.trim()
      if (!line) return windows
      const [windowId = '', indexText = '', resumeSessionId = ''] = line.split('|')
      const index = Number.parseInt(indexText, 10)
      if (!windowId || !Number.isFinite(index)) return windows
      windows.push({ windowId, index, resumeSessionId })
      return windows
    }, /** @type {TmuxCodexResumeWindow[]} */([]))
}

/** @param {ListTmuxCodexResumeWindowsOptions} [options] */
export function listTmuxCodexResumeWindows({
  sessionName,
  execSyncImpl = execSync,
} = {}) {
  if (!sessionName) return []

  try {
    const output = execSyncImpl(
      `tmux list-windows -t ${shellQuote(sessionName)} -F '#{window_id}|#{window_index}|#{${TMUX_CODEX_RESUME_SESSION_OPTION}}' 2>/dev/null`,
      { encoding: 'utf8' },
    )
    return parseTmuxCodexResumeWindows(output)
  } catch {
    return []
  }
}

/** @param {MarkTmuxWindowAsCodexResumeSessionOptions} options */
export function markTmuxWindowAsCodexResumeSession({
  windowTarget,
  sessionId,
  execSyncImpl = execSync,
}) {
  if (!windowTarget || !sessionId) return

  execSyncImpl(
    `tmux set-option -w -t ${shellQuote(windowTarget)} ${shellQuote(TMUX_CODEX_RESUME_SESSION_OPTION)} ${shellQuote(sessionId)} 2>/dev/null`,
    { encoding: 'utf8' },
  )
}

/** @param {CloseTmuxWindowsForCodexSessionOptions} options */
export function closeTmuxWindowsForCodexSession({
  sessionName,
  sessionId,
  defaultInteractiveShell,
  execSyncImpl = execSync,
  cleanupRuntime = () => {},
}) {
  if (!sessionName || !sessionId) return []

  const windows = listTmuxCodexResumeWindows({ sessionName, execSyncImpl })
  const matchedWindows = windows.filter(window => window.resumeSessionId === sessionId)
  if (matchedWindows.length === 0) return []

  if (windows.length <= matchedWindows.length) {
    execSyncImpl(
      `tmux new-window -t ${shellQuote(sessionName)} -n shell ${shellQuote(defaultInteractiveShell)} 2>/dev/null`,
      { encoding: 'utf8' },
    )
  }

  for (const window of matchedWindows) {
    execSyncImpl(
      `tmux kill-window -t ${shellQuote(window.windowId)} 2>/dev/null`,
      { encoding: 'utf8' },
    )
    cleanupRuntime(window.windowId)
  }

  return matchedWindows
}
