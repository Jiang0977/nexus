import test from 'node:test'
import assert from 'node:assert/strict'

import { shouldAutoRefreshProjects } from '../frontend/src/sessionManager/shouldAutoRefreshProjects.ts'

test('auto refreshes project list when current project is missing from loaded sidebar state', () => {
  const shouldRefresh = shouldAutoRefreshProjects({
    currentProject: 'workspace-new',
    hasLoadedProjects: true,
    loadingProjects: false,
    lastAttemptedProject: null,
    projects: [
      { name: 'workspace-old', path: '/workspace/old', active: true, channelCount: 1 },
    ],
  })

  assert.equal(shouldRefresh, true)
})

test('does not auto refresh when current project is already present', () => {
  const shouldRefresh = shouldAutoRefreshProjects({
    currentProject: 'workspace-new',
    hasLoadedProjects: true,
    loadingProjects: false,
    lastAttemptedProject: null,
    projects: [
      { name: 'workspace-new', path: '/workspace/new', active: true, channelCount: 1 },
    ],
  })

  assert.equal(shouldRefresh, false)
})

test('does not auto refresh repeatedly while loading or after trying once for the same project', () => {
  assert.equal(shouldAutoRefreshProjects({
    currentProject: 'workspace-new',
    hasLoadedProjects: true,
    loadingProjects: true,
    lastAttemptedProject: null,
    projects: [],
  }), false)

  assert.equal(shouldAutoRefreshProjects({
    currentProject: 'workspace-new',
    hasLoadedProjects: true,
    loadingProjects: false,
    lastAttemptedProject: 'workspace-new',
    projects: [],
  }), false)
})

test('does not auto refresh before the first project list load finishes', () => {
  assert.equal(shouldAutoRefreshProjects({
    currentProject: 'workspace-new',
    hasLoadedProjects: false,
    loadingProjects: false,
    lastAttemptedProject: null,
    projects: [],
  }), false)
})
