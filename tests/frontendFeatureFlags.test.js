import test from 'node:test'
import assert from 'node:assert/strict'

import { isCodexHistoryEnabled } from '../frontend/src/featureFlags.ts'

test('isCodexHistoryEnabled defaults to true only when the capability is absent', () => {
  assert.equal(isCodexHistoryEnabled({}), true)
  assert.equal(isCodexHistoryEnabled({ features: {} }), true)
  assert.equal(isCodexHistoryEnabled({ features: { codexHistory: true } }), true)
  assert.equal(isCodexHistoryEnabled({ features: { codexHistory: false } }), false)
})
