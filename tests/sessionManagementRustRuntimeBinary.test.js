import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'

import { createSessionManagementRustClient } from './helpers/sessionManagementRustClient.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME = join(
  ROOT,
  'rust-runtime',
  'target',
  'release',
  process.platform === 'win32' ? 'nexus-session-runtime.exe' : 'nexus-session-runtime',
)
let buildChecked = false

function writeJsonl(filePath, lines) {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8')
}

function createSessionFile(baseDir, { id, datePath, cwd, timestamp = '2026-04-14T12:00:00.000Z', metaFields = {} }) {
  const dir = join(baseDir, 'sessions', ...datePath.split('/'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, `rollout-${datePath.replaceAll('/', '-')}-${id}.jsonl`)
  writeJsonl(filePath, [
    JSON.stringify({
      timestamp,
      type: 'session_meta',
      payload: {
        id,
        timestamp,
        cwd,
        ...metaFields,
      },
    }),
  ])
  return filePath
}

function countLogMatches(log, pattern) {
  return log
    .split('\n')
    .filter((line) => pattern.test(line))
    .length
}

function ensureBuilt() {
  if (buildChecked && existsSync(RUNTIME)) return
  const build = spawnSync('npm', ['run', 'build:rust-session-runtime'], {
    cwd: ROOT,
    encoding: 'utf8',
  })

  assert.equal(build.status, 0, build.stderr || build.stdout)
  assert.equal(existsSync(RUNTIME), true)
  buildChecked = true
}

function createFakeTmuxBin() {
  const baseDir = mkdtempSync(join(tmpdir(), 'nexus-fake-session-tmux-'))
  const logFile = join(baseDir, 'tmux.log')
  const homeDir = join(baseDir, 'home')
  const dataDir = join(baseDir, 'data')
  mkdirSync(homeDir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  const tmuxPath = join(baseDir, 'tmux')
  writeFileSync(tmuxPath, `#!/bin/sh
set -eu
log_file="${logFile}"
cmd="$1"
shift || true
printf '%s|%s\n' "$cmd" "$*" >> "$log_file"
case "$cmd" in
  has-session)
    if [ "\${FAKE_TMUX_HAS_SESSION:-1}" = "1" ]; then
      exit 0
    fi
    exit 1
    ;;
  list-sessions)
    if [ "\${FAKE_TMUX_LIST_SESSIONS_FAIL:-0}" = "1" ]; then
      exit 1
    fi
    printf '%s\n' \
      'nexus-preview-rust|1|1' \
      'legacy-preview|2|0' \
      'owned-outside-root|1|0' \
      'foreign-shared-root|1|0' \
      'hidden-elsewhere|1|0'
    if [ -n "\${FAKE_TMUX_EXTRA_SESSIONS:-}" ]; then
      printf '%s\n' "$FAKE_TMUX_EXTRA_SESSIONS"
    fi
    exit 0
    ;;
  show-environment)
    if [ "$1" = "-t" ] && [ "$3" = "NEXUS_OWNER_SESSION" ]; then
      case "$2" in
        owned-outside-root)
          printf 'NEXUS_OWNER_SESSION=nexus-preview-rust\n'
          exit 0
          ;;
        foreign-shared-root)
          printf 'NEXUS_OWNER_SESSION=main\n'
          exit 0
          ;;
      esac
      exit 1
    fi
    if [ "$1" = "-t" ] && [ "$3" = "NEXUS_CWD" ]; then
      case "$2" in
        legacy-preview)
          printf 'NEXUS_CWD=/tmp/nexus-preview-workspace/apps/legacy\n'
          exit 0
          ;;
        demo-project)
          if [ -n "\${FAKE_TMUX_CODEX_PROJECT_CWD:-}" ]; then
            printf 'NEXUS_CWD=%s\n' "$FAKE_TMUX_CODEX_PROJECT_CWD"
            exit 0
          fi
          exit 1
          ;;
        owned-outside-root)
          printf 'NEXUS_CWD=/srv/preview-owned\n'
          exit 0
          ;;
        foreign-shared-root)
          printf 'NEXUS_CWD=/tmp/nexus-preview-workspace/apps/foreign\n'
          exit 0
          ;;
        hidden-elsewhere)
          printf 'NEXUS_CWD=/home/demo/workspace/other\n'
          exit 0
          ;;
      esac
      exit 1
    fi
    if [ "$1" = "-t" ] && [ "$3" = "NEXUS_LAST_CHANNEL" ]; then
      case "$2" in
        legacy-preview)
          printf 'NEXUS_LAST_CHANNEL=%s\n' "\${FAKE_TMUX_LEGACY_LAST_CHANNEL:-4}"
          exit 0
          ;;
      esac
      exit 1
    fi
    exit 1
    ;;
  display-message)
    if [ "$1" = "-t" ] && [ "$3" = "-p" ] && [ "$4" = '#{pane_current_path}' ]; then
      case "$2" in
        nexus-preview-rust)
          printf '/tmp/nexus-preview-workspace\n'
          exit 0
          ;;
        demo-fallback)
          printf '/tmp/nexus-preview-workspace/apps/demo\n'
          exit 0
          ;;
      esac
    fi
    if [ "$1" = "-t" ] && [ "$3" = "-p" ] && [ "$4" = '#{window_id}' ]; then
      case "$2" in
        workspace-demo-renamed:7)
          printf '%s\n' "\${FAKE_TMUX_DELETE_SESSION_WINDOW_ID:-@7}"
          exit 0
          ;;
      esac
    fi
    exit 1
    ;;
  set-environment|new-session|rename-session|kill-session|select-window|rename-window|kill-window|set-option)
    exit 0
    ;;
  list-windows)
    if [ "$1" = "-t" ] && [ "$2" = "demo-project" ] && [ "$3" = "-F" ]; then
      case "$4" in
        '#{window_id}|#{window_index}|#{@nexus_codex_resume_session_id}')
          if [ -n "\${FAKE_TMUX_CODEX_RESUME_WINDOWS:-}" ]; then
            printf '%s\n' "$FAKE_TMUX_CODEX_RESUME_WINDOWS"
          fi
          exit 0
          ;;
        '#{window_name}')
          if [ -n "\${FAKE_TMUX_CODEX_WINDOW_NAMES:-}" ]; then
            printf '%s\n' "$FAKE_TMUX_CODEX_WINDOW_NAMES"
          fi
          exit 0
          ;;
      esac
    fi
    if [ "$1" = "-t" ] && [ "$2" = "legacy-preview" ] && [ "$3" = "-F" ]; then
      case "$4" in
        '#{window_index}|#{window_name}|#{window_active}|#{pane_current_path}')
          printf '%s\n' \
            '0|shell|1|/tmp/nexus-preview-workspace' \
            '1|review|0|/tmp/nexus-preview-workspace/apps/legacy'
          exit 0
          ;;
        '#{window_index}|#{window_name}|#{window_active}')
          printf '%s\n' \
            '0|shell|1' \
            '1|review|0'
          exit 0
          ;;
        '#I')
          if [ -n "\${FAKE_TMUX_LEGACY_WINDOW_INDEXES:-}" ]; then
            printf '%s\n' "$FAKE_TMUX_LEGACY_WINDOW_INDEXES"
            exit 0
          fi
          printf '%s\n' \
            '1' \
            '4'
          exit 0
          ;;
      esac
    fi
    if [ "$1" = "-t" ] && [ "$2" = "workspace-demo-renamed" ] && [ "$3" = "-F" ]; then
      case "$4" in
        '#{window_index}')
          if [ -n "\${FAKE_TMUX_DELETE_SESSION_WINDOW_INDEXES:-}" ]; then
            printf '%s\n' "$FAKE_TMUX_DELETE_SESSION_WINDOW_INDEXES"
            exit 0
          fi
          printf '7\n'
          exit 0
          ;;
        '#{window_id}')
          if [ -n "\${FAKE_TMUX_DELETE_PROJECT_WINDOW_IDS:-}" ]; then
            printf '%s\n' "$FAKE_TMUX_DELETE_PROJECT_WINDOW_IDS"
            exit 0
          fi
          printf '%s\n' \
            '@3' \
            '@4'
          exit 0
          ;;
      esac
    fi
    exit 1
    ;;
  new-window)
    if [ "$1" = "-P" ]; then
      printf '@9|7|%s\n' "$8"
    fi
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
`, { mode: 0o755 })
  return { baseDir, logFile, homeDir, dataDir }
}

function installFakeGitBin(baseDir) {
  const logFile = join(baseDir, 'git.log')
  const gitPath = join(baseDir, 'git')
  writeFileSync(gitPath, `#!/bin/sh
set -eu
if [ "$1" != "-C" ] || [ "$3" != "rev-parse" ] || [ "$4" != "--show-toplevel" ]; then
  exit 2
fi
cwd="$2"
printf '%s\n' "$cwd" >> "$FAKE_GIT_LOG"
if [ "$cwd" = "$FAKE_GIT_RESOLVED_CWD" ]; then
  printf '%s\n' "$FAKE_GIT_REPO_ROOT"
  exit 0
fi
exit 1
`, { mode: 0o755 })
  return logFile
}

function createClient(baseDir, extraEnv = {}) {
  return createSessionManagementRustClient({
    runtimeExecutable: RUNTIME,
    env: {
      ...process.env,
      NEXUS_SESSION_BACKEND: 'tmux',
      NEXUS_DATA_DIR: join(baseDir, 'data'),
      PATH: `${baseDir}:${process.env.PATH || ''}`,
      ...extraEnv,
    },
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })
}

test('real rust session runtime creates project/channel and returns resume window metadata through fake tmux', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()
  const { baseDir, logFile } = createFakeTmuxBin()
  const client = createClient(baseDir, { FAKE_TMUX_HAS_SESSION: '1' })

  t.after(async () => {
    await client.close()
    rmSync(baseDir, { recursive: true, force: true })
  })

  await client.ready()

  assert.deepEqual(await client.createProject({
    sessionName: 'workspace-demo',
    cwd: '/workspace/demo',
    initialWindowName: 'demo-work',
    shellCmd: 'shell:codex:work:/workspace/demo',
    proxyVars: { HTTPS_PROXY: 'http://proxy.local' },
  }), { ok: true })

  assert.deepEqual(await client.createProjectChannel({
    sessionName: 'workspace-demo',
    cwd: '/workspace/demo',
    channelName: 'review',
    shellCmd: 'exec zsh -i',
    defaultShellCmd: 'exec zsh -i',
    proxyVars: { HTTPS_PROXY: 'http://proxy.local' },
  }), { ok: true })

  assert.deepEqual(await client.createResumeWindow({
    sessionName: 'workspace-demo',
    cwd: '/workspace/demo',
    windowName: 'codex-history',
    shellCmd: 'shell:codex::/workspace/demo:[object Object]',
    defaultShellCmd: 'exec zsh -i',
    proxyVars: { HTTPS_PROXY: 'http://proxy.local' },
  }), {
    windowId: '@9',
    index: 7,
    name: 'codex-history',
  })

  const log = readFileSync(logFile, 'utf8')
  assert.match(log, /new-session\|-d -s workspace-demo -n demo-work -c \/workspace\/demo shell:codex:work:\/workspace\/demo/)
  assert.match(log, /set-environment\|-t workspace-demo NEXUS_CWD \/workspace\/demo/)
  assert.match(log, /has-session\|-t workspace-demo/)
  assert.equal(countLogMatches(log, /^has-session\|-t workspace-demo$/), 2)
  assert.match(log, /new-window\|-t workspace-demo -c \/workspace\/demo -n review exec zsh -i/)
  assert.match(log, /new-window\|-P -F #\{window_id\}\|#\{window_index\}\|#\{window_name\} -t workspace-demo -c \/workspace\/demo -n codex-history shell:codex::\/workspace\/demo:\[object Object\]/)
})

test('real rust session runtime handles rename/delete/attach window side effects through fake tmux', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()
  const { baseDir, logFile, dataDir } = createFakeTmuxBin()
  const runtimeDir = join(dataDir, 'codex-runtime')
  mkdirSync(join(runtimeDir, '-7'), { recursive: true })
  mkdirSync(join(runtimeDir, '-3'), { recursive: true })
  mkdirSync(join(runtimeDir, '-4'), { recursive: true })
  const client = createClient(baseDir, {
    FAKE_TMUX_HAS_SESSION: '1',
    FAKE_TMUX_DELETE_SESSION_WINDOW_INDEXES: '7',
    FAKE_TMUX_DELETE_SESSION_WINDOW_ID: '@7',
    FAKE_TMUX_DELETE_PROJECT_WINDOW_IDS: '@3\n@4',
    NEXUS_DATA_DIR: dataDir,
  })

  t.after(async () => {
    await client.close()
    rmSync(baseDir, { recursive: true, force: true })
  })

  await client.ready()

  assert.deepEqual(await client.renameProject({
    oldName: 'workspace-demo',
    newName: 'workspace-demo-renamed',
  }), {
    ok: true,
    oldName: 'workspace-demo',
    newName: 'workspace-demo-renamed',
  })

  assert.deepEqual(await client.attachSessionWindow({
    sessionName: 'workspace-demo-renamed',
    index: 7,
  }), { ok: true })

  assert.deepEqual(await client.renameSessionWindow({
    sessionName: 'workspace-demo-renamed',
    index: 7,
    name: 'review-tab',
  }), { ok: true, name: 'review-tab' })

  assert.deepEqual(await client.deleteSessionWindow({
    sessionName: 'workspace-demo-renamed',
    index: 7,
    defaultShellCmd: 'exec zsh -i',
  }), { ok: true })

  assert.deepEqual(await client.deleteProject({
    sessionName: 'workspace-demo-renamed',
  }), { ok: true })
  assert.equal(existsSync(join(runtimeDir, '-7')), false)
  assert.equal(existsSync(join(runtimeDir, '-3')), false)
  assert.equal(existsSync(join(runtimeDir, '-4')), false)

  const log = readFileSync(logFile, 'utf8')
  assert.match(log, /rename-session\|-t workspace-demo workspace-demo-renamed/)
  assert.match(log, /select-window\|-t workspace-demo-renamed:7/)
  assert.match(log, /set-environment\|-t workspace-demo-renamed NEXUS_LAST_CHANNEL 7/)
  assert.match(log, /rename-window\|-t workspace-demo-renamed:7 review-tab/)
  assert.match(log, /display-message\|-t workspace-demo-renamed:7 -p #\{window_id\}/)
  assert.match(log, /list-windows\|-t workspace-demo-renamed -F #\{window_index\}/)
  assert.match(log, /new-window\|-t workspace-demo-renamed -n shell exec zsh -i/)
  assert.match(log, /kill-window\|-t workspace-demo-renamed:7/)
  assert.match(log, /list-windows\|-t workspace-demo-renamed -F #\{window_id\}/)
  assert.match(log, /kill-session\|-t workspace-demo-renamed/)
})

test('real rust session runtime creates a missing session before project channel/resume work', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()
  const { baseDir, logFile } = createFakeTmuxBin()
  const client = createClient(baseDir, { FAKE_TMUX_HAS_SESSION: '0' })

  t.after(async () => {
    await client.close()
    rmSync(baseDir, { recursive: true, force: true })
  })

  await client.ready()
  await client.createProjectChannel({
    sessionName: 'missing-project',
    cwd: '/workspace/demo',
    channelName: 'review',
    shellCmd: 'exec zsh -i',
    defaultShellCmd: 'exec zsh -i',
    proxyVars: {},
  })

  const log = readFileSync(logFile, 'utf8')
  assert.match(log, /has-session\|-t missing-project/)
  assert.equal(countLogMatches(log, /^has-session\|-t missing-project$/), 1)
  assert.equal(countLogMatches(log, /^new-session\|-d -s missing-project -n shell exec zsh -i$/), 1)
  assert.match(log, /new-session\|-d -s missing-project -n shell exec zsh -i/)
  assert.match(log, /new-window\|-t missing-project -c \/workspace\/demo -n review exec zsh -i/)
})

test('real rust session runtime exposes all tmux-backed sessions and projects through fake tmux', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()
  const { baseDir, logFile } = createFakeTmuxBin()
  const client = createClient(baseDir, {
    TMUX_SESSION: 'nexus-preview-rust',
    WORKSPACE_ROOT: '/tmp/nexus-preview-workspace',
  })

  t.after(async () => {
    await client.close()
    rmSync(baseDir, { recursive: true, force: true })
  })

  await client.ready()

  assert.deepEqual(await client.listTmuxSessions(), [
    { name: 'nexus-preview-rust', windows: 1, attached: true },
    { name: 'legacy-preview', windows: 2, attached: false },
    { name: 'owned-outside-root', windows: 1, attached: false },
    { name: 'foreign-shared-root', windows: 1, attached: false },
    { name: 'hidden-elsewhere', windows: 1, attached: false },
  ])

  assert.deepEqual(await client.listProjects(), [
    { name: 'hidden-elsewhere', path: '/home/demo/workspace/other', active: false, channelCount: 1 },
    { name: 'foreign-shared-root', path: '/tmp/nexus-preview-workspace/apps/foreign', active: false, channelCount: 1 },
    { name: 'owned-outside-root', path: '/srv/preview-owned', active: false, channelCount: 1 },
    { name: 'legacy-preview', path: '/tmp/nexus-preview-workspace/apps/legacy', active: false, channelCount: 2 },
    { name: 'nexus-preview-rust', path: '/tmp/nexus-preview-workspace', active: true, channelCount: 1 },
  ])

  assert.deepEqual(await client.getSessionCwd({ sessionName: 'demo-fallback' }), {
    cwd: '/tmp/nexus-preview-workspace/apps/demo',
    relative: 'apps/demo',
  })

  assert.deepEqual(await client.listProjectChannels({ projectName: 'legacy-preview' }), {
    project: 'legacy-preview',
    channels: [
      { index: 1, name: 'review', active: false, cwd: '/tmp/nexus-preview-workspace/apps/legacy' },
      { index: 0, name: 'shell', active: true, cwd: '/tmp/nexus-preview-workspace' },
    ],
  })

  assert.deepEqual(await client.listSessionWindows({ sessionName: 'legacy-preview' }), {
    session: 'legacy-preview',
    windows: [
      { index: 0, name: 'shell', active: true },
      { index: 1, name: 'review', active: false },
    ],
  })

  assert.deepEqual(await client.activateProject({ projectName: 'legacy-preview' }), {
    active: true,
    project: 'legacy-preview',
    lastChannel: 4,
  })

  const log = readFileSync(logFile, 'utf8')
  assert.match(log, /list-sessions\|-F #\{session_name\}\|#\{session_windows\}\|#\{session_attached\}/)
  assert.match(log, /show-environment\|-t legacy-preview NEXUS_CWD/)
  assert.match(log, /show-environment\|-t legacy-preview NEXUS_LAST_CHANNEL/)
  assert.match(log, /display-message\|-t demo-fallback -p #\{pane_current_path\}/)
  assert.match(log, /list-windows\|-t legacy-preview -F #\{window_index\}\|#\{window_name\}\|#\{window_active\}\|#\{pane_current_path\}/)
  assert.match(log, /list-windows\|-t legacy-preview -F #I/)
})

test('real rust session runtime falls back to current project when tmux discovery fails', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()
  const { baseDir } = createFakeTmuxBin()
  const client = createClient(baseDir, {
    TMUX_SESSION: 'nexus-preview-rust',
    WORKSPACE_ROOT: '/tmp/nexus-preview-workspace',
    FAKE_TMUX_LIST_SESSIONS_FAIL: '1',
  })

  t.after(async () => {
    await client.close()
    rmSync(baseDir, { recursive: true, force: true })
  })

  await client.ready()

  assert.deepEqual(await client.listTmuxSessions(), [
    { name: 'nexus-preview-rust', windows: 0, attached: false },
  ])

  assert.deepEqual(await client.listProjects(), [
    { name: 'nexus-preview-rust', path: '/tmp/nexus-preview-workspace', active: true, channelCount: 0 },
  ])
})

test('real rust session runtime drops invalid last channel metadata on activate', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()
  const { baseDir } = createFakeTmuxBin()
  const client = createClient(baseDir, {
    FAKE_TMUX_HAS_SESSION: '1',
    FAKE_TMUX_LEGACY_LAST_CHANNEL: '99',
    FAKE_TMUX_LEGACY_WINDOW_INDEXES: '1\n4',
  })

  t.after(async () => {
    await client.close()
    rmSync(baseDir, { recursive: true, force: true })
  })

  await client.ready()

  assert.deepEqual(await client.activateProject({ projectName: 'legacy-preview' }), {
    active: true,
    project: 'legacy-preview',
    lastChannel: null,
  })
})

test('real rust session runtime hides internal nexus-pty sessions from discoverable workspaces', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()
  const { baseDir } = createFakeTmuxBin()
  const client = createClient(baseDir, {
    TMUX_SESSION: 'nexus-preview-rust',
    WORKSPACE_ROOT: '/tmp/nexus-preview-workspace',
    FAKE_TMUX_EXTRA_SESSIONS: [
      'nexus-pty-2820024-a47faeb015b329f0|1|0',
      'nexus-pty-2850420-a47faeb015b329f0|1|1',
    ].join('\n'),
  })

  t.after(async () => {
    await client.close()
    rmSync(baseDir, { recursive: true, force: true })
  })

  await client.ready()

  assert.deepEqual(await client.listTmuxSessions(), [
    { name: 'nexus-preview-rust', windows: 1, attached: true },
    { name: 'legacy-preview', windows: 2, attached: false },
    { name: 'owned-outside-root', windows: 1, attached: false },
    { name: 'foreign-shared-root', windows: 1, attached: false },
    { name: 'hidden-elsewhere', windows: 1, attached: false },
  ])

  assert.deepEqual(await client.listProjects(), [
    { name: 'hidden-elsewhere', path: '/home/demo/workspace/other', active: false, channelCount: 1 },
    { name: 'foreign-shared-root', path: '/tmp/nexus-preview-workspace/apps/foreign', active: false, channelCount: 1 },
    { name: 'owned-outside-root', path: '/srv/preview-owned', active: false, channelCount: 1 },
    { name: 'legacy-preview', path: '/tmp/nexus-preview-workspace/apps/legacy', active: false, channelCount: 2 },
    { name: 'nexus-preview-rust', path: '/tmp/nexus-preview-workspace', active: true, channelCount: 1 },
  ])
})

test('real rust session runtime reads Codex metadata without loading transcript bodies', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()
  const { baseDir, homeDir } = createFakeTmuxBin()
  const codexHome = join(homeDir, '.codex')
  writeJsonl(join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({
      id: 'session-corrupt-body',
      thread_name: 'Keep metadata readable',
      updated_at: '2026-04-14T12:00:00.000Z',
    }),
  ])
  const sessionFile = createSessionFile(codexHome, {
    id: 'session-corrupt-body',
    datePath: '2026/04/14',
    cwd: ROOT,
  })
  writeFileSync(sessionFile, Buffer.concat([
    readFileSync(sessionFile),
    Buffer.from([0xff, 0xfe, 0xfd, 0x0a]),
  ]))

  const client = createClient(baseDir, {
    HOME: homeDir,
    FAKE_TMUX_HAS_SESSION: '1',
    FAKE_TMUX_CODEX_PROJECT_CWD: ROOT,
  })

  t.after(async () => {
    await client.close()
    rmSync(baseDir, { recursive: true, force: true })
  })

  await client.ready()

  assert.deepEqual(await client.listCodexSessions({
    projectName: 'demo-project',
    limit: 10,
    cursor: '0',
  }), {
    scope: {
      project: 'demo-project',
      path: ROOT,
      repoRoot: ROOT,
      summary: `repo root: ${ROOT}`,
    },
    items: [
      {
        id: 'session-corrupt-body',
        title: 'Keep metadata readable',
        updatedAt: '2026-04-14T12:00:00.000Z',
        cwd: ROOT,
        attributionKind: 'repo-root',
      },
    ],
    nextCursor: null,
    warning: null,
  })
})

test('real rust session runtime resolves each distinct Codex cwd once per history request', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()
  const { baseDir, homeDir } = createFakeTmuxBin()
  const gitLogFile = installFakeGitBin(baseDir)
  const codexHome = join(homeDir, '.codex')
  const unresolvedCwd = '/tmp/nexus-codex-history-unresolved'
  const sessions = [
    { id: 'session-repo-1', cwd: ROOT },
    { id: 'session-repo-2', cwd: ROOT },
    { id: 'session-unresolved-1', cwd: unresolvedCwd },
    { id: 'session-unresolved-2', cwd: unresolvedCwd },
  ]
  writeJsonl(join(codexHome, 'session_index.jsonl'), sessions.map(({ id }, index) => JSON.stringify({
    id,
    thread_name: id,
    updated_at: `2026-04-14T12:00:0${index}.000Z`,
  })))
  for (const [index, session] of sessions.entries()) {
    createSessionFile(codexHome, {
      ...session,
      datePath: `2026/04/${14 + index}`,
      timestamp: `2026-04-14T12:00:0${index}.000Z`,
    })
  }

  const client = createClient(baseDir, {
    HOME: homeDir,
    FAKE_TMUX_HAS_SESSION: '1',
    FAKE_TMUX_CODEX_PROJECT_CWD: ROOT,
    FAKE_GIT_LOG: gitLogFile,
    FAKE_GIT_RESOLVED_CWD: ROOT,
    FAKE_GIT_REPO_ROOT: ROOT,
  })

  t.after(async () => {
    await client.close()
    rmSync(baseDir, { recursive: true, force: true })
  })

  await client.ready()
  const firstResponse = await client.listCodexSessions({
    projectName: 'demo-project',
    limit: 10,
    cursor: '0',
  })
  const secondResponse = await client.listCodexSessions({
    projectName: 'demo-project',
    limit: 10,
    cursor: '0',
  })

  for (const response of [firstResponse, secondResponse]) {
    assert.deepEqual(response.items.map(({ id }) => id), ['session-repo-2', 'session-repo-1'])
  }
  const gitCwds = readFileSync(gitLogFile, 'utf8').trim().split('\n')
  assert.equal(gitCwds.filter(cwd => cwd === ROOT).length, 2)
  assert.equal(gitCwds.filter(cwd => cwd === unresolvedCwd).length, 2)
  assert.equal(gitCwds.length, 4)
})

test('real rust session runtime handles codex history listing, detail, resume, and delete through fake tmux', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()
  const { baseDir, logFile, homeDir, dataDir } = createFakeTmuxBin()
  const codexHome = join(homeDir, '.codex')
  const runtimeDir = join(dataDir, 'codex-runtime')
  mkdirSync(runtimeDir, { recursive: true })
  writeJsonl(join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({
      id: 'session-1',
      thread_name: 'Fix bug',
      updated_at: '2026-04-14T12:00:00.000Z',
    }),
  ])
  createSessionFile(codexHome, {
    id: 'session-1',
    datePath: '2026/04/14',
    cwd: ROOT,
    metaFields: {
      originator: 'codex_cli_rs',
      cli_version: '0.117.0',
      source: 'cli',
      model_provider: 'openai',
    },
  })
  mkdirSync(join(runtimeDir, '-9'), { recursive: true })
  writeFileSync(join(runtimeDir, '-9', 'marker.txt'), 'runtime', 'utf8')

  const client = createClient(baseDir, {
    HOME: homeDir,
    NEXUS_DATA_DIR: dataDir,
    FAKE_TMUX_HAS_SESSION: '1',
    FAKE_TMUX_CODEX_PROJECT_CWD: ROOT,
    FAKE_TMUX_CODEX_RESUME_WINDOWS: '@9|7|session-1',
  })

  t.after(async () => {
    await client.close()
    rmSync(baseDir, { recursive: true, force: true })
  })

  await client.ready()

  assert.deepEqual(await client.listCodexSessions({
    projectName: 'demo-project',
    limit: 10,
    cursor: '0',
  }), {
    scope: {
      project: 'demo-project',
      path: ROOT,
      repoRoot: ROOT,
      summary: `repo root: ${ROOT}`,
    },
    items: [
      {
        id: 'session-1',
        title: 'Fix bug',
        updatedAt: '2026-04-14T12:00:00.000Z',
        cwd: ROOT,
        attributionKind: 'repo-root',
      },
    ],
    nextCursor: null,
    warning: null,
  })

  assert.deepEqual(await client.getCodexSessionDetail({
    sessionId: 'session-1',
    projectName: 'demo-project',
  }), {
    id: 'session-1',
    title: 'Fix bug',
    updatedAt: '2026-04-14T12:00:00.000Z',
    startedAt: '2026-04-14T12:00:00.000Z',
    cwd: ROOT,
    attributionKind: 'repo-root',
    source: 'cli',
    originator: 'codex_cli_rs',
    cliVersion: '0.117.0',
    modelProvider: 'openai',
  })

  assert.deepEqual(await client.resumeCodexSession({
    projectName: 'demo-project',
    sessionId: 'session-1',
    cwd: ROOT,
    windowName: 'codex-history',
    shellCmd: 'shell:codex::/workspace/demo:[object Object]',
    proxyVars: { HTTPS_PROXY: 'http://proxy.local' },
  }), {
    ok: true,
    project: 'demo-project',
    channelIndex: 7,
    channelName: 'codex-history',
    sessionId: 'session-1',
  })

  assert.deepEqual(await client.deleteProjectCodexSession({
    projectName: 'demo-project',
    sessionId: 'session-1',
    defaultShellCmd: 'exec zsh -i',
  }), {
    ok: true,
    sessionId: 'session-1',
    closedWindowIndexes: [7],
  })

  assert.equal(existsSync(join(codexHome, 'sessions', '2026', '04', '14', 'rollout-2026-04-14-session-1.jsonl')), false)
  assert.equal(readFileSync(join(codexHome, 'session_index.jsonl'), 'utf8').includes('session-1'), false)
  assert.equal(existsSync(join(runtimeDir, '-9')), false)

  const log = readFileSync(logFile, 'utf8')
  assert.match(log, /show-environment\|-t demo-project NEXUS_CWD/)
  assert.match(log, /new-window\|-P -F #\{window_id\}\|#\{window_index\}\|#\{window_name\} -t demo-project -c .* -n codex-history shell:codex::\/workspace\/demo:\[object Object\]/)
  assert.match(log, /set-option\|-w -t @9 @nexus_codex_resume_session_id session-1/)
  assert.match(log, /select-window\|-t demo-project:7/)
  assert.match(log, /set-environment\|-t demo-project NEXUS_LAST_CHANNEL 7/)
  assert.match(log, /list-windows\|-t demo-project -F #\{window_id\}\|#\{window_index\}\|#\{@nexus_codex_resume_session_id\}/)
  assert.match(log, /new-window\|-t demo-project -n shell exec zsh -i/)
  assert.match(log, /kill-window\|-t @9/)
})

test('real rust session runtime creates and lists native registry projects and channels', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()
  const baseDir = mkdtempSync(join(tmpdir(), 'nexus-native-session-registry-'))
  const dbPath = join(baseDir, 'session.db')
  const client = createSessionManagementRustClient({
    runtimeExecutable: RUNTIME,
    env: {
      ...process.env,
      NEXUS_SESSION_BACKEND: 'native',
      NEXUS_NATIVE_SESSION_DB: dbPath,
      WORKSPACE_ROOT: '/workspace',
    },
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })

  t.after(async () => {
    await client.close()
    rmSync(baseDir, { recursive: true, force: true })
  })

  await client.ready()

  assert.deepEqual(await client.createProject({
    sessionName: 'native-demo',
    cwd: '/workspace/native-demo',
    initialWindowName: 'shell',
    shellCmd: 'cat',
    proxyVars: { HTTPS_PROXY: 'http://proxy.local' },
  }), { ok: true })

  assert.deepEqual(await client.createProjectChannel({
    sessionName: 'native-demo',
    cwd: '/workspace/native-demo/review',
    channelName: 'review',
    shellCmd: 'cat',
    defaultShellCmd: 'ignored',
    proxyVars: {},
  }), { ok: true })

  assert.deepEqual(await client.listTmuxSessions(), [
    { name: 'native-demo', windows: 2, attached: false },
  ])

  assert.deepEqual(await client.listProjects(), [
    { name: 'native-demo', path: '/workspace/native-demo', active: false, channelCount: 2 },
  ])

  assert.deepEqual(await client.getSessionCwd({ sessionName: 'native-demo' }), {
    cwd: '/workspace/native-demo',
    relative: 'native-demo',
  })

  assert.deepEqual(await client.listProjectChannels({ projectName: 'native-demo' }), {
    project: 'native-demo',
    channels: [
      { index: 1, name: 'review', active: true, cwd: '/workspace/native-demo/review' },
      { index: 0, name: 'shell', active: false, cwd: '/workspace/native-demo' },
    ],
  })

  assert.deepEqual(await client.listSessionWindows({ sessionName: 'native-demo' }), {
    session: 'native-demo',
    windows: [
      { index: 0, name: 'shell', active: false },
      { index: 1, name: 'review', active: true },
    ],
  })

  assert.deepEqual(await client.activateProject({ projectName: 'native-demo' }), {
    active: true,
    project: 'native-demo',
    lastChannel: 1,
  })
})

test('real rust session runtime stores native codex resume metadata in the registry', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()
  const baseDir = mkdtempSync(join(tmpdir(), 'nexus-native-codex-resume-'))
  const dbPath = join(baseDir, 'session.db')
  const client = createSessionManagementRustClient({
    runtimeExecutable: RUNTIME,
    env: {
      ...process.env,
      NEXUS_SESSION_BACKEND: 'native',
      NEXUS_NATIVE_SESSION_DB: dbPath,
      WORKSPACE_ROOT: '/workspace',
    },
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })

  t.after(async () => {
    await client.close()
    rmSync(baseDir, { recursive: true, force: true })
  })

  await client.ready()

  assert.deepEqual(await client.createProject({
    sessionName: 'native-codex',
    cwd: '/workspace/native-codex',
    initialWindowName: 'shell',
    shellCmd: 'cat',
    proxyVars: {},
  }), { ok: true })

  assert.deepEqual(await client.resumeCodexSession({
    sessionName: 'native-codex',
    projectName: 'native-codex',
    sessionId: 'session-1',
    cwd: '/workspace/native-codex',
    windowName: 'codex-history',
    shellCmd: 'cat',
    launchPlan: {
      program: 'cat',
      args: [],
      env: {},
      cwd: '/workspace/native-codex',
    },
    proxyVars: {},
  }), {
    ok: true,
    project: 'native-codex',
    channelIndex: 1,
    channelName: 'codex-history',
    sessionId: 'session-1',
  })

  assert.deepEqual(await client.listProjectChannels({ projectName: 'native-codex' }), {
    project: 'native-codex',
    channels: [
      { index: 1, name: 'codex-history', active: true, cwd: '/workspace/native-codex' },
      { index: 0, name: 'shell', active: false, cwd: '/workspace/native-codex' },
    ],
  })

  const db = new DatabaseSync(dbPath)
  try {
    const row = db.prepare(`
      SELECT value
      FROM channel_metadata
      WHERE project_name = ? AND channel_index = ? AND key = ?
    `).get('native-codex', 1, '@nexus_codex_resume_session_id')
    assert.equal(row.value, 'session-1')
  } finally {
    db.close()
  }
})

test('real rust session runtime deletes native codex sessions and closes metadata channels', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()
  const baseDir = mkdtempSync(join(tmpdir(), 'nexus-native-codex-delete-'))
  const dbPath = join(baseDir, 'session.db')
  const codexHome = join(baseDir, '.codex')
  writeJsonl(join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({
      id: 'session-1',
      thread_name: 'Fix bug',
      updated_at: '2026-04-14T12:00:00.000Z',
    }),
  ])
  createSessionFile(codexHome, {
    id: 'session-1',
    datePath: '2026/04/14',
    cwd: '/workspace/native-codex',
    metaFields: {
      originator: 'codex_cli_rs',
      cli_version: '0.117.0',
      source: 'cli',
      model_provider: 'openai',
    },
  })

  const client = createSessionManagementRustClient({
    runtimeExecutable: RUNTIME,
    env: {
      ...process.env,
      NEXUS_SESSION_BACKEND: 'native',
      NEXUS_NATIVE_SESSION_DB: dbPath,
      NEXUS_SESSION_MANAGEMENT_CODEX_HOME: codexHome,
      NEXUS_DATA_DIR: baseDir,
      WORKSPACE_ROOT: '/workspace',
    },
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })

  t.after(async () => {
    await client.close()
    rmSync(baseDir, { recursive: true, force: true })
  })

  await client.ready()

  assert.deepEqual(await client.createProject({
    sessionName: 'native-codex',
    cwd: '/workspace/native-codex',
    initialWindowName: 'shell',
    shellCmd: 'cat',
    proxyVars: {},
  }), { ok: true })

  assert.deepEqual(await client.resumeCodexSession({
    sessionName: 'native-codex',
    projectName: 'native-codex',
    sessionId: 'session-1',
    cwd: '/workspace/native-codex',
    windowName: 'codex-history',
    shellCmd: 'cat',
    launchPlan: {
      program: 'cat',
      args: [],
      env: {},
      cwd: '/workspace/native-codex',
    },
    proxyVars: {},
  }), {
    ok: true,
    project: 'native-codex',
    channelIndex: 1,
    channelName: 'codex-history',
    sessionId: 'session-1',
  })

  assert.deepEqual(await client.deleteSessionWindow({
    sessionName: 'native-codex',
    index: '0',
    defaultShellCmd: 'cat',
  }), { ok: true })
  mkdirSync(join(baseDir, 'codex-runtime', 'native-native-codex-1'), { recursive: true })
  writeFileSync(join(baseDir, 'codex-runtime', 'native-native-codex-1', 'marker.txt'), 'runtime', 'utf8')

  assert.deepEqual(await client.deleteProjectCodexSession({
    projectName: 'native-codex',
    sessionId: 'session-1',
    defaultShellCmd: 'cat',
  }), {
    ok: true,
    sessionId: 'session-1',
    closedWindowIndexes: [1],
  })

  assert.equal(existsSync(join(codexHome, 'sessions', '2026', '04', '14', 'rollout-2026-04-14-session-1.jsonl')), false)
  assert.equal(readFileSync(join(codexHome, 'session_index.jsonl'), 'utf8').includes('session-1'), false)
  assert.equal(existsSync(join(baseDir, 'codex-runtime', 'native-native-codex-1')), false)
  assert.deepEqual(await client.listProjectChannels({ projectName: 'native-codex' }), {
    project: 'native-codex',
    channels: [
      { index: 2, name: 'shell', active: true, cwd: '/workspace/native-codex' },
    ],
  })

  const db = new DatabaseSync(dbPath)
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM channel_metadata
      WHERE project_name = ? AND key = ? AND value = ?
    `).get('native-codex', '@nexus_codex_resume_session_id', 'session-1')
    assert.equal(row.count, 0)
  } finally {
    db.close()
  }
})

test('real rust session runtime handles native lifecycle parity through registry', { skip: process.platform === 'win32' }, async (t) => {
  ensureBuilt()
  const baseDir = mkdtempSync(join(tmpdir(), 'nexus-native-session-lifecycle-'))
  const dbPath = join(baseDir, 'session.db')
  const client = createSessionManagementRustClient({
    runtimeExecutable: RUNTIME,
    env: {
      ...process.env,
      NEXUS_SESSION_BACKEND: 'native',
      NEXUS_NATIVE_SESSION_DB: dbPath,
      WORKSPACE_ROOT: '/workspace',
    },
    readyTimeoutMs: 1000,
    log: { log() {}, error() {} },
  })

  t.after(async () => {
    await client.close()
    rmSync(baseDir, { recursive: true, force: true })
  })

  await client.ready()

  assert.deepEqual(await client.createProject({
    sessionName: 'native-lifecycle',
    cwd: '/workspace/native-lifecycle',
    initialWindowName: 'shell',
    shellCmd: 'cat',
    proxyVars: {},
  }), { ok: true })

  assert.deepEqual(await client.createProjectChannel({
    sessionName: 'native-lifecycle',
    cwd: '/workspace/native-lifecycle/review',
    channelName: 'review',
    shellCmd: 'cat',
    defaultShellCmd: 'ignored',
    proxyVars: {},
  }), { ok: true })

  assert.deepEqual(await client.renameProject({
    oldName: 'native-lifecycle',
    newName: 'native-lifecycle-renamed',
  }), {
    ok: true,
    oldName: 'native-lifecycle',
    newName: 'native-lifecycle-renamed',
  })

  assert.deepEqual(await client.attachSessionWindow({
    sessionName: 'native-lifecycle-renamed',
    index: 0,
  }), { ok: true })

  assert.deepEqual(await client.renameSessionWindow({
    sessionName: 'native-lifecycle-renamed',
    index: 0,
    name: 'main-shell',
  }), { ok: true, name: 'main-shell' })

  assert.deepEqual(await client.listProjectChannels({ projectName: 'native-lifecycle-renamed' }), {
    project: 'native-lifecycle-renamed',
    channels: [
      { index: 1, name: 'review', active: false, cwd: '/workspace/native-lifecycle/review' },
      { index: 0, name: 'main-shell', active: true, cwd: '/workspace/native-lifecycle' },
    ],
  })

  assert.deepEqual(await client.deleteSessionWindow({
    sessionName: 'native-lifecycle-renamed',
    index: 1,
    defaultShellCmd: 'ignored',
  }), { ok: true })

  assert.deepEqual(await client.listSessionWindows({ sessionName: 'native-lifecycle-renamed' }), {
    session: 'native-lifecycle-renamed',
    windows: [
      { index: 0, name: 'main-shell', active: true },
    ],
  })

  await assert.rejects(
    () => client.deleteSessionWindow({
      sessionName: 'native-lifecycle-renamed',
      index: 0,
      defaultShellCmd: '',
    }),
    /cannot delete last native channel/,
  )

  assert.deepEqual(await client.deleteSessionWindow({
    sessionName: 'native-lifecycle-renamed',
    index: 0,
    createFallbackShell: true,
    defaultShellCmd: 'cat',
  }), { ok: true })

  assert.deepEqual(await client.listSessionWindows({ sessionName: 'native-lifecycle-renamed' }), {
    session: 'native-lifecycle-renamed',
    windows: [
      { index: 1, name: 'shell', active: true },
    ],
  })

  assert.deepEqual(await client.deleteProject({
    sessionName: 'native-lifecycle-renamed',
  }), { ok: true })

  assert.deepEqual(await client.listProjects(), [])
  await assert.rejects(
    () => client.listProjectChannels({ projectName: 'native-lifecycle-renamed' }),
    /project not found/,
  )
})
