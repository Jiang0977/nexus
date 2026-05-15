import test from 'node:test'
import assert from 'node:assert/strict'

import { visibleChannelsForProject } from '../frontend/src/sessionManager/channelVisibility.ts'

const financialChannels = [
  { index: 1, name: 'channel-1', active: true, cwd: '/home/demo/workspace/financial' },
]

test('hides stale channels while the newly selected project is still loading', () => {
  assert.deepEqual(
    visibleChannelsForProject(financialChannels, 'home-demo-workspace-financial', 'home-demo-workspace-rust-nexus'),
    [],
  )
})

test('shows channels only for the project that loaded them', () => {
  assert.deepEqual(
    visibleChannelsForProject(financialChannels, 'home-demo-workspace-financial', 'home-demo-workspace-financial'),
    financialChannels,
  )
})
