import { execSync } from 'node:child_process'

import { shellQuote } from './shellLaunch.js'

export const TMUX_CODEX_RESUME_SESSION_OPTION = '@nexus_codex_resume_session_id'

export function parseTmuxCodexResumeWindows(output) {
  return String(output || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [windowId = '', indexText = '', resumeSessionId = ''] = line.split('|')
      const index = Number.parseInt(indexText, 10)
      if (!windowId || !Number.isFinite(index)) return null
      return { windowId, index, resumeSessionId }
    })
    .filter(Boolean)
}

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
