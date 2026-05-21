import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const NATIVE_SESSION_BINARY = join(
  ROOT,
  'rust-runtime',
  'target',
  'release',
  process.platform === 'win32' ? 'nexus-native-session.exe' : 'nexus-native-session',
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
  assert.equal(existsSync(NATIVE_SESSION_BINARY), true)
  buildChecked = true
}

function writeExecutable(filePath, content) {
  writeFileSync(filePath, content, { mode: 0o755 })
}

function createSetupFixture() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'nexus-rust-setup-'))
  const binDir = join(fixtureRoot, 'bin')
  const frontendDir = join(fixtureRoot, 'frontend')
  const frontendDistDir = join(frontendDir, 'dist')
  const stateDir = join(fixtureRoot, 'state')
  const homeDir = join(fixtureRoot, 'home')
  const fixtureNativeSessionBinary = join(
    fixtureRoot,
    'rust-runtime',
    'target',
    'release',
    process.platform === 'win32' ? 'nexus-native-session.exe' : 'nexus-native-session',
  )
  const systemctlLogFile = join(stateDir, 'systemctl.log')
  const tmuxLogFile = join(stateDir, 'tmux.log')

  mkdirSync(binDir, { recursive: true })
  mkdirSync(frontendDistDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  mkdirSync(homeDir, { recursive: true })
  mkdirSync(dirname(fixtureNativeSessionBinary), { recursive: true })

  writeFileSync(join(fixtureRoot, '.env.example'), 'JWT_SECRET=test\nACC_PASSWORD_HASH=test\n', 'utf8')
  writeFileSync(join(frontendDistDir, 'index.html'), '<!doctype html><html><body>fixture</body></html>\n', 'utf8')
  writeFileSync(join(fixtureRoot, 'start.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  copyFileSync(NATIVE_SESSION_BINARY, fixtureNativeSessionBinary)
  writeFileSync(systemctlLogFile, '', 'utf8')
  writeFileSync(tmuxLogFile, '', 'utf8')

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

  writeExecutable(
    join(binDir, 'systemctl'),
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> ${JSON.stringify(systemctlLogFile)}
case "$*" in
  "--user --version"|"--version"|"--user daemon-reload"|"--user enable --now nexus-tmux.service"|"--user enable --now nexus-native-pty.service"|"--user enable --now nexus.service")
    exit 0
    ;;
esac
printf 'unexpected systemctl args: %s\\n' "$*" >&2
exit 1
`,
  )

  return {
    fixtureRoot,
    binDir,
    frontendDir,
    homeDir,
    systemctlLogFile,
    tmuxLogFile,
  }
}

test('real rust setup binary provisions env, frontend, systemd units, and tmux without node script glue', { skip: process.platform === 'win32' }, () => {
  ensureBuilt()
  const fixture = createSetupFixture()

  try {
    const result = spawnSync(BINARY, [], {
      cwd: fixture.fixtureRoot,
      env: {
        ...process.env,
        HOME: fixture.homeDir,
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
    const systemctlLog = readFileSync(fixture.systemctlLogFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
    assert.deepEqual(systemctlLog, [
      '--user --version',
      '--user daemon-reload',
      '--user enable --now nexus-tmux.service',
      '--user enable --now nexus-native-pty.service',
      '--user enable --now nexus.service',
    ])

    const userSystemdDir = join(fixture.homeDir, '.config', 'systemd', 'user')
    const nexusService = readFileSync(join(userSystemdDir, 'nexus.service'), 'utf8')
    const tmuxService = readFileSync(join(userSystemdDir, 'nexus-tmux.service'), 'utf8')
    const nativePtyService = readFileSync(join(userSystemdDir, 'nexus-native-pty.service'), 'utf8')
    assert.match(nexusService, /Description=Nexus service/)
    assert.match(nexusService, /KillMode=control-group/)
    assert.match(tmuxService, /Persistent tmux server for Nexus/)
    assert.match(tmuxService, /start-foreground/)
    assert.match(tmuxService, /ensure-session/)
    assert.match(nativePtyService, /Persistent native PTY supervisor for Nexus/)

    const tmuxLog = readFileSync(fixture.tmuxLogFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
    assert.deepEqual(tmuxLog, ['-V'])
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})
