import { useCallback } from 'react'
import type { TFunction } from 'i18next'
import { parseApiError, parseNetworkError } from './api'
import type { Channel, Project } from './types'

interface UseSessionManagerActionsArgs {
  currentProject: string
  dismissChannelMenus: () => void
  dismissProjectMenus: () => void
  fetchChannels: (projectName: string, opts?: { silent?: boolean }) => Promise<void>
  fetchProjects: () => Promise<void>
  headers: Record<string, string>
  onClose: () => void
  onChannelClosed?: (channel: Channel, projectName: string) => void | Promise<void>
  onSwitchChannel: (channelIndex: number) => void
  onSwitchProject: (projectName: string, lastChannel?: number) => void
  projects: Project[]
  setError: (value: string | null) => void
  t: TFunction
}

export function useSessionManagerActions({
  currentProject,
  dismissChannelMenus,
  dismissProjectMenus,
  fetchChannels,
  fetchProjects,
  headers,
  onClose,
  onChannelClosed,
  onSwitchChannel,
  onSwitchProject,
  projects,
  setError,
  t,
}: UseSessionManagerActionsArgs) {
  const handleProjectClick = useCallback(async (project: Project) => {
    if (project.name === currentProject) return true
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project.name)}/activate`, {
        method: 'POST',
        headers,
      })
      if (!response.ok) {
        setError(await parseApiError(response, t('sessionMgr.switchFailed')))
        return false
      }
      const data = await response.json() as { lastChannel?: number }
      onSwitchProject(project.name, data.lastChannel)
      return true
    } catch (fetchError: unknown) {
      setError(parseNetworkError(fetchError))
      return false
    }
  }, [currentProject, headers, onSwitchProject, setError, t])

  const doSwitchChannel = useCallback(async (channel: Channel, shouldClose: boolean) => {
    try {
      const response = await fetch(`/api/sessions/${channel.index}/attach?session=${encodeURIComponent(currentProject)}`, {
        method: 'POST',
        headers,
      })
      if (!response.ok) {
        setError(await parseApiError(response, t('sessionMgr.switchFailed')))
        return
      }
      onSwitchChannel(channel.index)
      if (shouldClose) onClose()
    } catch (fetchError: unknown) {
      setError(parseNetworkError(fetchError))
    }
  }, [currentProject, headers, onClose, onSwitchChannel, setError, t])

  const handleRenameChannel = useCallback(async (channel: Channel) => {
    dismissChannelMenus()
    const newName = window.prompt(t('sessionMgr.renameChannelPrompt'), channel.name)
    if (!newName || newName === channel.name) return
    try {
      const response = await fetch(`/api/sessions/${channel.index}/rename?session=${encodeURIComponent(currentProject)}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      })
      if (!response.ok) {
        setError(await parseApiError(response, t('sessionMgr.renameFailed')))
        return
      }
      await fetchChannels(currentProject)
    } catch (fetchError: unknown) {
      setError(parseNetworkError(fetchError))
    }
  }, [currentProject, dismissChannelMenus, fetchChannels, headers, setError, t])

  const handleCloseChannel = useCallback(async (channel: Channel) => {
    dismissChannelMenus()
    try {
      const response = await fetch(`/api/sessions/${channel.index}?session=${encodeURIComponent(currentProject)}`, {
        method: 'DELETE',
        headers,
      })
      if (!response.ok) {
        setError(await parseApiError(response, t('sessionMgr.closeFailed')))
        return
      }
      await onChannelClosed?.(channel, currentProject)
      await fetchChannels(currentProject)
    } catch (fetchError: unknown) {
      setError(parseNetworkError(fetchError))
    }
  }, [currentProject, dismissChannelMenus, fetchChannels, headers, onChannelClosed, setError, t])

  const handleRenameProject = useCallback(async (project: Project) => {
    dismissProjectMenus()
    const newName = window.prompt(t('sessionMgr.renameProjectPrompt'), project.name)
    if (!newName || newName === project.name) return
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project.name)}/rename`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      })
      if (!response.ok) {
        setError(await parseApiError(response, t('sessionMgr.renameFailed')))
        return
      }
      await fetchProjects()
      if (project.name === currentProject) onSwitchProject(newName)
    } catch (fetchError: unknown) {
      setError(parseNetworkError(fetchError))
    }
  }, [currentProject, dismissProjectMenus, fetchProjects, headers, onSwitchProject, setError, t])

  const handleCloseProject = useCallback(async (project: Project) => {
    dismissProjectMenus()
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project.name)}`, {
        method: 'DELETE',
        headers,
      })
      if (!response.ok) {
        setError(await parseApiError(response, t('sessionMgr.closeFailed')))
        return
      }
      await fetchProjects()
      if (project.name === currentProject) {
        const remaining = projects.filter((existingProject) => existingProject.name !== project.name)
        if (remaining.length > 0) {
          void handleProjectClick(remaining[0])
        }
      }
    } catch (fetchError: unknown) {
      setError(parseNetworkError(fetchError))
    }
  }, [currentProject, dismissProjectMenus, fetchProjects, handleProjectClick, headers, projects, setError, t])

  return {
    doSwitchChannel,
    handleCloseChannel,
    handleCloseProject,
    handleProjectClick,
    handleRenameChannel,
    handleRenameProject,
  }
}
