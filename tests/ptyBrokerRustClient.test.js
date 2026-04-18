import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { createPtyBrokerRustClient } from './helpers/ptyBrokerRustClient.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'fakePtyRustRuntime.js')

function createClient(overrides = {}) {
  return createPtyBrokerRustClient({
    runtimeExecutable: process.execPath,
    runtimeArgs: [FIXTURE],
    env: {
      ...process.env,
      FAKE_PTY_RUNTIME_MODE: 'normal',
      ...overrides.env,
    },
    readyTimeoutMs: overrides.readyTimeoutMs || 500,
    log: { log() {}, error() {} },
  })
}

function createShutdownEpipeSpawn() {
  return () => {
    const child = new EventEmitter()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let exited = false

    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        const raw = String(chunk || '').trim()
        if (!raw) {
          callback()
          return
        }

        const message = JSON.parse(raw)
        if (message.kind !== 'request') {
          callback()
          return
        }

        if (message.method === 'ready') {
          stdout.write(`${JSON.stringify({
            kind: 'response',
            id: message.id,
            ok: true,
            result: {
              ready: true,
              source: 'fake-pty-rust-runtime',
              version: '0.0-test',
              capabilities: { terminal: true, admin: true },
              runningPtys: 0,
            },
          })}\n`)
          callback()
          return
        }

        if (message.method === 'attachConnection') {
          stdout.write(`${JSON.stringify({
            kind: 'response',
            id: message.id,
            ok: true,
            result: { key: `${message.params.session}:${message.params.windowIndex}` },
          })}\n`)
          callback()
          return
        }

        if (message.method === 'shutdown') {
          const error = Object.assign(new Error('broken pipe'), { code: 'EPIPE' })
          callback(error)
          if (!exited) {
            exited = true
            process.nextTick(() => child.emit('exit', null, 'SIGTERM'))
          }
          return
        }

        callback()
      },
    })

    child.stdin = stdin
    child.stdout = stdout
    child.stderr = stderr
    child.kill = () => {
      if (exited) return
      exited = true
      process.nextTick(() => child.emit('exit', 0, 'SIGTERM'))
    }

    return child
  }
}

test('rust pty client waits for ready and maps attach, output, and snapshot onto the broker contract', async (t) => {
  const events = []
  const client = createClient()
  t.after(async () => {
    await client.close()
  })

  client.onEvent((event) => {
    events.push(event)
  })

  const ready = await client.ready()
  assert.equal(ready.ready, true)
  assert.equal(ready.source, 'fake-pty-rust-runtime')
  assert.equal(ready.capabilities.terminal, true)

  const attached = await client.attachConnection({
    connectionId: 'conn-1',
    session: 'main',
    windowIndex: 3,
  })
  assert.deepEqual(attached, { key: 'main:3' })

  client.handleConnectionMessage({
    connectionId: 'conn-1',
    key: 'main:3',
    rawMessage: 'pwd\n',
  })

  await new Promise(resolve => setTimeout(resolve, 30))

  assert.deepEqual(events, [{ type: 'output', connectionId: 'conn-1', data: 'pwd\n' }])

  const snapshot = await client.getOutputSnapshot({ session: 'main', windowIndex: 3 })
  assert.equal(snapshot.connected, true)
  assert.equal(snapshot.output, 'pwd\n')

  const status = await client.getStatus()
  assert.equal(status.runningPtys, 1)
})

test('rust pty client close tolerates stdin EPIPE during shutdown', async () => {
  const client = createPtyBrokerRustClient({
    spawnImpl: createShutdownEpipeSpawn(),
    readyTimeoutMs: 100,
    log: { log() {}, error() {} },
  })

  await client.ready()
  await client.attachConnection({
    connectionId: 'conn-1',
    session: 'main',
    windowIndex: 3,
  })

  await client.close()
  const status = await client.getStatus()
  assert.equal(status.ready, false)
})

test('rust pty client rejects pending ready and emits fatal when the runtime exits before readiness', async (t) => {
  const events = []
  const client = createClient({ env: { FAKE_PTY_RUNTIME_MODE: 'exit-before-ready' } })
  t.after(async () => {
    await client.close()
  })

  client.onEvent((event) => {
    events.push(event)
  })

  await assert.rejects(client.ready(), /pty broker rust runtime exited/)
  assert.deepEqual(events, [{
    type: 'fatal',
    message: 'pty broker rust runtime exited (code=9, signal=null)',
  }])
})
