export const SERVER_ONLY_ENV_KEYS = ['HOST']

export function sanitizeInteractiveEnv(sourceEnv = process.env, overrides = {}) {
  const env = { ...sourceEnv, ...overrides }
  for (const key of SERVER_ONLY_ENV_KEYS) delete env[key]
  return env
}

export function wrapInteractiveShellCommand(command) {
  const cleanup = SERVER_ONLY_ENV_KEYS.map((key) => `unset ${key}`).join('; ')
  return cleanup ? `${cleanup}; ${command}` : command
}
