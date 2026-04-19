import test from 'node:test'
import assert from 'node:assert/strict'

import { buildCodexSessionDetailFields } from '../frontend/src/codexSessionDetailFields.js'

test('buildCodexSessionDetailFields keeps only non-empty whitelisted detail fields in stable order', () => {
  assert.deepEqual(
    buildCodexSessionDetailFields({
      source: 'cli',
      originator: 'codex_cli_rs',
      cliVersion: '0.117.0',
      modelProvider: '',
      startedAt: '2026-04-14T11:59:00.000Z',
    }),
    [
      { key: 'source', value: 'cli' },
      { key: 'originator', value: 'codex_cli_rs' },
      { key: 'cliVersion', value: '0.117.0' },
      { key: 'startedAt', value: '2026-04-14T11:59:00.000Z' },
    ],
  )
})
