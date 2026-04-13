import test from 'node:test'
import assert from 'node:assert/strict'

import { sanitizeInteractiveEnv, wrapInteractiveShellCommand } from '../interactiveEnv.js'

test('sanitizeInteractiveEnv removes server-only HOST but preserves other vars', () => {
  const env = sanitizeInteractiveEnv({
    HOST: '127.0.0.1',
    HOSTNAME: 'demo-linux',
    PATH: '/tmp/bin',
  })

  assert.equal(env.HOST, undefined)
  assert.equal(env.HOSTNAME, 'demo-linux')
  assert.equal(env.PATH, '/tmp/bin')
})

test('sanitizeInteractiveEnv applies overrides after sanitizing', () => {
  const env = sanitizeInteractiveEnv(
    { HOST: '127.0.0.1', PATH: '/usr/bin' },
    { TERM: 'xterm-256color' },
  )

  assert.equal(env.HOST, undefined)
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.TERM, 'xterm-256color')
})

test('wrapInteractiveShellCommand unsets HOST before running shell command', () => {
  assert.equal(
    wrapInteractiveShellCommand('exec zsh -i'),
    'unset HOST; exec zsh -i',
  )
})
