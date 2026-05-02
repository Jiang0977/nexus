interface ProjectLike {
  name: string
}

interface AutoRefreshProjectsArgs {
  currentProject: string
  hasLoadedProjects: boolean
  loadingProjects: boolean
  lastAttemptedProject: string | null
  projects: ProjectLike[]
}

export function shouldAutoRefreshProjects({
  currentProject,
  hasLoadedProjects,
  loadingProjects,
  lastAttemptedProject,
  projects,
}: AutoRefreshProjectsArgs) {
  const normalizedProject = currentProject.trim()
  if (!normalizedProject || !hasLoadedProjects || loadingProjects || lastAttemptedProject === normalizedProject) {
    return false
  }
  return !projects.some((project) => project.name === normalizedProject)
}
