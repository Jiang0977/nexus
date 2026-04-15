import { join } from 'path'

import { wrapInteractiveShellCommand } from './interactiveEnv.js'
import { usesClaudeProfile, usesCodexProfile } from './frontend/src/shellType.js'

export function shellQuote(value) {
  return JSON.stringify(String(value))
}

export function collectProxyVars(env = process.env, claudeProxy = '') {
  return {
    ...(env.HTTP_PROXY ? { HTTP_PROXY: env.HTTP_PROXY } : {}),
    ...(env.HTTPS_PROXY ? { HTTPS_PROXY: env.HTTPS_PROXY } : {}),
    ...(env.ALL_PROXY ? { ALL_PROXY: env.ALL_PROXY } : {}),
    ...(env.http_proxy ? { http_proxy: env.http_proxy } : {}),
    ...(env.https_proxy ? { https_proxy: env.https_proxy } : {}),
    ...(claudeProxy ? {
      ALL_PROXY: claudeProxy,
      HTTPS_PROXY: claudeProxy,
      HTTP_PROXY: claudeProxy,
      NEXUS_PROXY: claudeProxy,
    } : {}),
  }
}

export function buildProxyExportPrefix(proxyVars = {}) {
  return Object.entries(proxyVars)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join('; ')
}

export function buildInteractiveShellCommand({
  shellType,
  profile,
  cwd,
  scriptsDir,
  defaultInteractiveShell,
  proxyVars = {},
  resumeSessionId = '',
}) {
  const proxyPrefix = buildProxyExportPrefix(proxyVars)
  let command = defaultInteractiveShell

  if (usesClaudeProfile(shellType)) {
    if (profile) {
      const runScript = join(scriptsDir, 'nexus-run-claude.sh')
      command = wrapInteractiveShellCommand(
        `bash ${shellQuote(runScript)} ${shellQuote(profile)} ${shellQuote(cwd)}`,
      )
    } else {
      command = wrapInteractiveShellCommand('claude --dangerously-skip-permissions; exec zsh -i')
    }
  } else if (usesCodexProfile(shellType)) {
    const runScript = join(scriptsDir, 'nexus-run-codex.sh')
    command = wrapInteractiveShellCommand(
      `bash ${shellQuote(runScript)} ${shellQuote(profile || '')} ${shellQuote(cwd)} ${shellQuote(resumeSessionId || '')}`,
    )
  }

  return proxyPrefix ? `${proxyPrefix}; ${command}` : command
}
