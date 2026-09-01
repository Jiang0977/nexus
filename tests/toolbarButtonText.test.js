import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ALL_KEYS,
  getToolbarButtonText,
  isToolbarLocalAction,
  isToolbarTerminalInput,
} from '../frontend/src/toolbarDefaults.ts'

function findKey(id) {
  const key = ALL_KEYS.find((item) => item.id === id)
  assert.ok(key, `missing key: ${id}`)
  return key
}

const t = (value) => `translated:${value}`

test('icon-only terminal input shortcuts show only their readable key label', () => {
  const esc = findKey('esc')
  const up = findKey('up')
  const slash = findKey('slash')
  const backslash = findKey('backslash')
  const tab = findKey('tab')
  const enter = findKey('enter')

  assert.equal(isToolbarTerminalInput(esc), true)
  assert.equal(getToolbarButtonText(esc, t), 'Esc')
  assert.equal(getToolbarButtonText(up, t), '↑')
  assert.equal(getToolbarButtonText(slash, t), '/')
  assert.equal(getToolbarButtonText(backslash, t), '\\')
  assert.equal(getToolbarButtonText(tab, t), 'Tab')
  assert.equal(getToolbarButtonText(enter, t), '↵')
})

test('non-icon-only terminal input shortcuts show their readable key and function label', () => {
  const ctrlO = findKey('ctrl-o')
  const altB = findKey('alt-b')
  const shiftTab = findKey('shift-tab')
  const bang = findKey('bang')
  const ctrlA = findKey('ctrl-a')

  assert.equal(isToolbarTerminalInput(ctrlO), true)
  assert.equal(getToolbarButtonText(ctrlO, t), 'Ctrl+O · translated:toolbarKeys.toggleVerbose')
  assert.equal(getToolbarButtonText(altB, t), 'Alt+B · translated:toolbarKeys.wordBack')
  assert.equal(getToolbarButtonText(shiftTab, t), 'Shift+Tab · translated:toolbarKeys.togglePermission')
  assert.equal(getToolbarButtonText(bang, t), '! · translated:toolbarKeys.bashMode')
  assert.equal(getToolbarButtonText(ctrlA, t), 'Ctrl+A · translated:toolbarKeys.lineStart')
})

test('local toolbar actions show translated function text', () => {
  const pasteClipboard = findKey('ctrl-v')
  const copyTerm = findKey('copy-term')
  const fit = findKey('fit')

  assert.equal(isToolbarLocalAction(pasteClipboard), true)
  assert.equal(getToolbarButtonText(pasteClipboard, t), 'translated:toolbarKeys.pasteClipboard')
  assert.equal(getToolbarButtonText(copyTerm, t), 'translated:toolbarKeys.copyTerminal')
  assert.equal(getToolbarButtonText(fit, t), 'translated:toolbarKeys.fitTerminal')
})

test('every toolbar key has a terminal sequence or a local action', () => {
  for (const key of ALL_KEYS) {
    assert.ok(key.seq || key.action, `toolbar key has no behavior: ${key.id}`)
  }
})
