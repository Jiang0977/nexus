import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BINARY = join(
  ROOT,
  'rust-runtime',
  'target',
  'release',
  process.platform === 'win32' ? 'nexus-setup.exe' : 'nexus-setup',
)
let buildChecked = false

function ensureBuilt() {
  if (buildChecked && existsSync(BINARY)) return
  const build = spawnSync('npm', ['run', 'build:rust-setup'], {
    cwd: ROOT,
    encoding: 'utf8',
  })

  assert.equal(build.status, 0, build.stderr || build.stdout)
  assert.equal(existsSync(BINARY), true)
  buildChecked = true
}

function writeExecutable(filePath, content) {
  writeFileSync(filePath, content, { mode: 0o755 })
}

function createSetupFixture() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'nexus-rust-setup-'))
  const binDir = join(fixtureRoot, 'bin')
  const frontendDir = join(fixtureRoot, 'frontend')
  const stateDir = join(fixtureRoot, 'state')
  const npmLogFile = join(stateDir, 'npm.log')
  const pm2LogFile = join(stateDir, 'pm2.log')
  const tmuxLogFile = join(stateDir, 'tmux.log')
  const pm2InstalledMarker = join(stateDir, 'pm2-installed')

  mkdirSync(binDir, { recursive: true })
  mkdirSync(frontendDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })

  writeFileSync(join(fixtureRoot, '.env.example'), 'JWT_SECRET=test\nACC_PASSWORD_HASH=test\n', 'utf8')
  writeFileSync(join(fixtureRoot, 'start.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  writeFileSync(npmLogFile, '', 'utf8')
  writeFileSync(pm2LogFile, '', 'utf8')
  writeFileSync(tmuxLogFile, '', 'utf8')

  writeExecutable(
    join(binDir, 'node'),
    `#!/bin/sh
set -eu
if [ "$#" -gt 0 ] && [ "$1" = "--version" ]; then
  printf 'v20.11.1\\n'
  exit 0
fi
printf 'unexpected node args: %s\\n' "$*" >&2
exit 1
`,
  )

  writeExecutable(
    join(binDir, 'npm'),
    `#!/bin/sh
set -eu
printf '%s|%s\\n' "$PWD" "$*" >> ${JSON.stringify(npmLogFile)}
case "$*" in
  "install"|"run build")
    exit 0
    ;;
  "install -g pm2")
    : > ${JSON.stringify(pm2InstalledMarker)}
    exit 0
    ;;
esac
printf 'unexpected npm args: %s\\n' "$*" >&2
exit 1
`,
  )

  writeExecutable(
    join(binDir, 'pm2'),
    `#!/bin/sh
set -eu
marker=${JSON.stringify(pm2InstalledMarker)}
if [ "$#" -gt 0 ] && [ "$1" = "--version" ]; then
  if [ -f "$marker" ]; then
    printf '5.4.3\\n'
    exit 0
  fi
  exit 1
fi
printf '%s\\n' "$*" >> ${JSON.stringify(pm2LogFile)}
case "$*" in
  "delete nexus"|"start ecosystem.config.cjs"|"save")
    exit 0
    ;;
esac
printf 'unexpected pm2 args: %s\\n' "$*" >&2
exit 1
`,
  )

  writeExecutable(
    join(binDir, 'tmux'),
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> ${JSON.stringify(tmuxLogFile)}
case "$1" in
  -V)
    printf 'tmux 3.4\\n'
    exit 0
    ;;
  has-session)
    exit 1
    ;;
  new-session)
    if [ "$*" = "new-session -d -s main" ]; then
      exit 0
    fi
    ;;
esac
printf 'unexpected tmux args: %s\\n' "$*" >&2
exit 1
`,
  )

  return {
    fixtureRoot,
    binDir,
    frontendDir,
    npmLogFile,
    pm2LogFile,
    tmuxLogFile,
  }
}

test('real rust setup binary provisions env, frontend, pm2, and tmux without node script glue', { skip: process.platform === 'win32' }, () => {
  ensureBuilt()
  const fixture = createSetupFixture()

  try {
    const result = spawnSync(BINARY, [], {
      cwd: fixture.fixtureRoot,
      env: {
        ...process.env,
        PATH: `${fixture.binDir}:${process.env.PATH || ''}`,
      },
      encoding: 'utf8',
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /Nexus setup complete!/)
    assert.equal(
      readFileSync(join(fixture.fixtureRoot, '.env'), 'utf8'),
      'JWT_SECRET=test\nACC_PASSWORD_HASH=test\n',
    )
    assert.equal(existsSync(join(fixture.fixtureRoot, 'ecosystem.config.cjs')), true)
    assert.equal(existsSync(join(fixture.fixtureRoot, 'logs')), true)

    const ecosystemConfig = readFileSync(join(fixture.fixtureRoot, 'ecosystem.config.cjs'), 'utf8')
    assert.match(ecosystemConfig, /name: 'nexus'/)
    assert.match(ecosystemConfig, /script: 'bash'/)
    assert.match(ecosystemConfig, /args: \['\.\/start\.sh'\]/)
    assert.match(ecosystemConfig, new RegExp(`cwd: ${JSON.stringify(fixture.fixtureRoot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))

    const npmLog = readFileSync(fixture.npmLogFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
    assert.deepEqual(npmLog, [
      `${fixture.fixtureRoot}|install`,
      `${fixture.frontendDir}|install`,
      `${fixture.frontendDir}|run build`,
      `${fixture.fixtureRoot}|install -g pm2`,
    ])

    const pm2Log = readFileSync(fixture.pm2LogFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
    assert.deepEqual(pm2Log, [
      'delete nexus',
      'start ecosystem.config.cjs',
      'save',
    ])

    const tmuxLog = readFileSync(fixture.tmuxLogFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
    assert.deepEqual(tmuxLog, [
      '-V',
      'has-session -t main',
      'new-session -d -s main',
    ])
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})
