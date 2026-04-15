import test from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { WorkspaceError, createWorkspaceService } from '../workspaceService.js'

test('browseDirectories and listEntries filter hidden entries and return metadata', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'nexus-workspace-'))
  mkdirSync(join(rootDir, 'docs'))
  mkdirSync(join(rootDir, '.hidden-dir'))
  writeFileSync(join(rootDir, 'notes.txt'), 'hello', 'utf8')
  writeFileSync(join(rootDir, '.hidden-file'), 'secret', 'utf8')

  const workspace = createWorkspaceService({ workspaceRoot: rootDir })

  try {
    const browsed = workspace.browseDirectories('')
    assert.equal(browsed.path, rootDir)
    assert.deepEqual(browsed.dirs.map(entry => entry.name), ['docs'])

    const listed = workspace.listEntries('')
    assert.deepEqual(
      listed.entries.map(entry => ({ name: entry.name, type: entry.type })),
      [
        { name: 'docs', type: 'dir' },
        { name: 'notes.txt', type: 'file' },
      ],
    )
    assert.equal(listed.entries.find(entry => entry.name === 'notes.txt').size, 5)
  } finally {
    return rm(rootDir, { recursive: true, force: true })
  }
})

test('workspace service supports create, read, write, rename, copy, move, and delete', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'nexus-workspace-'))
  mkdirSync(join(rootDir, 'docs'))

  const workspace = createWorkspaceService({ workspaceRoot: rootDir })

  try {
    const createdDir = workspace.createDirectory({ path: 'docs', name: 'guides' })
    assert.equal(createdDir.path, join(rootDir, 'docs', 'guides'))

    const createdFile = workspace.createFile({ path: 'docs/guides', name: 'intro.md', content: '# hello' })
    assert.equal(createdFile.path, join(rootDir, 'docs', 'guides', 'intro.md'))

    assert.deepEqual(workspace.readFileContent('docs/guides/intro.md'), {
      path: join(rootDir, 'docs', 'guides', 'intro.md'),
      content: '# hello',
    })

    workspace.writeFileContent({ path: 'docs/guides/intro.md', content: '# updated' })
    assert.equal(readFileSync(join(rootDir, 'docs', 'guides', 'intro.md'), 'utf8'), '# updated')

    const renamed = workspace.renameEntry({ path: 'docs/guides/intro.md', newName: 'readme.md' })
    assert.equal(renamed.path, join(rootDir, 'docs', 'guides', 'readme.md'))

    const copied = workspace.copyEntry({ sourcePath: 'docs/guides/readme.md', targetPath: 'docs/guides/copy.md' })
    assert.equal(copied.path, join(rootDir, 'docs', 'guides', 'copy.md'))
    assert.equal(readFileSync(copied.path, 'utf8'), '# updated')

    const moved = workspace.moveEntry({ sourcePath: 'docs/guides/copy.md', targetPath: 'docs/copied.md' })
    assert.equal(moved.path, join(rootDir, 'docs', 'copied.md'))
    assert.equal(existsSync(join(rootDir, 'docs', 'guides', 'copy.md')), false)

    assert.deepEqual(workspace.deleteEntry('docs/copied.md'), { ok: true })
    assert.equal(existsSync(join(rootDir, 'docs', 'copied.md')), false)

    assert.throws(
      () => workspace.createDirectory({ path: 'docs', name: 'guides' }),
      (error) => error instanceof WorkspaceError && error.statusCode === 409,
    )
  } finally {
    return rm(rootDir, { recursive: true, force: true })
  }
})

test('resolveServeFilePath serves workspace-relative request paths and missing files fail with 404', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'nexus-workspace-'))
  mkdirSync(join(rootDir, 'docs'))
  writeFileSync(join(rootDir, 'docs', 'readme.md'), 'hello', 'utf8')

  const workspace = createWorkspaceService({ workspaceRoot: rootDir })

  try {
    const resolved = workspace.resolveServeFilePath({ requestPath: '/docs/readme.md' })
    assert.equal(resolved, join(rootDir, 'docs', 'readme.md'))

    assert.throws(
      () => workspace.resolveServeFilePath({ requestPath: '/docs/missing.md' }),
      (error) => error instanceof WorkspaceError && error.statusCode === 404,
    )
  } finally {
    return rm(rootDir, { recursive: true, force: true })
  }
})
