import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const FRONTEND_SRC = join(ROOT, '..', 'frontend', 'src')

function readFrontend(relativePath) {
  return readFileSync(join(FRONTEND_SRC, relativePath), 'utf8')
}

function extractFileInputs(source) {
  const inputs = []
  const tagRe = /<input\b[\s\S]*?>/g
  for (const match of source.matchAll(tagRe)) {
    const tag = match[0]
    if (!/\btype=["']file["']/.test(tag)) continue
    const acceptMatch = tag.match(/\baccept=["']([^"']*)["']/)
    inputs.push({
      tag,
      accept: acceptMatch ? acceptMatch[1] : '',
    })
  }
  return inputs
}

function isUnrestrictedAccept(accept) {
  return accept === '' || accept === '*/*' || accept === '*'
}

test('terminal upload picker accepts any file type', () => {
  const inputs = extractFileInputs(readFrontend('Terminal.tsx'))
  assert.ok(inputs.length >= 1, 'Terminal.tsx must render a file picker')
  for (const input of inputs) {
    assert.ok(
      isUnrestrictedAccept(input.accept),
      `terminal file picker must accept any file, got accept="${input.accept}"`,
    )
  }
})

test('toolbar upload pickers accept any file except the photos shortcut', () => {
  const inputs = extractFileInputs(readFrontend('Toolbar.tsx'))
  assert.ok(inputs.length >= 2, 'Toolbar.tsx must render upload file pickers')

  const restricted = inputs.filter((input) => !isUnrestrictedAccept(input.accept))
  assert.equal(
    restricted.length,
    1,
    'only the photos shortcut may keep an image-only accept filter',
  )
  assert.match(restricted[0].tag, /mediaInputId/)
  assert.match(restricted[0].accept, /^image\//)
})

test('clipboard paste uploads any file, not just images', () => {
  const artifacts = readFrontend('terminal/useTerminalArtifacts.ts')
  assert.match(
    artifacts,
    /kind\s*===\s*['"]file['"]/,
    'paste handler must accept clipboard files by kind, not image MIME only',
  )
  assert.doesNotMatch(
    artifacts,
    /type\.startsWith\(['"]image\//,
    'paste handler must not ignore non-image files',
  )
})
