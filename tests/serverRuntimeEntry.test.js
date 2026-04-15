import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function getFreePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  server.close()
  await once(server, 'close')
  return port
}

function createFakeTmuxBin() {
  const baseDir = mkdtempSync(join(tmpdir(), 'nexus-fake-tmux-'))
  const homeDir = join(baseDir, 'home')
  mkdirSync(homeDir, { recursive: true })
  writeFileSync(join(baseDir, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return { baseDir, homeDir }
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  const exitPromise = once(child, 'exit')
  const timeoutPromise = delay(5000).then(() => {
    if (child.exitCode === null) child.kill('SIGKILL')
  })
  await Promise.race([exitPromise, timeoutPromise])
}

async function waitForHealthyHttp(port, child) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`compiled server exited early with code ${child.exitCode}`)
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}`)
      if (response.ok) return response
    } catch {}

    await delay(250)
  }

  throw new Error(`compiled server did not become healthy on port ${port}`)
}

test('compiled server build boots from dist-server and keeps runtime paths anchored at project root', async (t) => {
  const build = spawnSync('npm', ['run', 'build:server'], {
    cwd: ROOT,
    encoding: 'utf8',
  })

  assert.equal(build.status, 0, build.stderr || build.stdout)
  assert.equal(existsSync(join(ROOT, 'dist-server', 'server.js')), true)

  rmSync(join(ROOT, 'dist-server', 'data'), { recursive: true, force: true })

  const { baseDir, homeDir } = createFakeTmuxBin()
  const port = await getFreePort()
  let child = null
  let logs = ''

  t.after(async () => {
    await stopChild(child)
    rmSync(baseDir, { recursive: true, force: true })
  })

  child = spawn(process.execPath, ['dist-server/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `${baseDir}:${process.env.PATH || ''}`,
      HOME: homeDir,
      HOST: '127.0.0.1',
      PORT: String(port),
      JWT_SECRET: 'runtime-test-secret',
      ACC_PASSWORD_HASH: 'runtime-test-hash',
      TMUX_SESSION: 'runtime-test',
      WORKSPACE_ROOT: ROOT,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout.on('data', (chunk) => {
    logs += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    logs += chunk.toString()
  })

  const response = await waitForHealthyHttp(port, child)
  const body = await response.text()

  assert.match(body, /<html/i)
  assert.match(logs, /Nexus listening on 127\.0\.0\.1:/)
  assert.equal(existsSync(join(ROOT, 'dist-server', 'data')), false)
})
