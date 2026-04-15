import test from 'node:test'
import assert from 'node:assert/strict'

import { createVersionService, VersionServiceError } from '../versionService.js'

function createService(overrides = {}) {
  const { execSyncImpl: execSyncOverride, fetchTagsPayloadImpl: fetchOverride, ...serviceOverrides } = overrides
  const commands = []

  const execSyncImpl = (command, options = {}) => {
    commands.push({ command, options })
    if (typeof execSyncOverride === 'function') {
      return execSyncOverride(command, options)
    }
    return ''
  }

  const service = createVersionService({
    projectPath: '/workspace/nexus4cc',
    githubRepo: 'librae8226/nexus4cc',
    execSyncImpl,
    fetchTagsPayloadImpl: fetchOverride,
    ...serviceOverrides,
  })

  return { service, commands }
}

test('getCurrentVersion reads the latest tag and clean status from git', () => {
  const harness = createService({
    execSyncImpl(command, options) {
      assert.equal(options.cwd, '/workspace/nexus4cc')
      if (command === 'git describe --tags --abbrev=0') return 'v4.4.2\n'
      if (command === 'git status --porcelain') return ''
      return ''
    },
  })

  assert.deepEqual(harness.service.getCurrentVersion(), {
    current: 'v4.4.2',
    clean: true,
  })
  assert.deepEqual(harness.commands.map((entry) => entry.command), [
    'git describe --tags --abbrev=0',
    'git status --porcelain',
  ])
})

test('getCurrentVersion falls back to unknown/clean when git inspection fails', () => {
  const harness = createService({
    execSyncImpl(command) {
      if (command === 'git describe --tags --abbrev=0') {
        throw new Error('not a git repository')
      }
      return ''
    },
  })

  assert.deepEqual(harness.service.getCurrentVersion(), {
    current: 'unknown',
    clean: true,
  })
})

test('fetchLatestVersion returns the first GitHub tag and release URL', async () => {
  const harness = createService({
    fetchTagsPayloadImpl: async () => JSON.stringify([{ name: 'v4.5.0' }, { name: 'v4.4.2' }]),
  })

  await assert.doesNotReject(async () => {
    assert.deepEqual(await harness.service.fetchLatestVersion(), {
      latest: 'v4.5.0',
      url: 'https://github.com/librae8226/nexus4cc/releases/tag/v4.5.0',
    })
  })
})

test('fetchLatestVersion maps empty tag lists to the legacy 502 response body', async () => {
  const harness = createService({
    fetchTagsPayloadImpl: async () => '[]',
  })

  await assert.rejects(
    harness.service.fetchLatestVersion(),
    (error) => error instanceof VersionServiceError
      && error.statusCode === 502
      && error.responseBody?.error === 'no tags found',
  )
})

test('fetchLatestVersion maps invalid GitHub payloads to the legacy 502 response body', async () => {
  const harness = createService({
    fetchTagsPayloadImpl: async () => 'not-json',
  })

  await assert.rejects(
    harness.service.fetchLatestVersion(),
    (error) => error instanceof VersionServiceError
      && error.statusCode === 502
      && error.responseBody?.error === 'invalid response from GitHub',
  )
})

test('fetchLatestVersion maps network failures to the legacy 502 response body', async () => {
  const harness = createService({
    fetchTagsPayloadImpl: async () => {
      throw new Error('ECONNRESET')
    },
  })

  await assert.rejects(
    harness.service.fetchLatestVersion(),
    (error) => error instanceof VersionServiceError
      && error.statusCode === 502
      && error.responseBody?.error === 'cannot reach GitHub',
  )
})
