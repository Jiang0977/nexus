import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeOsc52, MAX_OSC52_BYTES } from '../frontend/src/terminal/terminalOsc52.ts'

test('OSC52 decodes UTF-8 without trimming text and accepts clipboard/default selectors', () => {
  const text = ' 中文🙂 e\u0301\n second line\t '
  for (const selector of ['', 'c', 's', 'cp', 'c0']) {
    assert.equal(decodeOsc52(`${selector};${Buffer.from(text).toString('base64')}`), text)
  }
})

test('OSC52 denies reads, clears, invalid encoding, non-clipboard targets and oversized content', () => {
  for (const payload of ['c;?', 'c;', 'c', 'x;YQ==', 'p;YQ==', '0;YQ==', 'c;!YQ==', 'c;YQ==;extra', 'c;//8=', 'c;YQ', `c;${Buffer.alloc(MAX_OSC52_BYTES + 1).toString('base64')}`]) {
    assert.equal(decodeOsc52(payload), null)
  }
  assert.equal(decodeOsc52(`c;${Buffer.alloc(MAX_OSC52_BYTES, 65).toString('base64')}`).length, MAX_OSC52_BYTES)
})
