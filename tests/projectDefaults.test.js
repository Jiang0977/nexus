import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { getProjectDefault, normalizeProjectPathKey, saveProjectDefault } from '../projectDefaults.js'

test('normalizeProjectPathKey removes trailing slash but keeps root', () => {
  assert.equal(normalizeProjectPathKey('/workspace/demo/'), '/workspace/demo')
  assert.equal(normalizeProjectPathKey('/'), '/')
})

test('saveProjectDefault stores per-path shell defaults', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'nexus-project-defaults-'))
  const filePath = join(rootDir, 'project-defaults.json')

  try {
    const saved = saveProjectDefault(filePath, {
      path: '/workspace/demo',
      shellType: 'codex',
      profile: 'work',
    })

    const loaded = getProjectDefault(filePath, '/workspace/demo/')

    assert.deepEqual(saved, {
      path: '/workspace/demo',
      shell_type: 'codex',
      profile: 'work',
    })
    assert.deepEqual(loaded, {
      path: '/workspace/demo',
      shell_type: 'codex',
      profile: 'work',
    })
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('saveProjectDefault clears profile for zsh shells', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'nexus-project-defaults-'))
  const filePath = join(rootDir, 'project-defaults.json')

  try {
    saveProjectDefault(filePath, {
      path: '/workspace/demo',
      shellType: 'bash',
      profile: 'ignored',
    })

    assert.deepEqual(getProjectDefault(filePath, '/workspace/demo'), {
      path: '/workspace/demo',
      shell_type: 'bash',
      profile: null,
    })
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
