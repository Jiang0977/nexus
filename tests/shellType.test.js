import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CLAUDE_SHELL_TYPE,
  CODEX_SHELL_TYPE,
  DEFAULT_SHELL_TYPE,
  ZSH_SHELL_TYPE,
  normalizeShellType,
  usesClaudeProfile,
  usesCodexProfile,
  usesShellProfile,
} from '../frontend/src/shellType.ts'

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

test('keeps explicit codex selections and routes profile semantics separately', () => {
  assert.equal(normalizeShellType(CODEX_SHELL_TYPE), CODEX_SHELL_TYPE)
  assert.equal(usesCodexProfile(CODEX_SHELL_TYPE), true)
  assert.equal(usesCodexProfile(CLAUDE_SHELL_TYPE), false)
  assert.equal(usesClaudeProfile(CODEX_SHELL_TYPE), false)
})

test('treats claude and codex as profile-backed shells', () => {
  assert.equal(usesShellProfile(CLAUDE_SHELL_TYPE), true)
  assert.equal(usesShellProfile(CODEX_SHELL_TYPE), true)
  assert.equal(usesShellProfile(ZSH_SHELL_TYPE), false)
})
