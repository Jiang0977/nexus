import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WRAPPER = join(ROOT, 'scripts', 'runtime-bin', 'codex')
const PICKER = join(ROOT, 'scripts', 'nexus-codex-resume-picker.py')

function writeFakeCodex(path, logFile) {
  writeFileSync(path, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" > "${logFile}"
`, { mode: 0o755 })
}

function seedStateDb(dbPath, rows) {
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      cwd TEXT NOT NULL,
      source TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      updated_at_ms INTEGER,
      first_user_message TEXT NOT NULL DEFAULT ''
    );
  `)
  const insert = db.prepare(`
    INSERT INTO threads (id, title, cwd, source, model_provider, archived, updated_at, updated_at_ms, first_user_message)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
  `)
  for (const row of rows) {
    insert.run(
      row.id,
      row.title,
      row.cwd,
      row.source,
      row.modelProvider,
      row.updatedAt,
      row.updatedAtMs ?? row.updatedAt * 1000,
      row.firstUserMessage ?? '',
    )
  }
  db.close()
}

function seedSessionIndex(indexPath, rows) {
  const content = rows.map((row) => JSON.stringify({
    id: row.id,
    thread_name: row.threadName,
    updated_at: row.updatedAt,
  })).join('\n')
  writeFileSync(indexPath, `${content}\n`, 'utf8')
}

function seedRolloutSession(path, row) {
  const lines = [
    JSON.stringify({
      timestamp: row.envelopeTimestamp ?? row.updatedAt,
      type: 'session_meta',
      payload: {
        id: row.id,
        timestamp: row.startedAt ?? row.updatedAt,
        cwd: row.cwd,
        source: row.source,
        model_provider: row.modelProvider,
      },
    }),
  ]
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
}

test('synced Codex resume picker shows cross-provider cwd matches and forwards the selected thread to the real CLI', { skip: process.platform === 'win32' }, () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'nexus-codex-resume-wrapper-'))
  const sourceHome = join(tempDir, 'source-home')
  const runtimeHome = join(tempDir, 'runtime-home')
  const sourceCodexDir = join(sourceHome, '.codex')
  const runtimeCodexDir = join(runtimeHome, '.codex')
  const fakeRealCodex = join(tempDir, 'real-codex')
  const argsLog = join(tempDir, 'codex-args.log')
  const projectDir = join(tempDir, 'project')

  try {
    mkdirSync(sourceCodexDir, { recursive: true })
    mkdirSync(runtimeCodexDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    writeFakeCodex(fakeRealCodex, argsLog)
    writeFileSync(join(runtimeCodexDir, 'config.toml'), [
      'model_provider = "custom"',
      'model = "gpt-5.4"',
      '',
      '[model_providers.custom]',
      'name = "custom"',
      'base_url = "https://example.com/v1"',
    ].join('\n'))

    seedStateDb(join(sourceCodexDir, 'state_5.sqlite'), [
      {
        id: 'session-cross-provider',
        title: 'Synced cross provider session',
        cwd: projectDir,
        source: 'cli',
        modelProvider: 'openai',
        updatedAt: 1_800_000_300,
      },
      {
        id: 'session-current-provider',
        title: 'Current provider session',
        cwd: projectDir,
        source: 'cli',
        modelProvider: 'custom',
        updatedAt: 1_800_000_200,
      },
      {
        id: 'session-other-cwd',
        title: 'Wrong cwd session',
        cwd: join(tempDir, 'other-project'),
        source: 'cli',
        modelProvider: 'custom',
        updatedAt: 1_800_000_400,
      },
    ])

    const result = spawnSync('bash', [WRAPPER, 'resume'], {
      cwd: projectDir,
      env: {
        ...process.env,
        HOME: runtimeHome,
        NEXUS_REAL_CODEX_BIN: fakeRealCodex,
        NEXUS_REPO_ROOT: ROOT,
        NEXUS_CODEX_SOURCE_HOME: sourceCodexDir,
        NEXUS_FORCE_SYNC_RESUME_PICKER: '1',
      },
      input: '1\n',
      encoding: 'utf8',
      timeout: 5000,
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stderr, /Nexus Synced Codex Sessions/)
    assert.match(result.stderr, /Current provider: custom/)
    assert.match(result.stderr, /provider openai/)
    assert.match(readFileSync(argsLog, 'utf8'), /--dangerously-bypass-approvals-and-sandbox resume session-cross-provider/)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('synced Codex resume picker falls through to the native CLI for resume --last', { skip: process.platform === 'win32' }, () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'nexus-codex-resume-wrapper-pass-through-'))
  const fakeRealCodex = join(tempDir, 'real-codex')
  const argsLog = join(tempDir, 'codex-args.log')

  try {
    writeFakeCodex(fakeRealCodex, argsLog)

    const result = spawnSync('bash', [WRAPPER, 'resume', '--last'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NEXUS_REAL_CODEX_BIN: fakeRealCodex,
        NEXUS_REPO_ROOT: ROOT,
      },
      encoding: 'utf8',
      timeout: 5000,
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(readFileSync(argsLog, 'utf8'), /--dangerously-bypass-approvals-and-sandbox resume --last/)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('codex wrapper forwards the bypass flag only once when caller already supplied it', { skip: process.platform === 'win32' }, () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'nexus-codex-wrapper-bypass-'))
  const fakeRealCodex = join(tempDir, 'real-codex')
  const argsLog = join(tempDir, 'codex-args.log')

  try {
    writeFakeCodex(fakeRealCodex, argsLog)

    const result = spawnSync('bash', [
      WRAPPER,
      '--dangerously-bypass-approvals-and-sandbox',
      '--no-alt-screen',
    ], {
      cwd: ROOT,
      env: {
        ...process.env,
        NEXUS_REAL_CODEX_BIN: fakeRealCodex,
        NEXUS_REPO_ROOT: ROOT,
      },
      encoding: 'utf8',
      timeout: 5000,
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const args = readFileSync(argsLog, 'utf8').trim().split(/\s+/)
    assert.deepEqual(args, ['--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen'])
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('nexus synced resume picker script returns the selected session id', { skip: process.platform === 'win32' }, () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'nexus-codex-resume-picker-script-'))
  const sourceHome = join(tempDir, 'source-home')
  const runtimeHome = join(tempDir, 'runtime-home')
  const sourceCodexDir = join(sourceHome, '.codex')
  const runtimeCodexDir = join(runtimeHome, '.codex')
  const projectDir = join(tempDir, 'project')

  try {
    mkdirSync(sourceCodexDir, { recursive: true })
    mkdirSync(runtimeCodexDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(runtimeCodexDir, 'config.toml'), 'model_provider = "custom"\n', 'utf8')
    seedStateDb(join(sourceCodexDir, 'state_5.sqlite'), [
      {
        id: 'session-picker-target',
        title: 'Picker target session',
        cwd: projectDir,
        source: 'cli',
        modelProvider: 'openai',
        updatedAt: 1_800_001_000,
      },
    ])

    const result = spawnSync('python3', [PICKER], {
      cwd: projectDir,
      env: {
        ...process.env,
        HOME: runtimeHome,
        NEXUS_CODEX_SOURCE_HOME: sourceCodexDir,
      },
      input: '1\n',
      encoding: 'utf8',
      timeout: 5000,
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(result.stdout.trim(), 'session-picker-target')
    assert.match(result.stderr, /Picker target session/)
    assert.match(result.stderr, /Current provider: custom/)
    assert.match(result.stderr, /provider openai/)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('nexus synced resume picker includes rollout sessions missing from state sqlite so cross-provider history still appears', { skip: process.platform === 'win32' }, () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'nexus-codex-resume-picker-rollout-fallback-'))
  const sourceHome = join(tempDir, 'source-home')
  const runtimeHome = join(tempDir, 'runtime-home')
  const sourceCodexDir = join(sourceHome, '.codex')
  const runtimeCodexDir = join(runtimeHome, '.codex')
  const projectDir = join(tempDir, 'project')
  const rolloutDir = join(sourceCodexDir, 'sessions', '2026', '04', '25')

  try {
    mkdirSync(sourceCodexDir, { recursive: true })
    mkdirSync(runtimeCodexDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(rolloutDir, { recursive: true })
    writeFileSync(join(runtimeCodexDir, 'config.toml'), 'model_provider = "xmapi"\n', 'utf8')
    seedStateDb(join(sourceCodexDir, 'state_5.sqlite'), [])
    seedSessionIndex(join(sourceCodexDir, 'session_index.jsonl'), [
      {
        id: 'session-rollout-only',
        threadName: 'Rollout only session',
        updatedAt: '2026-04-25T07:58:29.531Z',
      },
    ])
    seedRolloutSession(
      join(rolloutDir, 'rollout-2026-04-25T15-58-29-session-rollout-only.jsonl'),
      {
        id: 'session-rollout-only',
        updatedAt: '2026-04-25T07:58:29.531Z',
        cwd: projectDir,
        source: 'cli',
        modelProvider: 'tokenx24',
      },
    )

    const result = spawnSync('python3', [PICKER], {
      cwd: projectDir,
      env: {
        ...process.env,
        HOME: runtimeHome,
        NEXUS_CODEX_SOURCE_HOME: sourceCodexDir,
      },
      input: '1\n',
      encoding: 'utf8',
      timeout: 5000,
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(result.stdout.trim(), 'session-rollout-only')
    assert.match(result.stderr, /Rollout only session/)
    assert.match(result.stderr, /provider tokenx24/)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})
