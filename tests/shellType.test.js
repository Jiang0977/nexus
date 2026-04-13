import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CLAUDE_SHELL_TYPE,
  DEFAULT_SHELL_TYPE,
  ZSH_SHELL_TYPE,
  normalizeShellType,
  usesClaudeProfile,
} from '../frontend/src/shellType.js'

test('defaults missing or unknown shell types to interactive zsh', () => {
  assert.equal(DEFAULT_SHELL_TYPE, ZSH_SHELL_TYPE)
  assert.equal(normalizeShellType(undefined), ZSH_SHELL_TYPE)
  assert.equal(normalizeShellType('unknown'), ZSH_SHELL_TYPE)
})

test('only explicit claude selections keep claude semantics', () => {
  assert.equal(normalizeShellType(CLAUDE_SHELL_TYPE), CLAUDE_SHELL_TYPE)
  assert.equal(usesClaudeProfile(CLAUDE_SHELL_TYPE), true)
  assert.equal(usesClaudeProfile(ZSH_SHELL_TYPE), false)
})
