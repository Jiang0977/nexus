import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const START_SCRIPT = readFileSync(join(ROOT, 'start.sh'), 'utf8')
const NEXUS_PATHS_SCRIPT = readFileSync(join(ROOT, 'scripts', 'nexus-paths.sh'), 'utf8')

function createFakeRustServerScript(envFile) {
  return `#!/bin/sh
set -eu
{
  printf 'PORT=%s\\n' "\${PORT:-}"
  printf 'SERVER_EXECUTABLE=%s\\n' "$0"
  printf 'NEXUS_TASK_RUNNER_RUST_EXECUTABLE=%s\\n' "\${NEXUS_TASK_RUNNER_RUST_EXECUTABLE:-}"
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

test('package.json keeps only rust startup scripts in the default runtime path', () => {
  const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(packageJson.scripts.start, 'bash ./start.sh')
  assert.equal(packageJson.scripts.test, 'npm run test:rust && npm run test:node')
  assert.equal(packageJson.scripts['test:rust'], 'cargo test --manifest-path rust-runtime/Cargo.toml')
  assert.equal(packageJson.scripts['test:node'], 'node --test tests/*.test.js')
  assert.equal(packageJson.scripts['typecheck:frontend'], 'npm --prefix frontend run typecheck')
  assert.equal(packageJson.scripts['build:frontend'], 'npm --prefix frontend run build')
  assert.equal(packageJson.scripts['check:frontend-dist'], 'npm run build:frontend && node ./scripts/check-frontend-dist.mjs')
  assert.equal(packageJson.scripts.check, 'npm run test:rust && npm run test:node && npm run check:frontend-dist')
  assert.equal(
    packageJson.scripts.setup,
    'cargo run --manifest-path rust-runtime/Cargo.toml --release --bin nexus-setup --',
  )
  assert.equal(
    packageJson.scripts['build:rust-setup'],
    'cargo build --manifest-path rust-runtime/Cargo.toml --release --bin nexus-setup',
  )
  assert.equal(packageJson.scripts['build:rust-codex-home'], 'cargo build --manifest-path rust-runtime/Cargo.toml --release --bin nexus-codex-home')
  assert.equal('build:server' in packageJson.scripts, false)
  assert.equal('typecheck:server' in packageJson.scripts, false)
  assert.equal('dependencies' in packageJson, false)
  assert.equal('playwright' in packageJson.devDependencies, false)
  assert.deepEqual(Object.keys(packageJson.devDependencies).sort(), ['@types/node', 'bcrypt', 'typescript', 'ws'])
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
    'taskRunner.js',
    'taskRunnerController.js',
    'taskRunnerLocalBackend.js',
    'taskRunnerSidecarClient.js',
    'taskRunnerSidecarProcess.js',
    'taskRunnerSse.js',
    'ptyBrokerController.js',
    'ptyBrokerLocalBackend.js',
    'ptyBrokerSidecarClient.js',
    'ptyBrokerSidecarProcess.js',
    'ptyTmuxBroker.js',
    'windowLaunchService.js',
    'sessionManagementService.js',
    'taskRunnerRustClient.js',
    'ptyBrokerRustClient.js',
    'windowLaunchRustClient.js',
    'sessionManagementRustClient.js',
    'configProfilesService.js',
    'workspaceService.js',
    'versionService.js',
    'uploadFilesService.js',
    'telegramBridgeService.js',
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

test('start.sh defaults to rust nexus-server and wires runtime executables without invoking npm when release binaries already exist', () => {
  const fixture = createStartScriptFixture()
  const defaultServer = join(fixture.releaseDir, 'nexus-server')
  const defaultTaskRuntime = join(fixture.releaseDir, 'nexus-task-runtime')
  const defaultPtyRuntime = join(fixture.releaseDir, 'nexus-pty-runtime')
  const defaultWindowLaunchRuntime = join(fixture.releaseDir, 'nexus-window-launch-runtime')
  const defaultSessionRuntime = join(fixture.releaseDir, 'nexus-session-runtime')

  writeExecutable(defaultServer, createFakeRustServerScript(fixture.serverEnvFile))
  writeExecutable(defaultTaskRuntime)
  writeExecutable(defaultPtyRuntime)
  writeExecutable(defaultWindowLaunchRuntime)
  writeExecutable(defaultSessionRuntime)

  try {
    const result = runStartScript(fixture)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /启动 Nexus Rust server on :59001/)

    const serverEnv = parseEnvDump(fixture.serverEnvFile)
    assert.equal(serverEnv.PORT, '59001')
    assert.equal(serverEnv.SERVER_EXECUTABLE, defaultServer)
    assert.equal(serverEnv.NEXUS_TASK_RUNNER_RUST_EXECUTABLE, defaultTaskRuntime)
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
    assert.match(cargoCommands[0], /build --manifest-path rust-runtime\/Cargo\.toml --release --bin nexus-task-runtime --bin nexus-pty-runtime --bin nexus-window-launch-runtime --bin nexus-session-runtime/)
    assert.match(cargoCommands[1], /build --manifest-path rust-runtime\/Cargo\.toml --release --bin nexus-server/)

    const serverEnv = parseEnvDump(fixture.serverEnvFile)
    assert.equal(serverEnv.PORT, '59001')
    assert.equal(
      serverEnv.SERVER_EXECUTABLE,
      join(fixture.releaseDir, 'nexus-server'),
    )
    assert.equal(
      serverEnv.NEXUS_TASK_RUNNER_RUST_EXECUTABLE,
      join(fixture.releaseDir, 'nexus-task-runtime'),
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
