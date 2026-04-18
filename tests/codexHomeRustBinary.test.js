import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BINARY = join(
  ROOT,
  'rust-runtime',
  'target',
  'release',
  process.platform === 'win32' ? 'nexus-codex-home.exe' : 'nexus-codex-home',
)
let buildChecked = false

function ensureBuilt() {
  if (buildChecked && existsSync(BINARY)) return
  const build = spawnSync('npm', ['run', 'build:rust-codex-home'], {
    cwd: ROOT,
    encoding: 'utf8',
  })

  assert.equal(build.status, 0, build.stderr || build.stdout)
  assert.equal(existsSync(BINARY), true)
  buildChecked = true
}

function runCodexHomeTool({ configFile = '', homeDir, projectPath, env = {} }) {
  return spawnSync(BINARY, [configFile, homeDir, projectPath], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...env,
    },
    encoding: 'utf8',
  })
}

test('real rust codex home tool materializes explicit profile auth and config', async () => {
  ensureBuilt()
  const sourceHome = mkdtempSync(join(tmpdir(), 'nexus-codex-source-home-'))
  const runtimeHome = mkdtempSync(join(tmpdir(), 'nexus-codex-runtime-home-'))
  const configFile = join(runtimeHome, 'profile.json')

  writeFileSync(configFile, JSON.stringify({
    OPENAI_API_KEY: 'sk-test',
    MODEL: 'gpt-5.4',
  }, null, 2))

  try {
    const result = runCodexHomeTool({
      configFile,
      homeDir: runtimeHome,
      projectPath: '/workspace/demo',
      env: { HOME: sourceHome },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)

    const authText = readFileSync(join(runtimeHome, '.codex', 'auth.json'), 'utf8')
    const configToml = readFileSync(join(runtimeHome, '.codex', 'config.toml'), 'utf8')

    assert.match(authText, /"OPENAI_API_KEY": "sk-test"/)
    assert.match(configToml, /model = "gpt-5\.4"/)
    assert.match(configToml, /\[projects\."\/workspace\/demo"\]/)
    assert.match(configToml, /\[features\]/)
    assert.match(configToml, /apps = false/)
    assert.match(configToml, /plugins = false/)
  } finally {
    rmSync(sourceHome, { recursive: true, force: true })
    rmSync(runtimeHome, { recursive: true, force: true })
  }
})

test('real rust codex home tool imports current live ~/.codex config and links shared state when profile is omitted', async () => {
  ensureBuilt()
  const sourceHome = mkdtempSync(join(tmpdir(), 'nexus-codex-source-home-'))
  const runtimeHome = mkdtempSync(join(tmpdir(), 'nexus-codex-runtime-home-'))
  const sourceCodexDir = join(sourceHome, '.codex')

  mkdirSync(join(sourceCodexDir, 'skills', 'my-custom-skill'), { recursive: true })
  writeFileSync(
    join(sourceCodexDir, 'config.toml'),
    [
      'model_provider = "custom"',
      'model = "gpt-5.4"',
      '',
      '[model_providers.custom]',
      'base_url = "https://api.openai.com/v1"',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(join(sourceCodexDir, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: 'access-token' },
  }, null, 2), 'utf8')
  writeFileSync(join(sourceCodexDir, 'session_index.jsonl'), '{"id":"session-1"}\n', 'utf8')
  writeFileSync(join(sourceCodexDir, 'history.jsonl'), '{"type":"history"}\n', 'utf8')
  writeFileSync(join(sourceCodexDir, 'skills', 'my-custom-skill', 'SKILL.md'), '# custom skill\n', 'utf8')
  writeFileSync(join(sourceCodexDir, 'logs_2.sqlite'), 'do-not-copy', 'utf8')

  try {
    const result = runCodexHomeTool({
      homeDir: runtimeHome,
      projectPath: '/workspace/demo',
      env: { HOME: sourceHome },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)

    const runtimeCodexDir = join(runtimeHome, '.codex')
    const authText = readFileSync(join(runtimeCodexDir, 'auth.json'), 'utf8')
    const configToml = readFileSync(join(runtimeCodexDir, 'config.toml'), 'utf8')

    assert.match(authText, /"auth_mode": "chatgpt"/)
    assert.match(configToml, /model = "gpt-5\.4"/)
    assert.match(configToml, /base_url = "https:\/\/api\.openai\.com\/v1"/)
    assert.match(configToml, /\[projects\."\/workspace\/demo"\]/)
    assert.match(configToml, /\[features\]/)
    assert.equal(readFileSync(join(runtimeCodexDir, 'session_index.jsonl'), 'utf8'), '{"id":"session-1"}\n')
    assert.equal(readFileSync(join(runtimeCodexDir, 'history.jsonl'), 'utf8'), '{"type":"history"}\n')
    assert.equal(readFileSync(join(runtimeCodexDir, 'skills', 'my-custom-skill', 'SKILL.md'), 'utf8'), '# custom skill\n')
    assert.equal(lstatSync(join(runtimeCodexDir, 'session_index.jsonl')).isSymbolicLink(), true)
    assert.equal(existsSync(join(runtimeCodexDir, 'logs_2.sqlite')), false)
  } finally {
    rmSync(sourceHome, { recursive: true, force: true })
    rmSync(runtimeHome, { recursive: true, force: true })
  }
})

test('real rust codex home tool merges shared sections and preserves explicit auth json', async () => {
  ensureBuilt()
  const sourceHome = mkdtempSync(join(tmpdir(), 'nexus-codex-source-home-'))
  const runtimeHome = mkdtempSync(join(tmpdir(), 'nexus-codex-runtime-home-'))
  const sourceCodexDir = join(sourceHome, '.codex')
  const configFile = join(runtimeHome, 'profile.json')
  const authJson = JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: 'access-token' },
  }, null, 2)

  mkdirSync(sourceCodexDir, { recursive: true })
  writeFileSync(
    join(sourceCodexDir, 'config.toml'),
    [
      'model = "source-model"',
      '',
      '[mcp_servers.chrome-devtools]',
      'command = "npx"',
      'args = ["-y", "chrome-devtools-mcp@latest"]',
      '',
      '[plugins."github@openai-curated"]',
      'enabled = true',
      '',
      '[notice.model_migrations]',
      '"gpt-5.3-codex" = "gpt-5.4"',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(configFile, JSON.stringify({
    MODEL: 'gpt-5.4',
    CONFIG_TOML: 'model = "gpt-5.4"\n',
    AUTH_JSON: authJson,
  }, null, 2))

  try {
    const result = runCodexHomeTool({
      configFile,
      homeDir: runtimeHome,
      projectPath: '/workspace/demo',
      env: { HOME: sourceHome },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)

    const runtimeCodexDir = join(runtimeHome, '.codex')
    const savedAuth = readFileSync(join(runtimeCodexDir, 'auth.json'), 'utf8').trim()
    const configToml = readFileSync(join(runtimeCodexDir, 'config.toml'), 'utf8')

    assert.equal(savedAuth, authJson)
    assert.match(configToml, /^model = "gpt-5\.4"/m)
    assert.match(configToml, /\[mcp_servers\.chrome-devtools\]/)
    assert.match(configToml, /chrome-devtools-mcp@latest/)
    assert.match(configToml, /\[plugins\."github@openai-curated"\]/)
    assert.match(configToml, /\[notice\.model_migrations\]/)
    assert.match(configToml, /\[projects\."\/workspace\/demo"\]/)
    assert.match(configToml, /\[features\]/)
    assert.match(configToml, /apps = false/)
    assert.match(configToml, /plugins = false/)
    assert.doesNotMatch(configToml, /model = "source-model"/)
  } finally {
    rmSync(sourceHome, { recursive: true, force: true })
    rmSync(runtimeHome, { recursive: true, force: true })
  }
})
