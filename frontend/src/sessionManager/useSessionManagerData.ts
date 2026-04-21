import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TFunction } from 'i18next'
import { buildAuthHeaders, parseApiError, parseNetworkError } from './api'
import type { Channel, Project } from './types'

interface UseSessionManagerDataArgs {
  currentProject: string
  t: TFunction
  token: string
}

export function useSessionManagerData({ currentProject, t, token }: UseSessionManagerDataArgs) {
  const [projects, setProjects] = useState<Project[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [loadingProjects, setLoadingProjects] = useState(false)
  const [loadingChannels, setLoadingChannels] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
      setLoadingProjects(false)
    }
  }, [headers, t])

  const fetchChannels = useCallback(async (projectName: string, opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoadingChannels(true)
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectName)}/channels`, { headers })
      if (!response.ok) {
        setChannels([])
        setError(await parseApiError(response, t('sessionMgr.loadFailed')))
        return
      }
      const data = await response.json() as { channels?: Channel[] }
      setChannels(data.channels || [])
    } catch (fetchError: unknown) {
      setChannels([])
      setError(parseNetworkError(fetchError))
    } finally {
      if (!opts?.silent) setLoadingChannels(false)
    }
  }, [headers, t])

  useEffect(() => {
    void fetchProjects()
  }, [fetchProjects])

  useEffect(() => {
    if (!currentProject) return
    void fetchChannels(currentProject)
  }, [currentProject, fetchChannels])

  const handleRefresh = useCallback(() => {
    void fetchProjects()
    if (currentProject) void fetchChannels(currentProject)
  }, [currentProject, fetchChannels, fetchProjects])

  return {
    channels,
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
