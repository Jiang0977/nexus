/**
 * @typedef {{ name: string }} ProjectLike
 */

/**
 * Pick the safest session to restore after login.
 * Prefer an explicitly user-selected persisted session when it still exists.
 * Otherwise, only auto-select the server default session when it is
 * explicitly present in the discovered project list. If multiple projects
 * exist and the default session is missing, fail closed instead of
 * attaching the UI to an unrelated tmux session.
 *
 * @param {{
 *   storedSession?: string | null
 *   storedSessionSource?: string | null
 *   activeSession?: string | null
 *   defaultSession?: string | null
 *   projects?: ProjectLike[]
 * }} input
 * @returns {string}
 */
export function pickBootstrapSession(input) {
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

/**
 * @param {string | null | undefined} session
 * @param {ProjectLike[]} projects
 * @returns {boolean}
 */
export function sessionExists(session, projects) {
  const normalized = normalizeSession(session)
  return !!normalized && projects.some((project) => project.name === normalized)
}

/**
 * @param {string | null | undefined} session
 * @returns {string}
 */
function normalizeSession(session) {
  return typeof session === 'string' ? session.trim() : ''
}
