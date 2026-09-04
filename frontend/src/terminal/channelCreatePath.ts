export function channelCreatePath(
  projectPath: string | undefined,
  workspaceRoot: string | undefined,
): string | undefined {
  const path = typeof projectPath === 'string' ? projectPath.trim() : ''
  if (!path) return undefined

  const root = typeof workspaceRoot === 'string' ? workspaceRoot.trim().replace(/\/+$/, '') : ''
  if (root && path.replace(/\/+$/, '') === root) return undefined

  return path
}
