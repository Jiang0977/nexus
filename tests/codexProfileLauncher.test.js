import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

test('profile Codex launcher preserves host rust toolchain env after HOME isolation', { skip: process.platform === 'win32' }, () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'nexus-codex-profile-launcher-'))
  const fakeBinDir = join(tempDir, 'bin')
  const homeDir = join(tempDir, 'home')
  const projectDir = join(tempDir, 'project')
  const argsLog = join(tempDir, 'codex-args.log')
  const envLog = join(tempDir, 'codex-env.log')
  const fakeCodexHome = join(tempDir, 'fake-codex-home.sh')

  try {
    mkdirSync(fakeBinDir, { recursive: true })
    mkdirSync(join(homeDir, '.cargo', 'bin'), { recursive: true })
    mkdirSync(join(homeDir, '.rustup'), { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(homeDir, '.cargo', 'bin', 'cargo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    writeFileSync(fakeCodexHome, '#!/bin/sh\nmkdir -p "$2/.codex"\nexit 0\n', { mode: 0o755 })
    writeFileSync(join(fakeBinDir, 'codex'), `#!/bin/sh
printf '%s\\n' "$*" > "${argsLog}"
printf 'HOME=%s\\nCARGO_HOME=%s\\nRUSTUP_HOME=%s\\nPATH=%s\\n' "$HOME" "$CARGO_HOME" "$RUSTUP_HOME" "$PATH" > "${envLog}"
exit 0
`, { mode: 0o755 })

    const result = spawnSync('bash', [join(ROOT, 'nexus-run-codex.sh'), '', projectDir, ''], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: homeDir,
        PATH: `${fakeBinDir}:/usr/bin:/bin`,
        NEXUS_CODEX_HOME_EXECUTABLE: fakeCodexHome,
        CARGO_HOME: '',
        RUSTUP_HOME: '',
      },
      input: 'q\n',
      encoding: 'utf8',
      timeout: 5000,
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const launcherEnv = readFileSync(envLog, 'utf8')
    assert.match(launcherEnv, /HOME=.*data\/codex-runtime\//)
    assert.match(launcherEnv, new RegExp(`CARGO_HOME=${escapeForRegExp(homeDir)}/\\.cargo`))
    assert.match(launcherEnv, new RegExp(`RUSTUP_HOME=${escapeForRegExp(homeDir)}/\\.rustup`))
    assert.match(launcherEnv, new RegExp(`PATH=.*${escapeForRegExp(homeDir)}/\\.cargo/bin`))
    assert.match(readFileSync(argsLog, 'utf8'), /--dangerously-bypass-approvals-and-sandbox --no-alt-screen/)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})
