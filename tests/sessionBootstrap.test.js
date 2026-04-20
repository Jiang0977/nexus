import test from 'node:test'
import assert from 'node:assert/strict'

import { pickBootstrapSession } from '../frontend/src/sessionBootstrap.ts'

test('prefers a persisted user-selected session when it still exists', () => {
  const session = pickBootstrapSession({
    storedSession: 'project-a',
    storedSessionSource: 'user',
    activeSession: '',
    defaultSession: 'nexus',
    projects: [
      { name: 'nexus' },
      { name: 'project-a' },
    ],
  })

  assert.equal(session, 'project-a')
})

test('does not trust a bootstrap-selected persisted session over the server default', () => {
  const session = pickBootstrapSession({
    storedSession: 'nexus',
    storedSessionSource: 'bootstrap',
    activeSession: '',
    defaultSession: 'nexus-preview-rust',
    projects: [
      { name: 'nexus-preview-rust' },
      { name: 'nexus' },
      { name: 'project-a' },
    ],
  })

  assert.equal(session, 'nexus-preview-rust')
})

test('prefers the server default session when it exists and no trusted persisted selection is valid', () => {
  const session = pickBootstrapSession({
    storedSession: '',
    storedSessionSource: '',
    activeSession: '',
    defaultSession: 'nexus-preview-rust',
    projects: [
      { name: 'nexus-preview-rust' },
      { name: 'nexus' },
      { name: 'project-a' },
    ],
  })

  assert.equal(session, 'nexus-preview-rust')
})

test('returns an empty selection when multiple projects exist but the default session is missing', () => {
  const session = pickBootstrapSession({
    storedSession: '',
    storedSessionSource: '',
    activeSession: '',
    defaultSession: 'nexus-preview-rust',
    projects: [
      { name: 'nexus' },
      { name: 'project-a' },
    ],
  })

  assert.equal(session, '')
})

test('returns the only project when exactly one project exists', () => {
  const session = pickBootstrapSession({
    storedSession: '',
    storedSessionSource: '',
    activeSession: '',
    defaultSession: 'nexus-preview-rust',
    projects: [
      { name: 'nexus' },
    ],
  })

  assert.equal(session, 'nexus')
})

test('returns an empty selection when there are no projects', () => {
  const session = pickBootstrapSession({
    storedSession: '',
    storedSessionSource: '',
    activeSession: '',
    defaultSession: 'nexus',
    projects: [],
  })

  assert.equal(session, '')
})
