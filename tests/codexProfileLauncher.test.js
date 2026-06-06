import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
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
  const pollutedHome = join(tempDir, 'runtime-home')
  const projectDir = join(tempDir, 'project')
  const argsLog = join(tempDir, 'codex-args.log')
  const envLog = join(tempDir, 'codex-env.log')
  const fakeCodexHome = join(tempDir, 'fake-codex-home.sh')
  const codexHomeEnvLog = join(tempDir, 'codex-home-env.log')
  const fakeGhBin = join(fakeBinDir, 'gh')
  const ghEnvLog = join(tempDir, 'gh-env.log')
  const fakeSvnBin = join(fakeBinDir, 'svn')
  const svnArgsLog = join(tempDir, 'svn-args.log')

  try {
    mkdirSync(fakeBinDir, { recursive: true })
    mkdirSync(join(homeDir, '.cargo', 'bin'), { recursive: true })
    mkdirSync(join(homeDir, '.rustup'), { recursive: true })
    mkdirSync(join(homeDir, '.codex', 'skills', 'my-custom-skill'), { recursive: true })
    mkdirSync(join(homeDir, '.config', 'gh'), { recursive: true })
    mkdirSync(join(homeDir, '.subversion'), { recursive: true })
    mkdirSync(pollutedHome, { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(homeDir, '.cargo', 'bin', 'cargo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    writeFileSync(join(homeDir, '.codex', 'skills', 'my-custom-skill', 'SKILL.md'), '# custom skill\n', 'utf8')
    writeFileSync(fakeCodexHome, `#!/bin/sh
printf 'HOME=%s\\n' "$HOME" > "${codexHomeEnvLog}"
mkdir -p "$2/.codex"
exit 0
`, { mode: 0o755 })
    writeFileSync(join(fakeBinDir, 'codex'), `#!/bin/sh
printf '%s\\n' "$*" > "${argsLog}"
printf 'HOME=%s\\nCARGO_HOME=%s\\nRUSTUP_HOME=%s\\nNEXUS_SOURCE_HOME=%s\\nPATH=%s\\n' "$HOME" "$CARGO_HOME" "$RUSTUP_HOME" "$NEXUS_SOURCE_HOME" "$PATH" > "${envLog}"
exit 0
`, { mode: 0o755 })
    writeFileSync(fakeGhBin, `#!/bin/sh
printf 'GH_CONFIG_DIR=%s\\nHOME=%s\\n' "$GH_CONFIG_DIR" "$HOME" > "${ghEnvLog}"
exit 0
`, { mode: 0o755 })
    writeFileSync(fakeSvnBin, `#!/bin/sh
printf '%s\\n' "$*" > "${svnArgsLog}"
exit 0
`, { mode: 0o755 })

    const result = spawnSync('bash', [join(ROOT, 'nexus-run-codex.sh'), '', projectDir, ''], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: pollutedHome,
        NEXUS_SOURCE_HOME: homeDir,
        PATH: `${join(ROOT, 'scripts', 'runtime-bin')}:${fakeBinDir}:/usr/bin:/bin`,
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
    assert.match(readFileSync(codexHomeEnvLog, 'utf8'), new RegExp(`HOME=${escapeForRegExp(homeDir)}`))
    assert.match(launcherEnv, /HOME=.*data\/codex-runtime\//)
    assert.match(launcherEnv, new RegExp(`CARGO_HOME=${escapeForRegExp(homeDir)}/\\.cargo`))
    assert.match(launcherEnv, new RegExp(`RUSTUP_HOME=${escapeForRegExp(homeDir)}/\\.rustup`))
    assert.match(launcherEnv, new RegExp(`NEXUS_SOURCE_HOME=${escapeForRegExp(homeDir)}`))
    assert.match(launcherEnv, new RegExp(`PATH=.*${escapeForRegExp(homeDir)}/\\.cargo/bin`))
    assert.match(readFileSync(argsLog, 'utf8'), /--dangerously-bypass-approvals-and-sandbox --no-alt-screen/)
    const runtimeHome = launcherEnv.match(/^HOME=(.*)$/m)?.[1]
    assert.ok(runtimeHome)
    assert.equal(
      readlinkSync(join(runtimeHome, '.codex', 'skills')),
      join(homeDir, '.codex', 'skills'),
    )

    const ghResult = spawnSync('gh', ['auth', 'status'], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: pollutedHome,
        NEXUS_SOURCE_HOME: homeDir,
        PATH: `${join(ROOT, 'scripts', 'runtime-bin')}:${fakeBinDir}:/usr/bin:/bin`,
      },
      encoding: 'utf8',
    })
    assert.equal(ghResult.status, 0, ghResult.stderr || ghResult.stdout)
    assert.match(readFileSync(ghEnvLog, 'utf8'), new RegExp(`GH_CONFIG_DIR=${escapeForRegExp(homeDir)}/\\.config/gh`))

    const ghExplicitResult = spawnSync('gh', ['auth', 'status'], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: pollutedHome,
        NEXUS_SOURCE_HOME: homeDir,
        GH_CONFIG_DIR: '/manual-gh-config',
        PATH: `${join(ROOT, 'scripts', 'runtime-bin')}:${fakeBinDir}:/usr/bin:/bin`,
      },
      encoding: 'utf8',
    })
    assert.equal(ghExplicitResult.status, 0, ghExplicitResult.stderr || ghExplicitResult.stdout)
    assert.match(readFileSync(ghEnvLog, 'utf8'), /GH_CONFIG_DIR=\/manual-gh-config/)

    const svnResult = spawnSync('svn', ['status'], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: pollutedHome,
        NEXUS_SOURCE_HOME: homeDir,
        PATH: `${join(ROOT, 'scripts', 'runtime-bin')}:${fakeBinDir}:/usr/bin:/bin`,
      },
      encoding: 'utf8',
    })
    assert.equal(svnResult.status, 0, svnResult.stderr || svnResult.stdout)
    assert.match(readFileSync(svnArgsLog, 'utf8'), new RegExp(`--config-dir ${escapeForRegExp(homeDir)}/\\.subversion`))

    const svnExplicitResult = spawnSync('svn', ['--config-dir', '/manual-svn-config', 'status'], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: pollutedHome,
        NEXUS_SOURCE_HOME: homeDir,
        PATH: `${join(ROOT, 'scripts', 'runtime-bin')}:${fakeBinDir}:/usr/bin:/bin`,
      },
      encoding: 'utf8',
    })
    assert.equal(svnExplicitResult.status, 0, svnExplicitResult.stderr || svnExplicitResult.stdout)
    assert.match(readFileSync(svnArgsLog, 'utf8'), /--config-dir \/manual-svn-config status/)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('profile Codex launcher does not duplicate bypass when resolved codex wrapper already adds it', { skip: process.platform === 'win32' }, () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'nexus-codex-profile-wrapper-bypass-'))
  const wrapperBinDir = join(tempDir, 'wrapper-bin')
  const realBinDir = join(tempDir, 'real-bin')
  const homeDir = join(tempDir, 'home')
  const projectDir = join(tempDir, 'project')
  const fakeCodexHome = join(tempDir, 'fake-codex-home.sh')
  const argsLog = join(tempDir, 'codex-args.log')

  try {
    mkdirSync(wrapperBinDir, { recursive: true })
    mkdirSync(realBinDir, { recursive: true })
    mkdirSync(homeDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(fakeCodexHome, `#!/bin/sh
mkdir -p "$2/.codex"
exit 0
`, { mode: 0o755 })
    writeFileSync(join(realBinDir, 'codex-real'), `#!/bin/sh
printf '%s\\n' "$*" > "${argsLog}"
exit 0
`, { mode: 0o755 })
    writeFileSync(join(wrapperBinDir, 'codex'), `#!/usr/bin/env bash
set -euo pipefail
exec "${join(realBinDir, 'codex-real')}" --dangerously-bypass-approvals-and-sandbox --disable apps "$@"
`, { mode: 0o755 })

    const result = spawnSync('bash', [join(ROOT, 'nexus-run-codex.sh'), '', projectDir, ''], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: homeDir,
        NEXUS_SOURCE_HOME: homeDir,
        PATH: `${wrapperBinDir}:/usr/bin:/bin`,
        NEXUS_CODEX_HOME_EXECUTABLE: fakeCodexHome,
      },
      input: 'q\n',
      encoding: 'utf8',
      timeout: 5000,
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const args = readFileSync(argsLog, 'utf8').trim().split(/\s+/)
    assert.deepEqual(args, [
      '--dangerously-bypass-approvals-and-sandbox',
      '--disable',
      'apps',
      '--no-alt-screen',
    ])
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('profile Codex launcher uses explicit native runtime id before tmux window id', { skip: process.platform === 'win32' }, () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'nexus-codex-profile-native-runtime-'))
  const fakeBinDir = join(tempDir, 'bin')
  const homeDir = join(tempDir, 'home')
  const dataDir = join(tempDir, 'data')
  const projectDir = join(tempDir, 'project')
  const fakeCodexHome = join(tempDir, 'fake-codex-home.sh')
  const envLog = join(tempDir, 'codex-env.log')
  const tmuxLog = join(tempDir, 'tmux.log')

  try {
    mkdirSync(fakeBinDir, { recursive: true })
    mkdirSync(homeDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(fakeCodexHome, `#!/bin/sh
mkdir -p "$2/.codex"
exit 0
`, { mode: 0o755 })
    writeFileSync(join(fakeBinDir, 'codex'), `#!/bin/sh
printf 'HOME=%s\\n' "$HOME" > "${envLog}"
exit 0
`, { mode: 0o755 })
    writeFileSync(join(fakeBinDir, 'tmux'), `#!/bin/sh
printf '%s\\n' "$*" > "${tmuxLog}"
exit 1
`, { mode: 0o755 })

    const result = spawnSync('bash', [join(ROOT, 'nexus-run-codex.sh'), '', projectDir, ''], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: homeDir,
        NEXUS_SOURCE_HOME: homeDir,
        NEXUS_DATA_DIR: dataDir,
        NEXUS_CODEX_RUNTIME_ID: 'native:native-codex:1',
        PATH: `${fakeBinDir}:/usr/bin:/bin`,
        NEXUS_CODEX_HOME_EXECUTABLE: fakeCodexHome,
      },
      input: 'q\n',
      encoding: 'utf8',
      timeout: 5000,
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(readFileSync(envLog, 'utf8'), `HOME=${join(dataDir, 'codex-runtime', 'native-native-codex-1')}\n`)
    assert.throws(() => readFileSync(tmuxLog, 'utf8'), { code: 'ENOENT' })
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})
