import test from 'node:test'
import assert from 'node:assert/strict'

import { pickBootstrapSession } from '../frontend/src/sessionBootstrap.js'

test('prefers the persisted session when it still exists', () => {
  const session = pickBootstrapSession({
    storedSession: 'project-a',
    activeSession: '',
    defaultSession: 'nexus',
    projects: [
      { name: 'nexus' },
      { name: 'project-a' },
    ],
  })

  assert.equal(session, 'project-a')
})

test('skips the default session when persisted state is missing and multiple projects exist', () => {
  const session = pickBootstrapSession({
    storedSession: '',
    activeSession: '',
    defaultSession: 'nexus',
    projects: [
      { name: 'nexus' },
      { name: 'project-a' },
    ],
  })

  assert.equal(session, 'project-a')
})

test('returns an empty selection when there are no projects', () => {
  const session = pickBootstrapSession({
    storedSession: '',
    activeSession: '',
    defaultSession: 'nexus',
    projects: [],
  })

  assert.equal(session, '')
})
