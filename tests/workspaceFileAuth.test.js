import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

test('WorkspaceBrowser fetches workspace files with Authorization header and object URLs without leaking token in query', () => {
  const filePath = path.resolve(process.cwd(), 'frontend/src/WorkspaceBrowser.tsx')
  const content = fs.readFileSync(filePath, 'utf8')

  // Must not append token query parameter to workspace URL
  assert.doesNotMatch(
    content,
    /\/workspace\?[^`'"]*token=/,
    'Workspace file URL must not contain token in query params'
  )

  // Must perform authenticated fetch with headers for openFile and downloadFile
  assert.match(
    content,
    /fetch\(\s*url\s*,\s*\{\s*headers\s*\}\s*\)/,
    'Workspace file open/download must use fetch with Authorization headers'
  )

  // Must create and revoke object URLs
  assert.match(
    content,
    /URL\.createObjectURL\(/,
    'Workspace file handling must use URL.createObjectURL'
  )
  assert.match(
    content,
    /URL\.revokeObjectURL\(/,
    'Workspace file handling must revoke object URLs'
  )
})
