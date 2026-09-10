import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readlinkSync, readdirSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const RELEASE_BIN_NAMES = [
  "nexus-server",
  "nexus-pty-runtime",
  "nexus-native-pty-supervisor",
  "nexus-native-session",
  "nexus-window-launch-runtime",
  "nexus-session-runtime",
  "nexus-codex-home",
]

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const START_SCRIPT = readFileSync(join(ROOT, 'start.sh'), 'utf8')
const NEXUS_PATHS_SCRIPT = readFileSync(join(ROOT, 'scripts', 'nexus-paths.sh'), 'utf8')
const DEPLOY_SERVICE_SCRIPT = readFileSync(join(ROOT, 'scripts', 'deploy-nexus-service.sh'), 'utf8')
const SYSTEMD_SCRIPT = readFileSync(join(ROOT, 'scripts', 'nexus-systemd.sh'), 'utf8')
const RESTART_SERVICE_SCRIPT = readFileSync(join(ROOT, 'scripts', 'restart-nexus-service.sh'), 'utf8')

function createFakeRustServerScript(envFile) {
  return `#!/bin/sh
set -eu
{
  printf 'PORT=%s\\n' "\${PORT:-}"
  printf 'SERVER_EXECUTABLE=%s\\n' "$0"
  printf 'NEXUS_PTY_BROKER_RUST_EXECUTABLE=%s\\n' "\${NEXUS_PTY_BROKER_RUST_EXECUTABLE:-}"
  printf 'NEXUS_WINDOW_LAUNCH_RUST_EXECUTABLE=%s\\n' "\${NEXUS_WINDOW_LAUNCH_RUST_EXECUTABLE:-}"
  printf 'NEXUS_SESSION_MANAGEMENT_RUST_EXECUTABLE=%s\\n' "\${NEXUS_SESSION_MANAGEMENT_RUST_EXECUTABLE:-}"
} > ${JSON.stringify(envFile)}
`
}

function writeExecutable(filePath, content = '#!/bin/sh\nexit 0\n') {
  writeFileSync(filePath, content, { mode: 0o755 })
}

function parseEnvDump(filePath) {
  return Object.fromEntries(
    readFileSync(filePath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [key, ...rest] = line.split('=')
        return [key, rest.join('=')]
      }),
  )
}

function createStartScriptFixture() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'nexus-start-script-'))
  const envFile = join(fixtureRoot, '.env')
  const cargoLogFile = join(fixtureRoot, 'cargo.log')
  const serverEnvFile = join(fixtureRoot, 'server-env.log')
  const binDir = join(fixtureRoot, 'bin')
  const scriptsDir = join(fixtureRoot, 'scripts')
  const frontendDistDir = join(fixtureRoot, 'frontend', 'dist')
  const releaseDir = join(fixtureRoot, 'rust-runtime', 'target', 'release')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(scriptsDir, { recursive: true })
  mkdirSync(frontendDistDir, { recursive: true })
  mkdirSync(releaseDir, { recursive: true })
  mkdirSync(join(fixtureRoot, 'node_modules'), { recursive: true })

  writeFileSync(envFile, 'JWT_SECRET=test\nACC_PASSWORD_HASH=test\n', 'utf8')
  writeFileSync(cargoLogFile, '', 'utf8')
  writeFileSync(join(fixtureRoot, 'start.sh'), START_SCRIPT, { mode: 0o755 })
  writeFileSync(join(scriptsDir, 'nexus-paths.sh'), NEXUS_PATHS_SCRIPT, { mode: 0o755 })
  writeFileSync(join(frontendDistDir, 'index.html'), '<!doctype html><html><body>fixture</body></html>\n')

  writeExecutable(
    join(binDir, 'cargo'),
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> ${JSON.stringify(cargoLogFile)}
mkdir -p rust-runtime/target/release
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--bin" ] && [ "$#" -ge 2 ]; then
    shift
    case "$1" in
      nexus-server)
        cat > rust-runtime/target/release/nexus-server <<'EOF_SERVER'
${createFakeRustServerScript(serverEnvFile)}
EOF_SERVER
        chmod +x rust-runtime/target/release/nexus-server
        ;;
      *)
        cat > "rust-runtime/target/release/$1" <<'EOF_RUNTIME'
#!/bin/sh
exit 0
EOF_RUNTIME
        chmod +x "rust-runtime/target/release/$1"
        ;;
    esac
  fi
  shift
done
`,
  )

  return {
    fixtureRoot,
    binDir,
    cargoLogFile,
    serverEnvFile,
    releaseDir,
  }
}

function runStartScript(fixture, envOverrides = {}) {
  return spawnSync('bash', ['./start.sh'], {
    cwd: fixture.fixtureRoot,
    env: {
      ...process.env,
      PATH: `${fixture.binDir}:${process.env.PATH || ''}`,
      PORT: '59001',
      ...envOverrides,
    },
    encoding: 'utf8',
  })
}

function createDeployScriptFixture({ separateInstallTree = false } = {}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'nexus-deploy-script-'))
  const cargoLogFile = join(fixtureRoot, 'cargo.log')
  const restartLogFile = join(fixtureRoot, 'restart.log')
  const restartCountFile = join(fixtureRoot, 'restart-count')
  const systemctlLogFile = join(fixtureRoot, 'systemctl.log')
  const syncFailOnceFile = join(fixtureRoot, 'sync-fail-once')
  const homeDir = join(fixtureRoot, 'home')
  const binDir = join(fixtureRoot, 'bin')
  const scriptsDir = join(fixtureRoot, 'scripts')
  const frontendDistDir = join(fixtureRoot, 'frontend', 'dist')
  const releaseDir = join(fixtureRoot, 'rust-runtime', 'target', 'release')

  // When a separate install tree is requested we materialize an isolated
  // tree under the fixture. The fixture scripts never read it directly; the
  // deploy script must learn about it either through NEXUS_INSTALL_ROOT
  // (passed by the test) or via systemctl show (fake binary configured
  // below).
  const installRoot = separateInstallTree
    ? join(fixtureRoot, 'install-tree')
    : fixtureRoot
  const installFrontendDist = join(installRoot, 'frontend', 'dist')
  const installReleaseDir = join(installRoot, 'rust-runtime', 'target', 'release')

  mkdirSync(binDir, { recursive: true })
  mkdirSync(homeDir, { recursive: true })
  mkdirSync(scriptsDir, { recursive: true })
  mkdirSync(frontendDistDir, { recursive: true })
  mkdirSync(releaseDir, { recursive: true })
  mkdirSync(join(fixtureRoot, 'rust-runtime'), { recursive: true })
  if (separateInstallTree) {
    mkdirSync(installFrontendDist, { recursive: true })
    mkdirSync(installReleaseDir, { recursive: true })
    mkdirSync(join(installRoot, 'frontend'), { recursive: true })
    // Provide every Nexus-install-tree marker so resolve_install_root accepts
    // the path under the stricter rule.
    writeFileSync(join(installRoot, '.env'), 'NEXUS_PORT=59000\n', 'utf8')
    writeFileSync(join(installRoot, 'start.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  }

  writeFileSync(cargoLogFile, '', 'utf8')
  writeFileSync(restartLogFile, '', 'utf8')
  writeFileSync(systemctlLogFile, '', 'utf8')
  writeFileSync(join(scriptsDir, 'nexus-systemd.sh'), SYSTEMD_SCRIPT)
  writeFileSync(join(fixtureRoot, 'scripts', 'deploy-nexus-service.sh'), DEPLOY_SERVICE_SCRIPT, { mode: 0o755 })
  writeFileSync(join(frontendDistDir, 'index.html'), '<!doctype html><html><body>checkout</body></html>\n')
  writeFileSync(join(frontendDistDir, 'checkout-asset.js'), '// checkout-asset\n', 'utf8')
  writeFileSync(join(fixtureRoot, 'rust-runtime', 'Cargo.toml'), '[package]\nname = "fixture"\nversion = "0.0.0"\n', 'utf8')

  for (const binary of [
    'nexus-server',
    'nexus-pty-runtime',
    'nexus-native-pty-supervisor',
    'nexus-native-session',
    'nexus-window-launch-runtime',
    'nexus-session-runtime',
    'nexus-codex-home',
  ]) {
    writeFileSync(join(releaseDir, binary), `old-${binary}\n`, { mode: 0o755 })
    if (separateInstallTree) {
      writeFileSync(join(installReleaseDir, binary), `old-install-${binary}\n`, { mode: 0o755 })
    }
  }
  if (separateInstallTree) {
    // Pre-populate the install tree's frontend dist with an extra file the
    // checkout bundle does not have, to verify old hashed assets get pruned
    // and the install tree's frontend matches the checkout exactly after
    // sync.
    writeFileSync(join(installFrontendDist, 'index.html'), '<!doctype html><html><body>install</body></html>\n')
    writeFileSync(join(installFrontendDist, 'install-stale-asset.js'), '// stale\n', 'utf8')
  }

  writeExecutable(
    join(binDir, 'cargo'),
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> ${JSON.stringify(cargoLogFile)}
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--bin" ] && [ "$#" -ge 2 ]; then
    shift
    printf 'new-%s\\n' "$1" > "rust-runtime/target/release/$1"
    chmod +x "rust-runtime/target/release/$1"
  fi
  shift
done
`,
  )
  writeExecutable(
    join(binDir, 'sudo'),
    `#!/bin/sh
set -eu
if [ "$1" = "-n" ]; then
  shift
fi
exec "$@"
`,
  )
  const fakeSystemctlBody = separateInstallTree
    ? `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> ${JSON.stringify(systemctlLogFile)}
if [ "$1" = "show" ]; then
  printf '%s\\n' "${installRoot}"
  exit 0
fi
if [ "$1" = "is-active" ]; then
  exit 0
fi
exit 0
`
    : `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> ${JSON.stringify(systemctlLogFile)}
if [ "$1" = "is-active" ]; then
  exit 0
fi
exit 0
`
  writeExecutable(join(binDir, 'systemctl'), fakeSystemctlBody)

  return {
    fixtureRoot,
    cargoLogFile,
    restartLogFile,
    restartCountFile,
    systemctlLogFile,
    homeDir,
    releaseDir,
    scriptsDir,
    binDir,
    installRoot,
    installReleaseDir,
    installFrontendDist,
    separateInstallTree,
  }
}

function runDeployScript(fixture, envOverrides = {}, args = []) {
  return spawnSync('bash', ['./scripts/deploy-nexus-service.sh', ...args], {
    cwd: fixture.fixtureRoot,
    env: {
      ...process.env,
      NEXUS_SERVICE_SCOPE: 'system',
      HOME: fixture.homeDir,
      PATH: `${fixture.binDir}:${process.env.PATH || ''}`,
      ...envOverrides,
    },
    encoding: 'utf8',
  })
}

test('package.json keeps rust startup scripts and declares browser regression tooling explicitly', () => {
  const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(packageJson.scripts.start, 'bash ./start.sh')
  assert.equal(packageJson.scripts['deploy:service'], 'bash ./scripts/deploy-nexus-service.sh')
  assert.equal(packageJson.scripts['restart:service'], 'bash ./scripts/restart-nexus-service.sh')
  assert.equal(packageJson.scripts.test, 'npm run test:rust && npm run test:node')
  assert.equal(packageJson.scripts['test:browser'], 'node --test tests/browserTerminalRegression.test.js')
  assert.equal(packageJson.scripts['smoke:login-upload'], 'node scripts/login-upload-smoke.mjs')
  assert.equal(packageJson.scripts['test:rust'], 'cargo test --manifest-path rust-runtime/Cargo.toml && cargo test --manifest-path rust-runtime/vendor/avt/Cargo.toml --lib')
  assert.equal(packageJson.scripts['smoke:native'], 'node scripts/native-terminal-acceptance.mjs')
  assert.equal(packageJson.scripts['test:node'], 'node --test tests/*.test.js')
  assert.equal(packageJson.scripts['typecheck:frontend'], 'npm --prefix frontend run typecheck')
  assert.equal(packageJson.scripts['build:frontend'], 'npm --prefix frontend run build')
  assert.equal(packageJson.scripts['check:frontend-dist'], 'npm run build:frontend && node ./scripts/check-frontend-dist.mjs')
  assert.equal(packageJson.scripts.check, 'npm run test:rust && npm run test:node && npm run check:frontend-dist')
  assert.equal(
    packageJson.scripts.setup,
    'bash ./setup.sh',
  )
  assert.equal(
    packageJson.scripts['build:rust-setup'],
    'cargo build --manifest-path rust-runtime/Cargo.toml --release --bin nexus-setup --bin nexus-native-session',
  )
  assert.equal(packageJson.scripts['build:rust-codex-home'], 'cargo build --manifest-path rust-runtime/Cargo.toml --release --bin nexus-codex-home')
  assert.equal('build:server' in packageJson.scripts, false)
  assert.equal('typecheck:server' in packageJson.scripts, false)
  assert.equal('dependencies' in packageJson, false)
  assert.equal(packageJson.devDependencies.playwright, '^1.58.2')
  assert.deepEqual(Object.keys(packageJson.devDependencies).sort(), ['@types/node', 'bcrypt', 'playwright', 'typescript', 'ws'])
})

test('frontend package exposes explicit typecheck and build guardrails', () => {
  const packageJson = JSON.parse(readFileSync(join(ROOT, 'frontend', 'package.json'), 'utf8'))
  assert.equal(packageJson.scripts.typecheck, 'tsc')
  assert.equal(packageJson.scripts.build, 'npm run typecheck && vite build')
})

test('repository exposes CI and frontend dist drift guardrails', () => {
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  const checkScript = readFileSync(join(ROOT, 'scripts', 'check-frontend-dist.mjs'), 'utf8')
  const envExample = readFileSync(join(ROOT, '.env.example'), 'utf8')

  assert.match(workflow, /npm ci/)
  assert.match(workflow, /playwright install --with-deps chromium/)
  assert.match(workflow, /npm --prefix frontend ci/)
  assert.match(workflow, /npm run check/)
  assert.match(checkScript, /frontend\/dist is out of sync/)
  assert.match(envExample, /^PORT=59000$/m)
  assert.match(envExample, /^GITHUB_REPO=Jiang0977\/nexus$/m)
})

test('legacy node backend source files are removed from the repo root', () => {
  for (const relativePath of [
    'server.js',
    'runtimePaths.js',
    'ptyBrokerController.js',
    'ptyBrokerLocalBackend.js',
    'ptyBrokerSidecarClient.js',
    'ptyBrokerSidecarProcess.js',
    'ptyTmuxBroker.js',
    'windowLaunchService.js',
    'sessionManagementService.js',
    'ptyBrokerRustClient.js',
    'windowLaunchRustClient.js',
    'sessionManagementRustClient.js',
    'configProfilesService.js',
    'workspaceService.js',
    'versionService.js',
    'uploadFilesService.js',
    'serverConfig.js',
    'gracefulShutdown.js',
    'runtimeGuards.js',
    'codexSessions.js',
    'codexSessionWindows.js',
    'tmuxSessionPolicy.js',
    'ccSwitchConfig.js',
    'projectDefaults.js',
  ]) {
    assert.equal(existsSync(join(ROOT, relativePath)), false, `${relativePath} should be removed`)
  }
})

test('repo root no longer keeps js source files', () => {
  const rootJsFiles = readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => entry.name)
    .sort()

  assert.deepEqual(rootJsFiles, [])
})

test('legacy node setup script is removed in favor of the rust setup binary', () => {
  assert.equal(existsSync(join(ROOT, 'scripts', 'setup.js')), false)
})

test('nexus-run-codex.sh uses the rust codex home tool instead of a node materialize wrapper', () => {
  const runCodexScript = readFileSync(join(ROOT, 'nexus-run-codex.sh'), 'utf8')
  assert.match(runCodexScript, /nexus-codex-home/)
  assert.doesNotMatch(runCodexScript, /materialize-codex-home\.mjs/)
  assert.doesNotMatch(runCodexScript, /node "\$\{SCRIPT_DIR\}\/scripts\/materialize-codex-home\.mjs"/)
})

test('restart helper selects service scope and accepts auth-gated healthchecks', () => {
  assert.match(RESTART_SERVICE_SCRIPT, /nexus_resolve_service_scope/)
  assert.match(RESTART_SERVICE_SCRIPT, /nexus_systemctl restart/)
  assert.match(RESTART_SERVICE_SCRIPT, /mktemp \/tmp\/nexus-healthcheck/)
  assert.match(RESTART_SERVICE_SCRIPT, /"\$\{http_code\}" != "200"/)
  assert.match(RESTART_SERVICE_SCRIPT, /"\$\{http_code\}" != "401"/)
})

test('deploy helper builds release binaries and invokes the configured restart helper', () => {
  const fixture = createDeployScriptFixture()
  writeExecutable(
    join(fixture.scriptsDir, 'fake-restart.sh'),
    `#!/bin/sh
set -eu
printf 'restart-ok\\n' >> ${JSON.stringify(fixture.restartLogFile)}
`,
  )

  try {
    const result = runDeployScript(fixture, {
      NEXUS_RESTART_HELPER: './scripts/fake-restart.sh',
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /\[Nexus\] Building release binaries/)
    assert.match(result.stdout, /not restarting it to preserve native sessions/)
    assert.match(result.stdout, /\[Nexus\] Deploy complete\./)

    const cargoLog = readFileSync(fixture.cargoLogFile, 'utf8')
    assert.match(cargoLog, /--manifest-path rust-runtime\/Cargo.toml --release/)
    assert.match(cargoLog, /--bin nexus-server/)
    assert.match(cargoLog, /--bin nexus-session-runtime/)
    assert.match(cargoLog, /--bin nexus-codex-home/)
    assert.equal(readFileSync(join(fixture.releaseDir, 'nexus-server'), 'utf8'), 'new-nexus-server\n')
    assert.equal(readFileSync(join(fixture.releaseDir, 'nexus-codex-home'), 'utf8'), 'new-nexus-codex-home\n')
    assert.equal(
      readlinkSync(join(fixture.homeDir, '.local/bin/nexus-native-session')),
      join(fixture.fixtureRoot, 'rust-runtime/target/release/nexus-native-session'),
    )
    assert.equal(readFileSync(fixture.restartLogFile, 'utf8'), 'restart-ok\n')
    const systemctlLog = readFileSync(fixture.systemctlLogFile, 'utf8')
    assert.match(systemctlLog, /show nexus\.service -p WorkingDirectory --value\n/)
    assert.match(systemctlLog, /is-active --quiet nexus-native-pty\.service\n/)
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('deploy helper only restarts native PTY supervisor when explicitly requested', () => {
  const fixture = createDeployScriptFixture()
  writeExecutable(
    join(fixture.scriptsDir, 'fake-restart.sh'),
    `#!/bin/sh
set -eu
printf 'restart-ok\\n' >> ${JSON.stringify(fixture.restartLogFile)}
`,
  )

  try {
    const result = runDeployScript(fixture, {
      NEXUS_RESTART_HELPER: './scripts/fake-restart.sh',
    }, ['--restart-native-pty'])
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /\[Nexus\] Restarting native PTY supervisor/)
    const systemctlLog10 = readFileSync(fixture.systemctlLogFile, 'utf8')
    assert.match(systemctlLog10, /show nexus\.service -p WorkingDirectory --value\n/)
    assert.match(systemctlLog10, /is-active --quiet nexus-native-pty\.service\n/)
    assert.match(systemctlLog10, /restart nexus-native-pty\.service\n/)
    assert.match(systemctlLog10, /status nexus-native-pty\.service --no-pager\n/)
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('deploy helper restores the previous release binaries when restart fails', () => {
  const fixture = createDeployScriptFixture()
  writeExecutable(
    join(fixture.scriptsDir, 'fake-restart.sh'),
    `#!/bin/sh
set -eu
count=0
if [ -f ${JSON.stringify(fixture.restartCountFile)} ]; then
  count="$(cat ${JSON.stringify(fixture.restartCountFile)})"
fi
count=$((count + 1))
printf '%s' "$count" > ${JSON.stringify(fixture.restartCountFile)}
printf 'attempt=%s\\n' "$count" >> ${JSON.stringify(fixture.restartLogFile)}
if [ "$count" -eq 1 ]; then
  exit 1
fi
`,
  )

  try {
    const result = runDeployScript(fixture, {
      NEXUS_RESTART_HELPER: './scripts/fake-restart.sh',
    })
    assert.equal(result.status, 1, result.stderr || result.stdout)
    assert.match(result.stderr, /Deploy restart failed; restoring previous release binaries/)
    assert.match(result.stderr, /Rollback completed\./)
    assert.equal(readFileSync(join(fixture.releaseDir, 'nexus-server'), 'utf8'), 'old-nexus-server\n')
    assert.equal(readFileSync(fixture.restartLogFile, 'utf8'), 'attempt=1\nattempt=2\n')
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('start.sh defaults to rust nexus-server and wires runtime executables without invoking npm when release binaries already exist', () => {
  const fixture = createStartScriptFixture()
  const defaultServer = join(fixture.releaseDir, 'nexus-server')
  const defaultPtyRuntime = join(fixture.releaseDir, 'nexus-pty-runtime')
  const defaultNativePtySupervisor = join(fixture.releaseDir, 'nexus-native-pty-supervisor')
  const defaultNativeSessionCli = join(fixture.releaseDir, 'nexus-native-session')
  const defaultWindowLaunchRuntime = join(fixture.releaseDir, 'nexus-window-launch-runtime')
  const defaultSessionRuntime = join(fixture.releaseDir, 'nexus-session-runtime')
  const defaultCodexHomeRuntime = join(fixture.releaseDir, 'nexus-codex-home')

  writeExecutable(defaultServer, createFakeRustServerScript(fixture.serverEnvFile))
  writeExecutable(defaultPtyRuntime)
  writeExecutable(defaultNativePtySupervisor)
  writeExecutable(defaultNativeSessionCli)
  writeExecutable(defaultWindowLaunchRuntime)
  writeExecutable(defaultSessionRuntime)
  writeExecutable(defaultCodexHomeRuntime)

  try {
    const result = runStartScript(fixture)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /启动 Nexus Rust server on :59001/)

    const serverEnv = parseEnvDump(fixture.serverEnvFile)
    assert.equal(serverEnv.PORT, '59001')
    assert.equal(serverEnv.SERVER_EXECUTABLE, defaultServer)
    assert.equal(serverEnv.NEXUS_PTY_BROKER_RUST_EXECUTABLE, defaultPtyRuntime)
    assert.equal(serverEnv.NEXUS_WINDOW_LAUNCH_RUST_EXECUTABLE, defaultWindowLaunchRuntime)
    assert.equal(serverEnv.NEXUS_SESSION_MANAGEMENT_RUST_EXECUTABLE, defaultSessionRuntime)

    const cargoLog = readFileSync(fixture.cargoLogFile, 'utf8')
    assert.equal(cargoLog, '')
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('start.sh builds missing rust release binaries before launching the default rust server', () => {
  const fixture = createStartScriptFixture()

  try {
    const result = runStartScript(fixture)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /构建 Rust runtimes/)
    assert.match(result.stdout, /构建 Rust server/)
    assert.match(result.stdout, /启动 Nexus Rust server on :59001/)

    const cargoCommands = readFileSync(fixture.cargoLogFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
    assert.equal(cargoCommands.length, 2)
    assert.match(cargoCommands[0], /build --manifest-path rust-runtime\/Cargo\.toml --release --bin nexus-pty-runtime --bin nexus-native-pty-supervisor --bin nexus-native-session --bin nexus-window-launch-runtime --bin nexus-session-runtime --bin nexus-codex-home/)
    assert.match(cargoCommands[1], /build --manifest-path rust-runtime\/Cargo\.toml --release --bin nexus-server/)

    const serverEnv = parseEnvDump(fixture.serverEnvFile)
    assert.equal(serverEnv.PORT, '59001')
    assert.equal(
      serverEnv.SERVER_EXECUTABLE,
      join(fixture.releaseDir, 'nexus-server'),
    )
    assert.equal(
      serverEnv.NEXUS_PTY_BROKER_RUST_EXECUTABLE,
      join(fixture.releaseDir, 'nexus-pty-runtime'),
    )
    assert.equal(
      serverEnv.NEXUS_WINDOW_LAUNCH_RUST_EXECUTABLE,
      join(fixture.releaseDir, 'nexus-window-launch-runtime'),
    )
    assert.equal(
      serverEnv.NEXUS_SESSION_MANAGEMENT_RUST_EXECUTABLE,
      join(fixture.releaseDir, 'nexus-session-runtime'),
    )
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('deploy helper rejects NEXUS_INSTALL_ROOT set to filesystem root before running cargo', () => {
  const fixture = createDeployScriptFixture()
  writeExecutable(
    join(fixture.scriptsDir, 'fake-restart.sh'),
    "#!/bin/sh\nset -eu\nprintf 'restart-ok\\n' >> " + JSON.stringify(fixture.restartLogFile) + "\n",
  )

  try {
    const result = runDeployScript(fixture, {
      NEXUS_RESTART_HELPER: './scripts/fake-restart.sh',
      NEXUS_INSTALL_ROOT: '/',
    })
    assert.notEqual(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stderr, /install root resolved to filesystem root/)
    // Cargo must not have been invoked at all.
    assert.equal(readFileSync(fixture.cargoLogFile, 'utf8'), '')
    // Restart helper must not have been invoked either.
    const restartLog = existsSync(fixture.restartLogFile) ? readFileSync(fixture.restartLogFile, 'utf8') : ''
    assert.equal(restartLog, '')
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('deploy helper syncs binaries and frontend into a separate install tree, prunes stale assets, and points CLI symlink at install binary', () => {
  const fixture = createDeployScriptFixture({ separateInstallTree: true })
  writeExecutable(
    join(fixture.scriptsDir, 'fake-restart.sh'),
    "#!/bin/sh\nset -eu\nprintf 'restart-ok\\n' >> " + JSON.stringify(fixture.restartLogFile) + "\n",
  )

  try {
    const result = runDeployScript(fixture, {
      NEXUS_RESTART_HELPER: './scripts/fake-restart.sh',
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /Install root:/)

    // Checkout binaries got rebuilt (new content from fake cargo).
    assert.equal(readFileSync(join(fixture.releaseDir, 'nexus-server'), 'utf8'), 'new-nexus-server\n')
    assert.equal(readFileSync(join(fixture.releaseDir, 'nexus-codex-home'), 'utf8'), 'new-nexus-codex-home\n')

    // Install tree binaries are mirrored from checkout.
    assert.equal(readFileSync(join(fixture.installReleaseDir, 'nexus-server'), 'utf8'), 'new-nexus-server\n')
    assert.equal(readFileSync(join(fixture.installReleaseDir, 'nexus-codex-home'), 'utf8'), 'new-nexus-codex-home\n')
    assert.equal(readFileSync(join(fixture.installReleaseDir, 'nexus-session-runtime'), 'utf8'), 'new-nexus-session-runtime\n')
    assert.equal(readFileSync(join(fixture.installReleaseDir, 'nexus-window-launch-runtime'), 'utf8'), 'new-nexus-window-launch-runtime\n')

    // All install-tree binaries must be executable.
    for (const binary of [
      'nexus-server',
      'nexus-pty-runtime',
      'nexus-native-pty-supervisor',
      'nexus-native-session',
      'nexus-window-launch-runtime',
      'nexus-session-runtime',
      'nexus-codex-home',
    ]) {
      const p = join(fixture.installReleaseDir, binary)
      assert.ok(existsSync(p), `missing ${p}`)
      const st = statSync(p)
      assert.ok((st.mode & 0o111) !== 0, `${p} is not executable`)
    }

    // Install frontend matches checkout frontend exactly (no stale files).
    const checkoutFiles = readdirSync(join(fixture.fixtureRoot, 'frontend', 'dist')).sort()
    const installFiles = readdirSync(fixture.installFrontendDist).sort()
    assert.deepEqual(installFiles, checkoutFiles)
    assert.equal(readFileSync(join(fixture.installFrontendDist, 'index.html'), 'utf8'),
      '<!doctype html><html><body>checkout</body></html>\n')
    assert.equal(readFileSync(join(fixture.installFrontendDist, 'checkout-asset.js'), 'utf8'),
      '// checkout-asset\n')
    assert.equal(existsSync(join(fixture.installFrontendDist, 'install-stale-asset.js')), false)
    assert.equal(existsSync(join(fixture.installRoot, 'frontend', '.dist-staging')), false)
    assert.equal(existsSync(join(fixture.installRoot, 'frontend', '.dist-prev')), false)

    // CLI symlink points at the install-tree binary, not a checkout path.
    assert.equal(
      readlinkSync(join(fixture.homeDir, '.local/bin/nexus-native-session')),
      join(fixture.installRoot, 'rust-runtime/target/release/nexus-native-session'),
    )

    assert.equal(readFileSync(fixture.restartLogFile, 'utf8'), 'restart-ok\n')
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('deploy helper restores checkout and install tree binaries/frontend when restart fails once', () => {
  const fixture = createDeployScriptFixture({ separateInstallTree: true })
  writeExecutable(
    join(fixture.scriptsDir, 'fake-restart.sh'),
    "#!/bin/sh\nset -eu\ncount=0\nif [ -f " + JSON.stringify(fixture.restartCountFile) + " ]; then\n  count=\"$(cat " + JSON.stringify(fixture.restartCountFile) + ")\"\nfi\ncount=$((count + 1))\nprintf '%s' \"$count\" > " + JSON.stringify(fixture.restartCountFile) + "\nprintf 'attempt=%s\\n' \"$count\" >> " + JSON.stringify(fixture.restartLogFile) + "\nif [ \"$count\" -eq 1 ]; then\n  exit 1\nfi\n",
  )

  try {
    const result = runDeployScript(fixture, {
      NEXUS_RESTART_HELPER: './scripts/fake-restart.sh',
    })
    assert.equal(result.status, 1, result.stderr || result.stdout)
    assert.match(result.stderr, /Deploy restart failed; restoring previous release binaries and frontend/)
    assert.match(result.stderr, /Rollback completed/)

    // Restart helper ran twice: once (failed) on deploy, once after rollback.
    assert.equal(readFileSync(fixture.restartLogFile, 'utf8'), 'attempt=1\nattempt=2\n')

    // Checkout release binaries restored to old content.
    assert.equal(readFileSync(join(fixture.releaseDir, 'nexus-server'), 'utf8'), 'old-nexus-server\n')
    assert.equal(readFileSync(join(fixture.releaseDir, 'nexus-codex-home'), 'utf8'), 'old-nexus-codex-home\n')

    // Install tree release binaries restored to old content.
    assert.equal(readFileSync(join(fixture.installReleaseDir, 'nexus-server'), 'utf8'), 'old-install-nexus-server\n')
    assert.equal(readFileSync(join(fixture.installReleaseDir, 'nexus-codex-home'), 'utf8'), 'old-install-nexus-codex-home\n')

    // Install frontend restored verbatim: contains the stale install asset
    // and lacks the checkout-only asset.
    assert.equal(existsSync(join(fixture.installFrontendDist, 'install-stale-asset.js')), true)
    assert.equal(readFileSync(join(fixture.installFrontendDist, 'index.html'), 'utf8'),
      '<!doctype html><html><body>install</body></html>\n')
    assert.equal(existsSync(join(fixture.installFrontendDist, 'checkout-asset.js')), false)

    // No leftover staging directories.
    assert.equal(existsSync(join(fixture.installRoot, 'frontend', '.dist-staging')), false)
    assert.equal(existsSync(join(fixture.installRoot, 'frontend', '.dist-prev')), false)
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('deploy helper auto-discovers install root from systemctl WorkingDirectory when NEXUS_INSTALL_ROOT is unset', () => {
  const fixture = createDeployScriptFixture({ separateInstallTree: true })
  writeExecutable(
    join(fixture.scriptsDir, 'fake-restart.sh'),
    "#!/bin/sh\nset -eu\nprintf 'restart-ok\\n' >> " + JSON.stringify(fixture.restartLogFile) + "\n",
  )

  try {
    const result = runDeployScript(fixture, {
      NEXUS_RESTART_HELPER: './scripts/fake-restart.sh',
      // Intentionally not setting NEXUS_INSTALL_ROOT.
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const escapedInstallRoot = fixture.installRoot.replace(/[\\\/]/g, '\\$&')
    assert.match(result.stdout, new RegExp('Install root: ' + escapedInstallRoot))
    // systemctl was queried for the WorkingDirectory.
    assert.match(readFileSync(fixture.systemctlLogFile, 'utf8'), /show nexus\.service -p WorkingDirectory/)
    // Install binaries got the new content.
    assert.equal(readFileSync(join(fixture.installReleaseDir, 'nexus-server'), 'utf8'), 'new-nexus-server\n')
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('deploy helper rolls back native PTY supervisor and restores binaries/frontend when restart fails once with --restart-native-pty', () => {
  const fixture = createDeployScriptFixture({ separateInstallTree: true })
  writeExecutable(
    join(fixture.scriptsDir, 'fake-restart.sh'),
    "#!/bin/sh\nset -eu\ncount=0\nif [ -f " + JSON.stringify(fixture.restartCountFile) + " ]; then\n  count=\"$(cat " + JSON.stringify(fixture.restartCountFile) + ")\"\nfi\ncount=$((count + 1))\nprintf '%s' \"$count\" > " + JSON.stringify(fixture.restartCountFile) + "\nprintf 'attempt=%s\n' \"$count\" >> " + JSON.stringify(fixture.restartLogFile) + "\nif [ \"$count\" -eq 1 ]; then\n  exit 1\nfi\n",
  )

  try {
    const result = runDeployScript(fixture, {
      NEXUS_RESTART_HELPER: './scripts/fake-restart.sh',
    }, ['--restart-native-pty'])
    assert.equal(result.status, 1, result.stderr || result.stdout)
    assert.match(result.stderr, /Deploy restart failed; restoring previous release binaries and frontend/)
    assert.match(result.stderr, /Rollback completed/)

    // Restart helper ran exactly twice: once on initial deploy attempt (failed), once after rollback (succeeded).
    assert.equal(readFileSync(fixture.restartLogFile, 'utf8'), 'attempt=1\nattempt=2\n')

    // systemctl log must have restarted nexus-native-pty.service exactly twice (initial + rollback) and checked status twice.
    const systemctlLog = readFileSync(fixture.systemctlLogFile, 'utf8')
    const restartMatches = systemctlLog.match(/restart nexus-native-pty\.service/g) || []
    assert.equal(restartMatches.length, 2, 'expected exactly 2 restart nexus-native-pty.service calls')
    const statusMatches = systemctlLog.match(/status nexus-native-pty\.service --no-pager/g) || []
    assert.equal(statusMatches.length, 2, 'expected exactly 2 status nexus-native-pty.service calls')

    // Checkout release binaries restored to old content.
    assert.equal(readFileSync(join(fixture.releaseDir, 'nexus-server'), 'utf8'), 'old-nexus-server\n')
    assert.equal(readFileSync(join(fixture.releaseDir, 'nexus-codex-home'), 'utf8'), 'old-nexus-codex-home\n')

    // Install tree release binaries restored to old content.
    assert.equal(readFileSync(join(fixture.installReleaseDir, 'nexus-server'), 'utf8'), 'old-install-nexus-server\n')
    assert.equal(readFileSync(join(fixture.installReleaseDir, 'nexus-codex-home'), 'utf8'), 'old-install-nexus-codex-home\n')

    // Install frontend restored verbatim.
    assert.equal(existsSync(join(fixture.installFrontendDist, 'install-stale-asset.js')), true)
    assert.equal(readFileSync(join(fixture.installFrontendDist, 'index.html'), 'utf8'),
      '<!doctype html><html><body>install</body></html>\n')
    assert.equal(existsSync(join(fixture.installFrontendDist, 'checkout-asset.js')), false)
    assert.equal(existsSync(join(fixture.installRoot, 'frontend', '.dist-staging')), false)
    assert.equal(existsSync(join(fixture.installRoot, 'frontend', '.dist-prev')), false)
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('deploy helper rejects separate install tree when missing required markers (.env, start.sh, frontend)', () => {
  const subcases = [
    {
      name: 'missing .env',
      setup: (fixture) => rmSync(join(fixture.installRoot, '.env'), { force: true }),
      expectedMissing: '.env (file)',
    },
    {
      name: 'missing start.sh',
      setup: (fixture) => rmSync(join(fixture.installRoot, 'start.sh'), { force: true }),
      expectedMissing: 'start.sh (file)',
    },
    {
      name: 'missing frontend directory',
      setup: (fixture) => rmSync(join(fixture.installRoot, 'frontend'), { recursive: true, force: true }),
      expectedMissing: 'frontend/ (directory)',
    },
  ]

  for (const { name, setup, expectedMissing } of subcases) {
    const fixture = createDeployScriptFixture({ separateInstallTree: true })
    setup(fixture)
    writeExecutable(
      join(fixture.scriptsDir, 'fake-restart.sh'),
      "#!/bin/sh\nset -eu\nprintf 'restart-ok\n' >> " + JSON.stringify(fixture.restartLogFile) + "\n",
    )

    try {
      const result = runDeployScript(fixture, {
        NEXUS_RESTART_HELPER: './scripts/fake-restart.sh',
        NEXUS_INSTALL_ROOT: fixture.installRoot,
      })
      assert.notEqual(result.status, 0, `subcase ${name} should fail`)
      assert.match(result.stderr, /does not look like a Nexus install tree/, `subcase ${name}`)
      assert.match(result.stderr, /missing required marker/, `subcase ${name}`)
      assert.match(result.stderr, new RegExp(expectedMissing.replace(/[/()]/g, '\\$&')), `subcase ${name}`)

      // Cargo and restart helper must not have run.
      assert.equal(readFileSync(fixture.cargoLogFile, 'utf8'), '', `subcase ${name} cargo log`)
      const restartLog = existsSync(fixture.restartLogFile) ? readFileSync(fixture.restartLogFile, 'utf8') : ''
      assert.equal(restartLog, '', `subcase ${name} restart log`)
    } finally {
      rmSync(fixture.fixtureRoot, { recursive: true, force: true })
    }
  }
})

function assertNoDotTempFiles(dir) {
  if (!existsSync(dir)) return
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    assert.ok(
      !entry.name.startsWith('.nexus-') && !/^\.[^.]+\./.test(entry.name),
      `unexpected temp file ${entry.name} in ${dir}`,
    )
  }
}

test('deploy helper rolls back and restores all binaries when cargo build fails mid-flight', () => {
  const fixture = createDeployScriptFixture({ separateInstallTree: true })
  writeExecutable(
    join(fixture.scriptsDir, 'fake-restart.sh'),
    "#!/bin/sh\nset -eu\nprintf 'restart-ok\\n' >> " + JSON.stringify(fixture.restartLogFile) + "\n",
  )

  writeExecutable(
    join(fixture.binDir, 'cargo'),
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> ${JSON.stringify(fixture.cargoLogFile)}
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--bin" ] && [ "$#" -ge 2 ]; then
    shift
    printf 'new-%s\\n' "$1" > "rust-runtime/target/release/$1"
    chmod +x "rust-runtime/target/release/$1"
    exit 42
  fi
  shift
done
`,
  )

  try {
    const result = runDeployScript(fixture, {
      NEXUS_RESTART_HELPER: './scripts/fake-restart.sh',
    })
    assert.notEqual(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stderr, /Deploy aborted \(exit 42\); restoring previous binaries and frontend/)

    for (const bin of RELEASE_BIN_NAMES) {
      assert.equal(
        readFileSync(join(fixture.releaseDir, bin), 'utf8'),
        `old-${bin}\n`,
        `checkout binary ${bin} was not restored`,
      )
      assert.equal(
        readFileSync(join(fixture.installReleaseDir, bin), 'utf8'),
        `old-install-${bin}\n`,
        `install binary ${bin} was corrupted`,
      )
    }

    assert.equal(existsSync(join(fixture.installFrontendDist, 'install-stale-asset.js')), true)
    assert.equal(
      readFileSync(join(fixture.installFrontendDist, 'index.html'), 'utf8'),
      '<!doctype html><html><body>install</body></html>\n',
    )
    assert.equal(existsSync(join(fixture.installFrontendDist, 'checkout-asset.js')), false)
    assert.equal(existsSync(join(fixture.installRoot, 'frontend', '.dist-staging')), false)
    assert.equal(existsSync(join(fixture.installRoot, 'frontend', '.dist-prev')), false)

    assertNoDotTempFiles(fixture.releaseDir)
    assertNoDotTempFiles(fixture.installReleaseDir)

    assert.equal(readFileSync(fixture.restartLogFile, 'utf8'), 'restart-ok\n')
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('deploy helper rolls back all binaries and frontend when install binary sync fails mid-flight', () => {
  const fixture = createDeployScriptFixture({ separateInstallTree: true })
  writeExecutable(
    join(fixture.scriptsDir, 'fake-restart.sh'),
    "#!/bin/sh\nset -eu\nprintf 'restart-ok\\n' >> " + JSON.stringify(fixture.restartLogFile) + "\n",
  )

  writeExecutable(
    join(fixture.binDir, 'mv'),
    `#!/bin/sh
set -eu
for arg in "$@"; do
  case "$arg" in
    *install-tree*rust-runtime/target/release/nexus-pty-runtime)
      if [ ! -f ${JSON.stringify(fixture.syncFailOnceFile)} ]; then
        touch ${JSON.stringify(fixture.syncFailOnceFile)}
        exit 43
      fi
      ;;
  esac
done
exec /usr/bin/mv "$@"
`,
  )

  try {
    const result = runDeployScript(fixture, {
      NEXUS_RESTART_HELPER: './scripts/fake-restart.sh',
    })
    assert.notEqual(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stderr, /failed to rename staged rust-runtime\/target\/release\/nexus-pty-runtime into place/)
    assert.match(result.stderr, /Deploy aborted \(exit (?:1|43)\); restoring previous binaries and frontend/)

    for (const bin of RELEASE_BIN_NAMES) {
      assert.equal(
        readFileSync(join(fixture.releaseDir, bin), 'utf8'),
        `old-${bin}\n`,
        `checkout binary ${bin} was not restored`,
      )
      assert.equal(
        readFileSync(join(fixture.installReleaseDir, bin), 'utf8'),
        `old-install-${bin}\n`,
        `install binary ${bin} was not restored`,
      )
    }

    assert.equal(existsSync(join(fixture.installFrontendDist, 'install-stale-asset.js')), true)
    assert.equal(
      readFileSync(join(fixture.installFrontendDist, 'index.html'), 'utf8'),
      '<!doctype html><html><body>install</body></html>\n',
    )
    assert.equal(existsSync(join(fixture.installFrontendDist, 'checkout-asset.js')), false)
    assert.equal(existsSync(join(fixture.installRoot, 'frontend', '.dist-staging')), false)
    assert.equal(existsSync(join(fixture.installRoot, 'frontend', '.dist-prev')), false)

    assertNoDotTempFiles(fixture.releaseDir)
    assertNoDotTempFiles(fixture.installReleaseDir)

    assert.equal(readFileSync(fixture.restartLogFile, 'utf8'), 'restart-ok\n')
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})
