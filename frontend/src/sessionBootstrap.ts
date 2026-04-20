export interface BootstrapProjectLike {
  name: string
}

export interface PickBootstrapSessionInput {
  storedSession?: string | null
  storedSessionSource?: string | null
  activeSession?: string | null
  defaultSession?: string | null
  projects?: BootstrapProjectLike[]
}

/**
 * Pick the safest session to restore after login.
 * Prefer an explicitly user-selected persisted session when it still exists.
 * Otherwise, only auto-select the server default session when it is
 * explicitly present in the discovered project list. If multiple projects
 * exist and the default session is missing, fail closed instead of
 * attaching the UI to an unrelated tmux session.
 */
export function pickBootstrapSession(input: PickBootstrapSessionInput): string {
  const projects = Array.isArray(input?.projects)
    ? input.projects.filter((project) => typeof project?.name === 'string' && project.name.trim())
    : []

  if (projects.length === 0) return ''

  const names = new Set(projects.map((project) => project.name))
  const storedSession = normalizeSession(input?.storedSession)
  const storedSessionSource = normalizeSession(input?.storedSessionSource)
  if (storedSessionSource === 'user' && storedSession && names.has(storedSession)) return storedSession

  const activeSession = normalizeSession(input?.activeSession)
  if (activeSession && names.has(activeSession)) return activeSession

  const defaultSession = normalizeSession(input?.defaultSession)
  if (defaultSession && names.has(defaultSession)) return defaultSession

  if (projects.length === 1) return projects[0].name

  return ''
}

export function sessionExists(session: string | null | undefined, projects: BootstrapProjectLike[]): boolean {
  const normalized = normalizeSession(session)
  return !!normalized && projects.some((project) => project.name === normalized)
}

function normalizeSession(session: string | null | undefined): string {
  return typeof session === 'string' ? session.trim() : ''
}
