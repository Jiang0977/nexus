import test from 'node:test'
import assert from 'node:assert/strict'

import {
  closeTmuxWindowsForCodexSession,
  markTmuxWindowAsCodexResumeSession,
  parseTmuxCodexResumeWindows,
  TMUX_CODEX_RESUME_SESSION_OPTION,
} from '../codexSessionWindows.js'

test('parseTmuxCodexResumeWindows reads tmux window metadata lines', () => {
  const result = parseTmuxCodexResumeWindows(`
@1|1|session-keep
bad-line
@2|2|
`)

  assert.deepEqual(result, [
    { windowId: '@1', index: 1, resumeSessionId: 'session-keep' },
    { windowId: '@2', index: 2, resumeSessionId: '' },
  ])
})

test('markTmuxWindowAsCodexResumeSession stores the source session id on the tmux window', () => {
  const commands = []

  markTmuxWindowAsCodexResumeSession({
    windowTarget: '@9',
    sessionId: 'session-123',
    execSyncImpl: (command) => {
      commands.push(command)
      return ''
    },
  })

  assert.equal(commands.length, 1)
  assert.match(commands[0], /set-option -w -t "@9"/)
  assert.match(commands[0], new RegExp(`"${TMUX_CODEX_RESUME_SESSION_OPTION}"`))
  assert.match(commands[0], /"session-123"/)
})

test('closeTmuxWindowsForCodexSession kills matched windows and creates a fallback when all windows are matched', () => {
  const commands = []
  const cleanedWindowIds = []

  const closedWindows = closeTmuxWindowsForCodexSession({
    sessionName: 'nexus',
    sessionId: 'session-delete-me',
    defaultInteractiveShell: 'exec zsh -i',
    execSyncImpl: (command) => {
      commands.push(command)
      if (command.includes('list-windows')) {
        return '@1|1|session-delete-me\n@2|2|session-delete-me\n'
      }
      return ''
    },
    cleanupRuntime: (windowId) => cleanedWindowIds.push(windowId),
  })

  assert.deepEqual(closedWindows.map(window => window.index), [1, 2])
  assert.match(commands[1], /new-window -t "nexus" -n shell "exec zsh -i"/)
  assert.match(commands[2], /kill-window -t "@1"/)
  assert.match(commands[3], /kill-window -t "@2"/)
  assert.deepEqual(cleanedWindowIds, ['@1', '@2'])
})
