import test from 'node:test'
import assert from 'node:assert/strict'

import { buildClientConfig } from '../serverConfig.js'

test('buildClientConfig exposes codex history capability for the frontend', () => {
  assert.deepEqual(
    buildClientConfig({
      tmuxSession: 'nexus',
      workspaceRoot: '/workspace',
      codexHistoryEnabled: false,
    }),
    {
      tmuxSession: 'nexus',
      workspaceRoot: '/workspace',
      features: {
        codexHistory: false,
      },
    },
  )
})
