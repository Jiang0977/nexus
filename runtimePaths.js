import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function resolveProjectRoot(metaUrl) {
  const currentDir = dirname(fileURLToPath(metaUrl))
  if (basename(currentDir) === 'dist-server') {
    return dirname(currentDir)
  }
  return currentDir
}

export function createRuntimePaths(metaUrl) {
  const projectRoot = resolveProjectRoot(metaUrl)
  return {
    projectRoot,
    envFile: join(projectRoot, '.env'),
    dataDir: join(projectRoot, 'data'),
    publicDir: join(projectRoot, 'public'),
    frontendDistDir: join(projectRoot, 'frontend', 'dist'),
  }
}
