import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import bcrypt from 'bcrypt'

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
  if (buildChecked && existsSync(BINARY) && existsSync(NATIVE_SESSION_BINARY)) return
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

function createSetupFixture({ envExampleContent = 'JWT_SECRET=\nACC_PASSWORD_HASH=\n', initialEnvContent = null } = {}) {
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

  writeFileSync(join(fixtureRoot, '.env.example'), envExampleContent, 'utf8')
  if (initialEnvContent !== null) {
    writeFileSync(join(fixtureRoot, '.env'), initialEnvContent, 'utf8')
  }
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

test('real rust setup binary provisions secure env, frontend, systemd units, 0600 mode and valid bcrypt password', { skip: process.platform === 'win32' }, () => {
  ensureBuilt()
  const fixture = createSetupFixture({
    envExampleContent: 'HOST=127.0.0.1\nJWT_SECRET=\nACC_PASSWORD_HASH=\n',
  })

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
    assert.match(result.stdout, /Password:\s+(\S+)\s+\(one-time generated/)

    const passwordMatch = result.stdout.match(/Password:\s+(\S+)\s+\(one-time generated/)
    assert.ok(passwordMatch, 'one-time password must be shown in stdout banner')
    const oneTimePassword = passwordMatch[1]

    const envContent = readFileSync(join(fixture.fixtureRoot, '.env'), 'utf8')
    assert.doesNotMatch(envContent, /JWT_SECRET=\n/)
    assert.doesNotMatch(envContent, /ACC_PASSWORD_HASH=\n/)
    assert.doesNotMatch(envContent, /fcea4c5c28bee4c9fa7adca25c947f87b2a7179202c824d185618d3b3bf2a333/)
    assert.doesNotMatch(envContent, /\$2b\$12\$5xRyI8a3yVhcCHqYP\/Pdju\/mKjxtxjWihXE1VpaXCdnuM6VUVNUsW/)

    const jwtMatch = envContent.match(/^JWT_SECRET=(.+)$/m)
    const hashMatch = envContent.match(/^ACC_PASSWORD_HASH=(.+)$/m)
    assert.ok(jwtMatch && jwtMatch[1].length >= 64, 'JWT_SECRET should be at least 32 random bytes hex (64 chars)')
    assert.ok(hashMatch, 'ACC_PASSWORD_HASH should be present')
    assert.equal(bcrypt.compareSync(oneTimePassword, hashMatch[1]), true, 'Bcrypt hash in .env must verify one-time password')

    const stats = statSync(join(fixture.fixtureRoot, '.env'))
    const mode = stats.mode & 0o777
    assert.equal(mode, 0o600, '.env must be restricted to 0600 permissions')

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

test('real rust setup binary migrates insecure legacy defaults and preserves custom credentials', { skip: process.platform === 'win32' }, () => {
  ensureBuilt()
  const legacyFixture = createSetupFixture({
    initialEnvContent: 'HOST=127.0.0.1\nJWT_SECRET=fcea4c5c28bee4c9fa7adca25c947f87b2a7179202c824d185618d3b3bf2a333\nACC_PASSWORD_HASH=$2b$12$5xRyI8a3yVhcCHqYP/Pdju/mKjxtxjWihXE1VpaXCdnuM6VUVNUsW\n',
  })

  try {
    const result = spawnSync(BINARY, [], {
      cwd: legacyFixture.fixtureRoot,
      env: {
        ...process.env,
        HOME: legacyFixture.homeDir,
        PATH: `${legacyFixture.binDir}:${process.env.PATH || ''}`,
      },
      encoding: 'utf8',
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const envContent = readFileSync(join(legacyFixture.fixtureRoot, '.env'), 'utf8')
    assert.doesNotMatch(envContent, /fcea4c5c28bee4c9fa7adca25c947f87b2a7179202c824d185618d3b3bf2a333/)
    assert.doesNotMatch(envContent, /\$2b\$12\$5xRyI8a3yVhcCHqYP\/Pdju\/mKjxtxjWihXE1VpaXCdnuM6VUVNUsW/)
    assert.match(result.stdout, /replaced insecure credentials/)
  } finally {
    rmSync(legacyFixture.fixtureRoot, { recursive: true, force: true })
  }

  const customHash = bcrypt.hashSync('my-custom-pass', 10)
  const customFixture = createSetupFixture({
    initialEnvContent: `HOST=127.0.0.1\nJWT_SECRET=my-custom-jwt-secret-value-32charslong\nACC_PASSWORD_HASH=${customHash}\n`,
  })

  try {
    const result = spawnSync(BINARY, [], {
      cwd: customFixture.fixtureRoot,
      env: {
        ...process.env,
        HOME: customFixture.homeDir,
        PATH: `${customFixture.binDir}:${process.env.PATH || ''}`,
      },
      encoding: 'utf8',
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const envContent = readFileSync(join(customFixture.fixtureRoot, '.env'), 'utf8')
    assert.match(envContent, /JWT_SECRET=my-custom-jwt-secret-value-32charslong/)
    assert.match(envContent, new RegExp(`ACC_PASSWORD_HASH=${customHash.replace(/\$/g, '\\$')}`))
    assert.match(result.stdout, /retained existing custom password/)
  } finally {
    rmSync(customFixture.fixtureRoot, { recursive: true, force: true })
  }
})
