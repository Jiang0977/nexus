import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import { buildAuthHeaders, parseApiError, parseNetworkError } from './api'
import { visibleChannelsForProject } from './channelVisibility'
import { shouldAutoRefreshProjects } from './shouldAutoRefreshProjects'
import type { Channel, Project } from './types'

interface UseSessionManagerDataArgs {
  currentProject: string
  t: TFunction
  token: string
}

export function useSessionManagerData({ currentProject, t, token }: UseSessionManagerDataArgs) {
  const [projects, setProjects] = useState<Project[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [channelsProject, setChannelsProject] = useState('')
  const [hasLoadedProjects, setHasLoadedProjects] = useState(false)
  const [loadingProjects, setLoadingProjects] = useState(false)
  const [loadingChannels, setLoadingChannels] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const autoRefreshAttemptRef = useRef<string | null>(null)

  const headers = useMemo(() => buildAuthHeaders(token), [token])

  const fetchProjects = useCallback(async () => {
    setLoadingProjects(true)
    try {
      const response = await fetch('/api/projects', { headers })
      if (!response.ok) {
        setError(await parseApiError(response, t('sessionMgr.loadFailed')))
        return
      }
      setProjects(await response.json())
    } catch (fetchError: unknown) {
      setError(parseNetworkError(fetchError))
    } finally {
      setHasLoadedProjects(true)
      setLoadingProjects(false)
    }
  }, [headers, t])

  const fetchChannels = useCallback(async (projectName: string, opts?: { silent?: boolean }) => {
    const requestedProject = projectName.trim()
    if (!requestedProject) {
      setChannels([])
      setChannelsProject('')
      return
    }
    if (!opts?.silent) setLoadingChannels(true)
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(requestedProject)}/channels`, { headers })
      if (!response.ok) {
        setChannels([])
        setChannelsProject(requestedProject)
        setError(await parseApiError(response, t('sessionMgr.loadFailed')))
        return
      }
      const data = await response.json() as { channels?: Channel[] }
      setChannels(data.channels || [])
      setChannelsProject(requestedProject)
    } catch (fetchError: unknown) {
      setChannels([])
      setChannelsProject(requestedProject)
      setError(parseNetworkError(fetchError))
    } finally {
      if (!opts?.silent) setLoadingChannels(false)
    }
  }, [headers, t])

  useEffect(() => {
    const normalizedProject = currentProject.trim()
    if (!normalizedProject) {
      setChannels([])
      setChannelsProject('')
      return
    }
    if (channelsProject && channelsProject !== normalizedProject) {
      setChannels([])
      setChannelsProject('')
    }
  }, [channelsProject, currentProject])

  useEffect(() => {
    void fetchProjects()
  }, [fetchProjects])

  useEffect(() => {
    if (!currentProject) return
    void fetchChannels(currentProject)
  }, [currentProject, fetchChannels])

  useEffect(() => {
    const normalizedProject = currentProject.trim()
    if (!normalizedProject) {
      autoRefreshAttemptRef.current = null
      return
    }
    if (projects.some((project) => project.name === normalizedProject)) {
      autoRefreshAttemptRef.current = null
    }
  }, [currentProject, projects])

  useEffect(() => {
    if (!shouldAutoRefreshProjects({
      currentProject,
      hasLoadedProjects,
      loadingProjects,
      lastAttemptedProject: autoRefreshAttemptRef.current,
      projects,
    })) {
      return
    }

    autoRefreshAttemptRef.current = currentProject.trim()
    void fetchProjects()
  }, [currentProject, fetchProjects, hasLoadedProjects, loadingProjects, projects])

  const handleRefresh = useCallback(() => {
    void fetchProjects()
    if (currentProject) void fetchChannels(currentProject)
  }, [currentProject, fetchChannels, fetchProjects])

  return {
    channels: visibleChannelsForProject(channels, channelsProject, currentProject),
    error,
    fetchChannels,
    fetchProjects,
    handleRefresh,
    headers,
    loadingChannels,
    loadingProjects,
    projects,
    setError,
  }
}
