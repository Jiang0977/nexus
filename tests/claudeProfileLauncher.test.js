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
  const homeDir = join(tempDir, 'home')
  const projectDir = join(tempDir, 'project')
  const argsLog = join(tempDir, 'claude-args.log')
  const envLog = join(tempDir, 'claude-env.log')

  try {
    mkdirSync(fakeBinDir, { recursive: true })
    mkdirSync(join(homeDir, '.cargo', 'bin'), { recursive: true })
    mkdirSync(join(homeDir, '.rustup'), { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(homeDir, '.cargo', 'bin', 'cargo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    writeFileSync(join(fakeBinDir, 'claude'), `#!/bin/sh
printf '%s\\n' "$*" > "${argsLog}"
printf 'CARGO_HOME=%s\\nRUSTUP_HOME=%s\\nPATH=%s\\n' "$CARGO_HOME" "$RUSTUP_HOME" "$PATH" > "${envLog}"
exit 0
`, { mode: 0o755 })

    const result = spawnSync('bash', [join(ROOT, 'nexus-run-claude.sh'), 'cc-switch-claude-official', projectDir], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: homeDir,
        PATH: `${fakeBinDir}:/usr/bin:/bin`,
        CARGO_HOME: '',
        RUSTUP_HOME: '',
      },
      input: 'q\nexit\n',
      encoding: 'utf8',
      timeout: 5000,
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(readFileSync(argsLog, 'utf8'), /--setting-sources project,local/)
    const launcherEnv = readFileSync(envLog, 'utf8')
    assert.match(launcherEnv, new RegExp(`CARGO_HOME=${homeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.cargo`))
    assert.match(launcherEnv, new RegExp(`RUSTUP_HOME=${homeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.rustup`))
    assert.match(launcherEnv, new RegExp(`PATH=${homeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.cargo/bin:`))
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})
