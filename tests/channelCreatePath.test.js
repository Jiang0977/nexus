import test from 'node:test'
import assert from 'node:assert/strict'

import { channelCreatePath } from '../frontend/src/terminal/channelCreatePath.ts'

test('omits workspace-root paths so the server can inherit the project cwd', () => {
  assert.equal(channelCreatePath('/home/demo/workspace', '/home/demo/workspace'), undefined)
  assert.equal(channelCreatePath('/home/demo/workspace/', '/home/demo/workspace'), undefined)
  assert.equal(channelCreatePath('', '/home/demo/workspace'), undefined)
  assert.equal(channelCreatePath(undefined, '/home/demo/workspace'), undefined)
})

test('keeps a project-specific path', () => {
  assert.equal(
    channelCreatePath('/home/demo/workspace/java/sample-shop', '/home/demo/workspace'),
    '/home/demo/workspace/java/sample-shop',
  )
})
