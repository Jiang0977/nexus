import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('importing frontend shellType does not emit module typeless warning', () => {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "await import('./frontend/src/shellType.ts')"],
    { cwd: ROOT, encoding: 'utf8' },
  )

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.doesNotMatch(result.stderr, /MODULE_TYPELESS_PACKAGE_JSON/)
})
