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

test('terminal input shortcuts show their readable key and function label', () => {
  const esc = findKey('esc')
  const ctrlO = findKey('ctrl-o')
  const altB = findKey('alt-b')
  const shiftTab = findKey('shift-tab')
  const bang = findKey('bang')

  assert.equal(isToolbarTerminalInput(esc), true)
  assert.equal(getToolbarButtonText(esc, t), 'Esc · translated:toolbarKeys.escapeVim')
  assert.equal(getToolbarButtonText(ctrlO, t), 'Ctrl+O · translated:toolbarKeys.toggleVerbose')
  assert.equal(getToolbarButtonText(altB, t), 'Alt+B · translated:toolbarKeys.wordBack')
  assert.equal(getToolbarButtonText(shiftTab, t), 'Shift+Tab · translated:toolbarKeys.togglePermission')
  assert.equal(getToolbarButtonText(bang, t), '! · translated:toolbarKeys.bashMode')
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
