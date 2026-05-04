import test from 'node:test'
import assert from 'node:assert/strict'

import {
  channelTargetKey,
  normalizeWorkspaceLayout,
  paneTargetKey,
  visiblePanesForLayout,
} from '../frontend/src/terminal/splitLayoutTypes.ts'

function layoutFixture(mode, focusedPaneId) {
  return {
    version: 1,
    mode,
    focusedPaneId,
    panes: [{ id: 'pane-1', target: null }],
    updatedAt: '2026-05-04T00:00:00.000Z',
  }
}

test('normalizeWorkspaceLayout keeps the last visible pane focusable', () => {
  assert.equal(
    normalizeWorkspaceLayout(layoutFixture('grid-2x2', 'pane-4')).focusedPaneId,
    'pane-4',
  )
  assert.equal(
    normalizeWorkspaceLayout(layoutFixture('grid-3x3', 'pane-9')).focusedPaneId,
    'pane-9',
  )
})

test('visiblePanesForLayout returns one-based pane ids', () => {
  assert.deepEqual(
    visiblePanesForLayout(layoutFixture('grid-2x2', 'pane-1')).map((pane) => pane.id),
    ['pane-1', 'pane-2', 'pane-3', 'pane-4'],
  )
})

test('pane target keys stay stable across sidebar and split-view coordination', () => {
  assert.equal(channelTargetKey('demo-project', 7), 'demo-project:7')
  assert.equal(
    paneTargetKey({ session: 'demo-project', windowIndex: 7 }),
    'demo-project:7',
  )
  assert.equal(paneTargetKey(null), null)
})
