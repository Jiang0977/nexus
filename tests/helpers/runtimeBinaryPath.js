import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function resolveRepoRoot(metaUrl) {
  return resolve(dirname(fileURLToPath(metaUrl)), '..', '..')
}

export function resolveReleaseBinary(metaUrl, binaryName) {
  return join(
    resolveRepoRoot(metaUrl),
    'rust-runtime',
    'target',
    'release',
    process.platform === 'win32' ? `${binaryName}.exe` : binaryName,
  )
}
