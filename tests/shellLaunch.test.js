import test from 'node:test'
import assert from 'node:assert/strict'

import { buildInteractiveShellCommand, buildProxyExportPrefix, collectProxyVars } from '../shellLaunch.js'

const DEFAULT_INTERACTIVE_SHELL = 'unset HOST; exec zsh -i'

test('collectProxyVars inherits host proxy vars and overlays CLAUDE_PROXY', () => {
  const proxyVars = collectProxyVars(
    { HTTPS_PROXY: 'https://origin', http_proxy: 'http://legacy' },
    'http://override',
  )

  assert.deepEqual(proxyVars, {
    HTTP_PROXY: 'http://override',
    HTTPS_PROXY: 'http://override',
    ALL_PROXY: 'http://override',
    http_proxy: 'http://legacy',
    NEXUS_PROXY: 'http://override',
  })
})

test('buildProxyExportPrefix shell-quotes proxy values', () => {
  assert.equal(
    buildProxyExportPrefix({ HTTPS_PROXY: 'https://proxy.example.com' }),
    'export HTTPS_PROXY="https://proxy.example.com"',
  )
})

test('buildInteractiveShellCommand uses Claude launcher when profile exists', () => {
  const command = buildInteractiveShellCommand({
    shellType: 'claude',
    profile: 'kimi',
    cwd: '/workspace/demo',
    scriptsDir: '/srv/nexus',
    defaultInteractiveShell: DEFAULT_INTERACTIVE_SHELL,
    proxyVars: {},
  })

  assert.match(command, /nexus-run-claude\.sh/)
  assert.match(command, /"kimi"/)
  assert.match(command, /"\/workspace\/demo"/)
})

test('buildInteractiveShellCommand always routes Codex through isolated launcher', () => {
  const command = buildInteractiveShellCommand({
    shellType: 'codex',
    profile: '',
    cwd: '/workspace/demo',
    scriptsDir: '/srv/nexus',
    defaultInteractiveShell: DEFAULT_INTERACTIVE_SHELL,
    proxyVars: { HTTPS_PROXY: 'https://proxy.example.com' },
  })

  assert.match(command, /^export HTTPS_PROXY="https:\/\/proxy\.example\.com"; /)
  assert.match(command, /nexus-run-codex\.sh/)
  assert.match(command, /"" "\/workspace\/demo"/)
})

test('buildInteractiveShellCommand falls back to default interactive shell for zsh', () => {
  const command = buildInteractiveShellCommand({
    shellType: 'bash',
    profile: '',
    cwd: '/workspace/demo',
    scriptsDir: '/srv/nexus',
    defaultInteractiveShell: DEFAULT_INTERACTIVE_SHELL,
  })

  assert.equal(command, DEFAULT_INTERACTIVE_SHELL)
})
