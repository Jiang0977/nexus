import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { deleteCodexSession, getProjectCodexSessionDetail, listProjectCodexSessions } from '../codexSessions.js'

function writeJsonl(filePath, lines) {
  writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8')
}

function createSessionFile(baseDir, { id, datePath, cwd, timestamp = '2026-04-14T12:00:00.000Z', metaFields = {}, extraLines = [] }) {
  const dir = join(baseDir, 'sessions', ...datePath.split('/'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, `rollout-${datePath.replaceAll('/', '-')}-${id}.jsonl`)
  writeJsonl(filePath, [
    JSON.stringify({
      timestamp,
      type: 'session_meta',
      payload: {
        id,
        timestamp,
        cwd,
        ...metaFields,
      },
    }),
    ...extraLines,
  ])
  return filePath
}

test('listProjectCodexSessions matches repo-root sessions and cwd fallback sessions', async () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'nexus-codex-sessions-'))
  try {
    writeJsonl(join(codexHome, 'session_index.jsonl'), [
      JSON.stringify({
        id: 'session-cwd',
        thread_name: 'docs-only change',
        updated_at: '2026-04-14T12:05:00.000Z',
      }),
      JSON.stringify({
        id: 'session-repo',
        thread_name: 'repo-wide refactor',
        updated_at: '2026-04-14T12:00:00.000Z',
      }),
      JSON.stringify({
        id: 'session-other',
        thread_name: 'other project work',
        updated_at: '2026-04-14T11:55:00.000Z',
      }),
    ])

    createSessionFile(codexHome, {
      id: 'session-cwd',
      datePath: '2026/04/14',
      cwd: '/workspace/nexus4cc/docs',
    })
    createSessionFile(codexHome, {
      id: 'session-repo',
      datePath: '2026/04/14',
      cwd: '/workspace/nexus4cc/frontend',
    })
    createSessionFile(codexHome, {
      id: 'session-other',
      datePath: '2026/04/14',
      cwd: '/workspace/other-project',
    })

    const gitRoots = new Map([
      ['/workspace/nexus4cc', '/workspace/nexus4cc'],
      ['/workspace/nexus4cc/frontend', '/workspace/nexus4cc'],
      ['/workspace/nexus4cc/docs', ''],
      ['/workspace/other-project', '/workspace/other-project'],
    ])

    const result = listProjectCodexSessions({
      projectName: 'nexus4cc',
      projectPath: '/workspace/nexus4cc',
      codexHome,
      resolveGitRoot: (cwd) => gitRoots.get(cwd) || '',
    })

    assert.equal(result.items.length, 2)
    assert.deepEqual(
      result.items.map(item => ({ id: item.id, attributionKind: item.attributionKind })),
      [
        { id: 'session-cwd', attributionKind: 'cwd' },
        { id: 'session-repo', attributionKind: 'repo-root' },
      ],
    )
    assert.equal(result.items[0].title, 'docs-only change')
    assert.equal(result.scope.repoRoot, '/workspace/nexus4cc')
    assert.equal(result.nextCursor, null)
    assert.ok(result.warning)
    assert.deepEqual(result.warning.codes, ['attribution_unavailable'])
  } finally {
    await rm(codexHome, { recursive: true, force: true })
  }
})

test('listProjectCodexSessions reports partial results when index entries cannot be fully read', async () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'nexus-codex-sessions-'))
  try {
    writeJsonl(join(codexHome, 'session_index.jsonl'), [
      JSON.stringify({
        id: 'session-good',
        thread_name: 'good session',
        updated_at: '2026-04-14T12:00:00.000Z',
      }),
      JSON.stringify({
        id: 'session-missing',
        thread_name: 'missing file session',
        updated_at: '2026-04-14T11:59:00.000Z',
      }),
      JSON.stringify({
        id: 'session-bad',
        thread_name: 'bad meta session',
        updated_at: '2026-04-14T11:58:00.000Z',
      }),
    ])

    createSessionFile(codexHome, {
      id: 'session-good',
      datePath: '2026/04/14',
      cwd: '/workspace/nexus4cc',
    })

    const badDir = join(codexHome, 'sessions', '2026', '04', '14')
    mkdirSync(badDir, { recursive: true })
    writeJsonl(join(badDir, 'rollout-2026-04-14-session-bad.jsonl'), ['not-json'])

    const result = listProjectCodexSessions({
      projectName: 'nexus4cc',
      projectPath: '/workspace/nexus4cc',
      codexHome,
      resolveGitRoot: (cwd) => cwd === '/workspace/nexus4cc' ? '/workspace/nexus4cc' : '',
    })

    assert.equal(result.items.length, 1)
    assert.equal(result.items[0].id, 'session-good')
    assert.ok(result.warning)
    assert.deepEqual(result.warning.codes, ['partial_results'])
  } finally {
    await rm(codexHome, { recursive: true, force: true })
  }
})

test('listProjectCodexSessions paginates with offset cursor', async () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'nexus-codex-sessions-'))
  try {
    writeJsonl(join(codexHome, 'session_index.jsonl'), [
      JSON.stringify({
        id: 'session-3',
        thread_name: 'third',
        updated_at: '2026-04-14T12:03:00.000Z',
      }),
      JSON.stringify({
        id: 'session-2',
        thread_name: 'second',
        updated_at: '2026-04-14T12:02:00.000Z',
      }),
      JSON.stringify({
        id: 'session-1',
        thread_name: 'first',
        updated_at: '2026-04-14T12:01:00.000Z',
      }),
    ])

    for (const id of ['session-1', 'session-2', 'session-3']) {
      createSessionFile(codexHome, {
        id,
        datePath: '2026/04/14',
        cwd: '/workspace/nexus4cc',
      })
    }

    const page1 = listProjectCodexSessions({
      projectName: 'nexus4cc',
      projectPath: '/workspace/nexus4cc',
      codexHome,
      limit: 2,
      resolveGitRoot: (cwd) => cwd === '/workspace/nexus4cc' ? '/workspace/nexus4cc' : '',
    })
    const page2 = listProjectCodexSessions({
      projectName: 'nexus4cc',
      projectPath: '/workspace/nexus4cc',
      codexHome,
      limit: 2,
      cursor: page1.nextCursor,
      resolveGitRoot: (cwd) => cwd === '/workspace/nexus4cc' ? '/workspace/nexus4cc' : '',
    })

    assert.deepEqual(page1.items.map(item => item.id), ['session-3', 'session-2'])
    assert.equal(page1.nextCursor, '2')
    assert.deepEqual(page2.items.map(item => item.id), ['session-1'])
    assert.equal(page2.nextCursor, null)
  } finally {
    await rm(codexHome, { recursive: true, force: true })
  }
})

test('deleteCodexSession removes the matching session file by id', async () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'nexus-codex-sessions-'))
  try {
    writeJsonl(join(codexHome, 'session_index.jsonl'), [
      JSON.stringify({
        id: 'session-delete-me',
        thread_name: 'delete me',
        updated_at: '2026-04-14T12:00:00.000Z',
      }),
      JSON.stringify({
        id: 'session-keep-me',
        thread_name: 'keep me',
        updated_at: '2026-04-14T11:59:00.000Z',
      }),
    ])
    const deletedFile = createSessionFile(codexHome, {
      id: 'session-delete-me',
      datePath: '2026/04/14',
      cwd: '/workspace/nexus4cc',
    })
    const keptFile = createSessionFile(codexHome, {
      id: 'session-keep-me',
      datePath: '2026/04/14',
      cwd: '/workspace/nexus4cc',
    })

    const result = deleteCodexSession({
      sessionId: 'session-delete-me',
      codexHome,
    })

    assert.deepEqual(result, {
      id: 'session-delete-me',
      filePath: deletedFile,
    })
    assert.equal(existsSync(deletedFile), false)
    assert.equal(existsSync(keptFile), true)
    assert.equal(
      readFileSync(join(codexHome, 'session_index.jsonl'), 'utf8').includes('session-delete-me'),
      false,
    )
    assert.equal(
      readFileSync(join(codexHome, 'session_index.jsonl'), 'utf8').includes('session-keep-me'),
      true,
    )

    const listAfterDelete = listProjectCodexSessions({
      projectName: 'nexus4cc',
      projectPath: '/workspace/nexus4cc',
      codexHome,
      resolveGitRoot: (cwd) => cwd === '/workspace/nexus4cc' ? '/workspace/nexus4cc' : '',
    })
    assert.deepEqual(listAfterDelete.items.map(item => item.id), ['session-keep-me'])
    assert.equal(listAfterDelete.warning, null)
  } finally {
    await rm(codexHome, { recursive: true, force: true })
  }
})

test('getProjectCodexSessionDetail exposes only the safe metadata whitelist for matching project sessions', async () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'nexus-codex-sessions-'))
  try {
    writeJsonl(join(codexHome, 'session_index.jsonl'), [
      JSON.stringify({
        id: 'session-detail',
        thread_name: 'detail me',
        updated_at: '2026-04-14T12:00:00.000Z',
      }),
    ])

    createSessionFile(codexHome, {
      id: 'session-detail',
      datePath: '2026/04/14',
      cwd: '/workspace/nexus4cc',
      metaFields: {
        originator: 'codex_cli_rs',
        cli_version: '0.117.0',
        source: 'cli',
        model_provider: 'openai',
        base_instructions: { text: 'must not leak' },
      },
    })

    const detail = getProjectCodexSessionDetail({
      sessionId: 'session-detail',
      projectName: 'nexus4cc',
      projectPath: '/workspace/nexus4cc',
      codexHome,
      resolveGitRoot: (cwd) => cwd === '/workspace/nexus4cc' ? '/workspace/nexus4cc' : '',
    })

    assert.deepEqual(detail, {
      id: 'session-detail',
      title: 'detail me',
      updatedAt: '2026-04-14T12:00:00.000Z',
      startedAt: '2026-04-14T12:00:00.000Z',
      cwd: '/workspace/nexus4cc',
      attributionKind: 'repo-root',
      source: 'cli',
      originator: 'codex_cli_rs',
      cliVersion: '0.117.0',
      modelProvider: 'openai',
    })
    assert.equal('baseInstructions' in detail, false)
  } finally {
    await rm(codexHome, { recursive: true, force: true })
  }
})

test('deleteCodexSession throws when the target session file does not exist', async () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'nexus-codex-sessions-'))
  try {
    assert.throws(
      () => deleteCodexSession({
        sessionId: 'missing-session',
        codexHome,
      }),
      /codex session file not found/i,
    )
  } finally {
    await rm(codexHome, { recursive: true, force: true })
  }
})
