/**
 * @typedef {{ name: string }} ProjectLike
 */

/**
 * Pick the safest session to restore after login.
 * Prefer a persisted session when it still exists. Otherwise, if multiple
 * projects are available, avoid falling back to the server default session
 * because that path can trigger implicit tmux auto-heal behavior.
 *
 * @param {{
 *   storedSession?: string | null
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
  if (storedSession && names.has(storedSession)) return storedSession

  const activeSession = normalizeSession(input?.activeSession)
  if (activeSession && names.has(activeSession)) return activeSession

  const defaultSession = normalizeSession(input?.defaultSession)
  if (projects.length > 1 && defaultSession) {
    const nonDefault = projects.find((project) => project.name !== defaultSession)
    if (nonDefault) return nonDefault.name
  }

  return projects[0].name
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
