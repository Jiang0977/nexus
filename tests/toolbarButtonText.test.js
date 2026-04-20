import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ALL_KEYS,
  getToolbarButtonText,
  isToolbarKeycap,
} from '../frontend/src/toolbarDefaults.ts'

function findKey(id) {
  const key = ALL_KEYS.find((item) => item.id === id)
  assert.ok(key, `missing key: ${id}`)
  return key
}

const t = (value) => `translated:${value}`

test('standard keycaps keep their original key label', () => {
  const esc = findKey('esc')
  const left = findKey('left')
  const slash = findKey('slash')

  assert.equal(isToolbarKeycap(esc), true)
  assert.equal(getToolbarButtonText(esc, t), 'Esc')
  assert.equal(getToolbarButtonText(left, t), '←')
  assert.equal(getToolbarButtonText(slash, t), '/')
})

test('non-standard shortcuts show translated function text', () => {
  const ctrlA = findKey('ctrl-a')
  const altB = findKey('alt-b')
  const copyTerm = findKey('copy-term')

  assert.equal(isToolbarKeycap(ctrlA), false)
  assert.equal(getToolbarButtonText(ctrlA, t), 'translated:toolbarKeys.lineStart')
  assert.equal(getToolbarButtonText(altB, t), 'translated:toolbarKeys.wordBack')
  assert.equal(getToolbarButtonText(copyTerm, t), 'translated:toolbarKeys.copyTerminal')
})
