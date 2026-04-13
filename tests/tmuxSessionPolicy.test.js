import test from 'node:test'
import assert from 'node:assert/strict'

import { resolvePassiveAttachTarget } from '../tmuxSessionPolicy.js'

test('returns session_missing when the tmux session does not exist', () => {
  assert.deepEqual(
    resolvePassiveAttachTarget({
      sessionExists: false,
      existingWindows: [],
      requestedWindowIndex: 0,
    }),
    { ok: false, reason: 'session_missing' },
  )
})

test('falls back to the first existing window without creating a new one', () => {
  assert.deepEqual(
    resolvePassiveAttachTarget({
      sessionExists: true,
      existingWindows: [3, 7],
      requestedWindowIndex: 99,
    }),
    { ok: true, windowIndex: 3 },
  )
})

test('returns window_missing when the session has no windows', () => {
  assert.deepEqual(
    resolvePassiveAttachTarget({
      sessionExists: true,
      existingWindows: [],
      requestedWindowIndex: 0,
    }),
    { ok: false, reason: 'window_missing' },
  )
})
