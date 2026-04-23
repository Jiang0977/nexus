import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('profile Claude launcher excludes user settings so selected profile env wins', { skip: process.platform === 'win32' }, () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'nexus-claude-profile-launcher-'))
  const fakeBinDir = join(tempDir, 'bin')
  const projectDir = join(tempDir, 'project')
  const argsLog = join(tempDir, 'claude-args.log')

  try {
    mkdirSync(fakeBinDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(fakeBinDir, 'claude'), `#!/bin/sh
printf '%s\\n' "$*" > "${argsLog}"
exit 0
`, { mode: 0o755 })

    const result = spawnSync('bash', [join(ROOT, 'nexus-run-claude.sh'), 'cc-switch-claude-official', projectDir], {
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
      },
      input: 'q\nexit\n',
      encoding: 'utf8',
      timeout: 5000,
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(readFileSync(argsLog, 'utf8'), /--setting-sources project,local/)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})
