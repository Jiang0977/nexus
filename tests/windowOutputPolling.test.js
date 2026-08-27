import test from 'node:test'
import assert from 'node:assert/strict'

import {
  WINDOW_OUTPUT_POLL_TAIL_CHARS,
  buildWindowOutputRequestUrl,
  createNonOverlappingPoller,
  pollWindowOutputs,
} from '../frontend/src/terminal/windowOutputPolling.ts'

function snapshot(output) {
  return { output, clients: 1, idleMs: 0, connected: true }
}

test('window output polling URLs request a 4096-character tail', () => {
  assert.equal(WINDOW_OUTPUT_POLL_TAIL_CHARS, 4096)
  assert.equal(
    buildWindowOutputRequestUrl(3, { session: 'demo-project' }),
    '/api/sessions/3/output?session=demo-project&tailChars=4096',
  )
  assert.equal(
    buildWindowOutputRequestUrl(1),
    '/api/sessions/1/output?tailChars=4096',
  )
})

test('window output polling skips overlapping cycles until the in-flight request finishes', async () => {
  let started = 0
  let finish
  const fetchImpl = async () => {
    started += 1
    await new Promise((resolve) => {
      finish = resolve
    })
    return { ok: true, status: 200, json: async () => snapshot('live') }
  }

  const controller = new AbortController()
  const tick = createNonOverlappingPoller(async () => {
    await pollWindowOutputs({
      windows: [{ index: 1 }],
      session: 'demo',
      token: 'secret',
      fetchImpl,
      signal: controller.signal,
    })
  })

  const first = tick()
  const second = tick()
  await Promise.resolve()
  assert.equal(started, 1)
  finish()
  await first
  await second
  assert.equal(started, 1)

  const third = tick()
  await Promise.resolve()
  assert.equal(started, 2)
  finish()
  await third
})

test('aborted window output polling cannot overwrite a newer session snapshot', async () => {
  const pending = []
  const fetchImpl = (url) => new Promise((resolve) => {
    pending.push({ url, resolve })
  })

  const oldController = new AbortController()
  const stalePoll = pollWindowOutputs({
    windows: [{ index: 1 }],
    session: 'old-session',
    token: 'secret',
    fetchImpl,
    signal: oldController.signal,
  })

  oldController.abort()

  const newController = new AbortController()
  const freshPoll = pollWindowOutputs({
    windows: [{ index: 1 }],
    session: 'new-session',
    token: 'secret',
    fetchImpl,
    signal: newController.signal,
  })

  assert.equal(pending.length, 2)
  assert.match(pending[0].url, /session=old-session.*tailChars=4096/)
  assert.match(pending[1].url, /session=new-session.*tailChars=4096/)

  pending[0].resolve({
    ok: true,
    status: 200,
    json: async () => snapshot('OLD'),
  })
  pending[1].resolve({
    ok: true,
    status: 200,
    json: async () => snapshot('NEW'),
  })

  assert.equal(await stalePoll, undefined)
  assert.deepEqual(await freshPoll, { 1: snapshot('NEW') })
})
