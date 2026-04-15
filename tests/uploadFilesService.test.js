import test from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createUploadFilesService, UploadFilesError } from '../uploadFilesService.js'

function createService(overrides = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'nexus-upload-files-'))
  const workspaceRoot = join(rootDir, 'workspace')
  const uploadsDir = join(rootDir, 'uploads')
  mkdirSync(workspaceRoot, { recursive: true })
  mkdirSync(uploadsDir, { recursive: true })

  const execCalls = []
  const execSyncImpl = (command, options = {}) => {
    execCalls.push(command)
    if (typeof overrides.execSyncImpl === 'function') {
      return overrides.execSyncImpl(command, options)
    }
    return ''
  }

  const service = createUploadFilesService({
    workspaceRoot,
    uploadsDir,
    tmuxSession: 'nexus',
    execSyncImpl,
    currentDateDirImpl: () => '2026-04-15',
    ...overrides,
  })

  return {
    rootDir,
    workspaceRoot,
    uploadsDir,
    service,
    execCalls,
  }
}

test('resolveWorkspaceUploadDestination prefers the named window and otherwise falls back to the active window', async () => {
  const harness = createService({
    execSyncImpl(command) {
      if (command.includes('tmux list-windows -t "nexus" -F "#I:#W:#{pane_current_path}"')) {
        return `1:notes:${join(harness.rootDir, 'named-target')}\n2:shell:${join(harness.rootDir, 'other-target')}\n`
      }
      if (command.includes('tmux list-windows -t "nexus" -F "#I:#W:#{pane_current_path}:#{window_active}"')) {
        return `1:notes:${join(harness.rootDir, 'named-target')}:0\n2:shell:${join(harness.rootDir, 'active-target')}:1\n`
      }
      return ''
    },
  })
  mkdirSync(join(harness.rootDir, 'named-target'))
  mkdirSync(join(harness.rootDir, 'active-target'))

  try {
    assert.equal(
      harness.service.resolveWorkspaceUploadDestination('notes'),
      join(harness.rootDir, 'named-target'),
    )
    assert.equal(
      harness.service.resolveWorkspaceUploadDestination(''),
      join(harness.rootDir, 'active-target'),
    )
  } finally {
    return rm(harness.rootDir, { recursive: true, force: true })
  }
})

test('resolveWorkspaceUploadDestination falls back to workspaceRoot when tmux cwd is missing on disk', async () => {
  const harness = createService({
    execSyncImpl(command) {
      if (command.includes('tmux list-windows -t "nexus" -F "#I:#W:#{pane_current_path}:#{window_active}"')) {
        return '1:shell:/missing/path:1\n'
      }
      return ''
    },
  })

  try {
    assert.equal(harness.service.resolveWorkspaceUploadDestination(''), harness.workspaceRoot)
  } finally {
    return rm(harness.rootDir, { recursive: true, force: true })
  }
})

test('saveManagedUploadFile writes the file into the dated uploads directory and reports conflicts', async () => {
  const harness = createService()

  try {
    const saved = harness.service.saveManagedUploadFile({
      fileBuffer: Buffer.from('hello'),
      originalName: 'image?.png',
      preferredName: '截图?.png',
      size: 5,
      overwrite: false,
    })

    assert.deepEqual(saved, {
      ok: true,
      filename: '截图_.png',
      url: '/uploads/2026-04-15/截图_.png',
      fullPath: join(harness.uploadsDir, '2026-04-15', '截图_.png'),
      size: 5,
      originalName: '截图?.png',
    })
    assert.equal(readFileSync(saved.fullPath, 'utf8'), 'hello')

    assert.throws(
      () => harness.service.saveManagedUploadFile({
        fileBuffer: Buffer.from('world'),
        originalName: 'image?.png',
        preferredName: '截图?.png',
        size: 5,
        overwrite: false,
      }),
      (error) => error instanceof UploadFilesError
        && error.statusCode === 409
        && error.responseBody?.error === 'file exists'
        && error.responseBody?.filename === '截图_.png',
    )
  } finally {
    return rm(harness.rootDir, { recursive: true, force: true })
  }
})

test('listManagedFiles groups uploads by date and sorts files by modified time descending', async () => {
  const harness = createService()
  mkdirSync(join(harness.uploadsDir, '2026-04-14'))
  mkdirSync(join(harness.uploadsDir, '2026-04-15'))
  writeFileSync(join(harness.uploadsDir, '2026-04-14', 'older.txt'), 'old', 'utf8')
  writeFileSync(join(harness.uploadsDir, '2026-04-15', 'first.txt'), 'first', 'utf8')
  writeFileSync(join(harness.uploadsDir, '2026-04-15', 'second.txt'), 'second', 'utf8')
  utimesSync(join(harness.uploadsDir, '2026-04-14', 'older.txt'), new Date('2026-04-14T10:00:00Z'), new Date('2026-04-14T10:00:00Z'))
  utimesSync(join(harness.uploadsDir, '2026-04-15', 'first.txt'), new Date('2026-04-15T10:00:00Z'), new Date('2026-04-15T10:00:00Z'))
  utimesSync(join(harness.uploadsDir, '2026-04-15', 'second.txt'), new Date('2026-04-15T11:00:00Z'), new Date('2026-04-15T11:00:00Z'))

  try {
    const listed = harness.service.listManagedFiles()

    assert.deepEqual(listed.map((group) => group.date), ['2026-04-15', '2026-04-14'])
    assert.deepEqual(listed[0].files.map((file) => file.name), ['second.txt', 'first.txt'])
    assert.equal(listed[0].files[0].url, '/uploads/2026-04-15/second.txt')
  } finally {
    return rm(harness.rootDir, { recursive: true, force: true })
  }
})

test('deleteManagedFile and deleteAllManagedFiles preserve legacy response shapes', async () => {
  const harness = createService()
  const dayOneDir = join(harness.uploadsDir, '2026-04-15')
  const dayTwoDir = join(harness.uploadsDir, '2026-04-16')
  mkdirSync(dayOneDir)
  mkdirSync(dayTwoDir)
  writeFileSync(join(dayOneDir, 'first.txt'), 'first', 'utf8')
  writeFileSync(join(dayTwoDir, 'second.txt'), 'second', 'utf8')

  try {
    assert.deepEqual(
      harness.service.deleteManagedFile({ date: '2026-04-15', filename: 'first.txt' }),
      { ok: true },
    )
    assert.equal(existsSync(join(dayOneDir, 'first.txt')), false)

    assert.throws(
      () => harness.service.deleteManagedFile({ date: '2026-04-15', filename: 'missing.txt' }),
      (error) => error instanceof UploadFilesError
        && error.statusCode === 404
        && error.message === 'file not found',
    )

    assert.deepEqual(harness.service.deleteAllManagedFiles(), {
      ok: true,
      deletedCount: 1,
    })
    assert.equal(existsSync(dayTwoDir), false)
  } finally {
    return rm(harness.rootDir, { recursive: true, force: true })
  }
})
