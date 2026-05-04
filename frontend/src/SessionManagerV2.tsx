import { useState, useEffect, useCallback, useRef, useImperativeHandle, forwardRef } from 'react'
import { useTranslation } from 'react-i18next'
import GhostShield from './GhostShield'
import CodexSessionsPanel from './CodexSessionsPanel'
import { Icon } from './icons'
import { ErrorBanner } from './sessionManager/ErrorBanner'
import type { Channel, Project, SessionManagerSidebarDetailView } from './sessionManager/types'
import { useSessionManagerActions } from './sessionManager/useSessionManagerActions'
import { useSessionManagerData } from './sessionManager/useSessionManagerData'
import { channelTargetKey } from './terminal/splitLayoutTypes'

interface Props {
  token: string
  currentProject: string
  currentChannelIndex?: number
  onClose: () => void
  onSwitchProject: (projectName: string, lastChannel?: number) => void
  onSwitchChannel: (channelIndex: number) => void
  onNewProject: () => void
  onNewChannel: () => void
  /** Refresh callback — exposed for sidebar toggle integration */
  onRefresh?: () => void
  layout?: 'modal' | 'sidebar'
  codexHistoryEnabled?: boolean
  sidebarDetailView?: SessionManagerSidebarDetailView
  onSidebarDetailViewChange?: (view: SessionManagerSidebarDetailView) => void
  onCodexResumeSuccess?: (channelIndex: number) => void
  onCodexDeleteSuccess?: (closedWindowIndexes: number[]) => void | Promise<void>
  onStartNewCodex?: () => void
  activeSplitPaneId?: string | null
  onChannelDragStart?: (event: React.DragEvent<HTMLElement>, channel: Channel, projectName: string) => void
  onChannelClosed?: (channel: Channel, projectName: string) => void | Promise<void>
  onSidebarChannelClick?: (channel: Channel, projectName: string) => void
  paneAssignmentsByChannelKey?: Record<string, string[]>
}

function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 768)
  useEffect(() => {
    const onResize = () => setIsDesktop(window.innerWidth >= 768)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return isDesktop
}

const STATUS_DOT = {
  running: '#22c55e',
  idle: '#9ca3af',
  waiting: '#eab308',
  shell: '#6b7280',
}

function getChannelStatus(channel: Channel, isActive: boolean): keyof typeof STATUS_DOT {
  if (channel.name === 'shell' || channel.name.endsWith('-shell')) return 'shell'
  return isActive ? 'running' : 'idle'
}

export interface SessionManagerV2Handle {
  refresh: () => void
}
export type { SessionManagerSidebarDetailView } from './sessionManager/types'

export default forwardRef<SessionManagerV2Handle, Props>(function SessionManagerV2({
  token,
  currentProject,
  currentChannelIndex,
  onClose,
  onSwitchProject,
  onSwitchChannel,
  onNewProject,
  onNewChannel,
  onRefresh: _onRefresh,
  layout = 'modal',
  codexHistoryEnabled = true,
  sidebarDetailView = 'channels',
  onSidebarDetailViewChange,
  onCodexResumeSuccess,
  onCodexDeleteSuccess,
  onStartNewCodex,
  activeSplitPaneId = null,
  onChannelDragStart,
  onChannelClosed,
  onSidebarChannelClick,
  paneAssignmentsByChannelKey,
}: Props, ref) {
  const { t } = useTranslation()
  const isDesktop = useIsDesktop()
  const isSidebar = layout === 'sidebar'
  const {
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
  } = useSessionManagerData({ currentProject, t, token })

  // Mobile/modal gesture state
  const clickTimerRef = useRef<number | null>(null)
  const pendingChannelRef = useRef<Channel | null>(null)
  const longPressTimerRef = useRef<number | null>(null)
  const longPressChannelRef = useRef<Channel | null>(null)
  const isLongPressRef = useRef(false)
  const [longPressMenu, setLongPressMenu] = useState<{ channel: Channel; x: number; y: number } | null>(null)
  const [pressChannel, setPressChannel] = useState<number | null>(null)
  const [channelMenu, setChannelMenu] = useState<{ channel: Channel; x: number; y: number } | null>(null)
  const [projectMenu, setProjectMenu] = useState<{ project: Project; x: number; y: number } | null>(null)

  // Sidebar right-click menu state
  const [sidebarChannelMenu, setSidebarChannelMenu] = useState<{ channel: Channel; x: number; y: number } | null>(null)
  const [sidebarProjectMenu, setSidebarProjectMenu] = useState<{ project: Project; x: number; y: number } | null>(null)
  const [expandedProjectName, setExpandedProjectName] = useState<string | null>(currentProject || null)

  const activeSidebarDetailView = isSidebar && currentProject && codexHistoryEnabled ? sidebarDetailView : 'channels'
  const usesProjectTreeLayout = isSidebar || !isDesktop

  useEffect(() => {
    if (!isSidebar) return
    if (!codexHistoryEnabled || !currentProject) {
      if (sidebarDetailView === 'codex') {
        onSidebarDetailViewChange?.('channels')
      }
      return
    }
    if (sidebarDetailView !== 'codex') return
  }, [codexHistoryEnabled, currentProject, isSidebar, onSidebarDetailViewChange, sidebarDetailView])

  useEffect(() => {
    if (!usesProjectTreeLayout) return
    if (!currentProject) {
      setExpandedProjectName(null)
      return
    }
    setExpandedProjectName(currentProject)
  }, [currentProject, usesProjectTreeLayout])

  useEffect(() => {
    if (!isSidebar || !currentProject) return
    if (sidebarDetailView === 'codex') {
      setExpandedProjectName(currentProject)
    }
  }, [currentProject, isSidebar, sidebarDetailView])

  useImperativeHandle(ref, () => ({ refresh: handleRefresh }), [handleRefresh])

  // --- Actions ---
  const dismissChannelMenus = useCallback(() => {
    setChannelMenu(null)
    setLongPressMenu(null)
    setSidebarChannelMenu(null)
  }, [])

  const dismissProjectMenus = useCallback(() => {
    setProjectMenu(null)
    setSidebarProjectMenu(null)
  }, [])

  const {
    doSwitchChannel,
    handleCloseChannel,
    handleCloseProject,
    handleProjectClick,
    handleRenameChannel,
    handleRenameProject,
  } = useSessionManagerActions({
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
  })

  // --- Modal mode: position-based menus ---

  const showModalChannelMenu = (channel: Channel, e: React.MouseEvent | React.TouchEvent) => {
    const { x, y } = getRowMenuPosition(e)
    setChannelMenu({ channel, x, y })
  }

  const showModalProjectMenu = (project: Project, e: React.MouseEvent | React.TouchEvent) => {
    const { x, y } = getRowMenuPosition(e)
    setProjectMenu({ project, x, y })
  }

  const getRowMenuPosition = (e: React.MouseEvent | React.TouchEvent) => {
    // Get the row div (parent of the button), not the button itself
    const row = (e.currentTarget as HTMLElement).closest('[data-menu-row]') as HTMLElement
    const rect = row ? row.getBoundingClientRect() : (e.currentTarget as HTMLElement).getBoundingClientRect()
    const menuWidth = 160
    const menuHeight = 80
    let x = rect.right - menuWidth
    let y = rect.bottom + 4
    if (x + menuWidth > window.innerWidth - 16) x = window.innerWidth - menuWidth - 16
    if (x < 16) x = 16
    if (y + menuHeight > window.innerHeight - 16) y = rect.top - menuHeight - 4
    return { x, y }
  }

  // --- Sidebar mode: right-click context menu ---

  const handleSidebarContext = (e: React.MouseEvent, channel?: Channel, project?: Project) => {
    e.preventDefault()
    const clickX = e.clientX
    const clickY = e.clientY
    if (channel) {
      const menuWidth = 150
      let x = clickX + 4
      let y = clickY + 4
      if (y + 90 > window.innerHeight) y = clickY - 90
      if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth
      if (x < 0) x = 0
      setSidebarChannelMenu({ channel, x, y })
    } else if (project) {
      const menuWidth = 170
      let x = clickX + 4
      let y = clickY + 4
      if (y + 110 > window.innerHeight) y = clickY - 110
      if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth
      if (x < 0) x = 0
      setSidebarProjectMenu({ project, x, y })
    }
  }

  // --- Mobile touch gestures ---

  const handleChannelTouchStart = (channel: Channel, e: React.TouchEvent) => {
    isLongPressRef.current = false
    longPressChannelRef.current = channel
    setPressChannel(channel.index)
    longPressTimerRef.current = window.setTimeout(() => {
      isLongPressRef.current = true
      setPressChannel(null)
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const menuWidth = 120
      const menuHeight = 80
      let x = rect.left + rect.width / 2
      let y = rect.bottom + 8
      if (x + menuWidth / 2 > window.innerWidth - 16) x = window.innerWidth - menuWidth / 2 - 16
      if (x - menuWidth / 2 < 16) x = menuWidth / 2 + 16
      if (y + menuHeight > window.innerHeight - 16) y = rect.top - menuHeight - 8
      setLongPressMenu({ channel, x, y })
    }, 500)
  }

  const handleChannelTouchEnd = (channel: Channel) => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    if (isLongPressRef.current) { setPressChannel(null); return }
    setTimeout(() => setPressChannel(null), 100)
    if (channel.index === currentChannelIndex) { onClose(); return }
    pendingChannelRef.current = channel
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
      doSwitchChannel(channel, true)
    } else {
      clickTimerRef.current = window.setTimeout(() => {
        clickTimerRef.current = null
        if (pendingChannelRef.current) doSwitchChannel(pendingChannelRef.current, false)
      }, 250)
    }
  }

  const handleChannelTouchMove = () => {
    setPressChannel(null)
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null }
  }

  const activeChannelMenu = isSidebar ? null : (longPressMenu || channelMenu)

  const handleTreeProjectToggle = useCallback(async (project: Project) => {
    if (project.name === currentProject) {
      setExpandedProjectName(prev => prev === project.name ? null : project.name)
      return
    }

    const switched = await handleProjectClick(project)
    if (switched) {
      setExpandedProjectName(project.name)
    }
  }, [currentProject, handleProjectClick])

  const formatPath = (p: string) => {
    if (!p) return ''
    // Truncate long paths for display
    const parts = p.split('/').filter(Boolean)
    if (parts.length > 3) {
      return '...' + '/' + parts.slice(-2).join('/')
    }
    return p
  }

  const menuButtonClass = (mode: 'sidebar' | 'modal') =>
    mode === 'sidebar'
      ? 'bg-transparent border-none text-nexus-text-2 cursor-pointer p-1 flex items-center justify-center opacity-0 group-hover/item:opacity-100 transition-opacity duration-150 shrink-0'
      : 'bg-transparent border-none text-nexus-text-2 cursor-pointer p-1 flex items-center justify-center opacity-60 transition-opacity duration-150 shrink-0'

  const treeRowActionButtonClass = 'inline-flex h-7 w-7 items-center justify-center rounded-md bg-transparent text-nexus-text-2 cursor-pointer opacity-80 transition-colors hover:bg-nexus-bg/70 hover:text-nexus-text'

  const sidebarTabClass = (active: boolean) =>
    `relative inline-flex flex-1 items-center justify-center border-none bg-transparent px-0 py-2.5 text-center text-sm cursor-pointer transition-colors ${
      active
        ? 'text-[#4f8cff] after:absolute after:left-0 after:right-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-[#4f8cff]'
        : 'text-nexus-text-2 hover:text-nexus-text'
    }`

  const renderSidebarChannels = () => (
    <div className="mt-2 flex flex-col gap-1.5">
      {loadingChannels ? (
        <div className="rounded-lg px-3 py-2 text-sm text-nexus-muted">
          {t('common.loading')}
        </div>
      ) : channels.length === 0 ? (
        <div className="rounded-lg px-3 py-3 text-sm text-nexus-muted">
          {t('sessionMgr.noChannels')}
        </div>
      ) : (
        channels.map(channel => {
          const isActive = channel.index === currentChannelIndex
          const status = getChannelStatus(channel, isActive)
          const channelKey = channelTargetKey(currentProject, channel.index)
          const assignedPaneIds = paneAssignmentsByChannelKey?.[channelKey] || []
          const visiblePaneNumbers = assignedPaneIds.map((paneId) => paneId.replace('pane-', ''))
          const isPaneFocused = activeSplitPaneId ? assignedPaneIds.includes(activeSplitPaneId) : false
          return (
            <div
              key={channel.index}
              data-menu-row
              data-testid={`sidebar-channel-${currentProject}-${channel.index}`}
              draggable={Boolean(onChannelDragStart)}
              className={`flex items-start gap-2 rounded-lg px-2.5 py-2 cursor-pointer select-none transition-colors duration-75 group/item ${isActive ? 'bg-nexus-accent/10' : isPaneFocused ? 'bg-nexus-accent/[0.07] hover:bg-nexus-accent/10' : 'hover:bg-nexus-bg-2/60'}`}
              style={{ WebkitTouchCallout: 'none' }}
              onDragStart={(event) => onChannelDragStart?.(event, channel, currentProject)}
              onClick={() => {
                if (onChannelDragStart) {
                  onSidebarChannelClick?.(channel, currentProject)
                  return
                }
                void doSwitchChannel(channel, false)
              }}
              onContextMenu={(e) => { e.preventDefault(); handleSidebarContext(e, channel, undefined) }}
              title={visiblePaneNumbers.length > 0 ? t('sessionMgr.displayedInPanes', { panes: visiblePaneNumbers.join(', ') }) : channel.name}
            >
              <span className="w-2 h-2 rounded-full shrink-0 mt-1" style={{ background: STATUS_DOT[status] }} title={status} />
              <span className="text-nexus-text-2 text-[13px] font-medium select-none shrink-0 mt-0.5">#</span>
              <span className="flex-1 min-w-0 text-sm text-nexus-text truncate leading-tight" title={channel.name}>{channel.name}</span>
              {visiblePaneNumbers.length > 0 && (
                <div
                  data-testid={`sidebar-channel-assigned-panes-${currentProject}-${channel.index}`}
                  className="ml-1 flex shrink-0 items-center gap-1"
                >
                  {visiblePaneNumbers.map((paneNumber, badgeIndex) => {
                    const paneId = assignedPaneIds[badgeIndex]
                    const isFocusedPane = paneId === activeSplitPaneId
                    return (
                      <span
                        key={paneId}
                        className={`inline-flex min-w-[18px] items-center justify-center rounded-md border px-1 py-0.5 text-[10px] font-semibold leading-none ${
                          isFocusedPane
                            ? 'border-nexus-accent bg-nexus-accent/15 text-nexus-accent'
                            : 'border-nexus-border bg-nexus-bg2/50 text-nexus-text-2'
                        }`}
                      >
                        {paneNumber}
                      </span>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })
      )}
    </div>
  )

  const renderMobileTreeChannels = () => (
    <div className="mt-2 flex flex-col gap-1.5">
      {loadingChannels ? (
        <div className="rounded-lg px-3 py-2 text-sm text-nexus-muted">
          {t('common.loading')}
        </div>
      ) : channels.length === 0 ? (
        <div className="rounded-lg px-3 py-3 text-sm text-nexus-muted">
          {t('sessionMgr.noChannels')}
        </div>
      ) : (
        channels.map(channel => {
          const isActive = channel.index === currentChannelIndex
          const status = getChannelStatus(channel, isActive)
          return (
            <div
              key={channel.index}
              data-menu-row
              className={`group/item flex items-start gap-2 rounded-lg px-2.5 py-2 cursor-pointer select-none transition-colors duration-75 ${isActive ? 'bg-nexus-accent/10' : 'hover:bg-nexus-bg-2/60'} ${pressChannel === channel.index ? 'bg-nexus-border/80' : ''}`}
              style={{ WebkitTouchCallout: 'none' }}
              onPointerDown={() => { if (isDesktop) void doSwitchChannel(channel, false) }}
              onTouchStart={(e) => { if (!isDesktop) handleChannelTouchStart(channel, e) }}
              onTouchEnd={(e) => { if (!isDesktop) { e.preventDefault(); handleChannelTouchEnd(channel) } }}
              onTouchMove={() => { if (!isDesktop) handleChannelTouchMove() }}
            >
              <span className="w-2 h-2 rounded-full shrink-0 mt-1" style={{ background: STATUS_DOT[status] }} title={status} />
              <span className="text-nexus-text-2 text-[13px] font-medium select-none shrink-0 mt-0.5">#</span>
              <span className="flex-1 min-w-0 text-sm text-nexus-text truncate leading-tight" title={channel.name}>{channel.name}</span>
              <button
                className={menuButtonClass('modal')}
                onPointerDown={(e) => {
                  e.stopPropagation()
                  showModalChannelMenu(channel, e)
                }}
                onTouchStart={(e) => e.stopPropagation()}
                onTouchEnd={(e) => e.stopPropagation()}
                title={t('sessionMgr.moreOptions')}
              >
                <Icon name="more" size={16} />
              </button>
            </div>
          )
        })
      )}
    </div>
  )

  const renderMobileTreeContent = () => (
    <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
      <ErrorBanner error={error} onDismiss={() => setError(null)} shrink />

      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2">
        {loadingProjects ? (
          <div className="px-3 py-2 text-sm text-nexus-muted">{t('common.loading')}</div>
        ) : projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg px-3 py-6 text-nexus-muted">
            <div className="text-[28px] mb-2 opacity-50">📁</div>
            <div className="text-sm">{t('sessionMgr.noProjects')}</div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {projects.map(project => {
              const isCurrent = project.name === currentProject
              const isExpanded = isCurrent && expandedProjectName === project.name
              return (
                <div key={project.name}>
                  <div
                    data-menu-row
                    className={`group/item flex items-start gap-2 rounded-xl px-2.5 py-2.5 cursor-pointer select-none transition-colors ${isCurrent ? 'bg-nexus-accent/10' : 'hover:bg-nexus-bg-2/60'}`}
                    onPointerDown={() => { void handleTreeProjectToggle(project) }}
                  >
                    <span className="mt-0.5 shrink-0 text-nexus-text-2">
                      <Icon name={isExpanded ? 'arrowDown' : 'arrowRight'} size={14} />
                    </span>
                    <span className={`w-2 h-2 rounded-full shrink-0 mt-1 ${isCurrent ? 'bg-nexus-accent' : 'bg-nexus-muted'}`} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-nexus-text truncate leading-tight" title={project.name}>{project.name}</div>
                      {project.path && (
                        <div className="text-[11px] text-nexus-text-2 font-mono truncate mt-0.5" title={project.path}>
                          {formatPath(project.path)}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <span className="text-xs text-nexus-text-2 font-mono shrink-0">{project.channelCount}</span>
                      {isCurrent && (
                        <button
                          className={treeRowActionButtonClass}
                          onPointerDown={(e) => {
                            e.stopPropagation()
                            onNewChannel()
                          }}
                          type="button"
                          title={t('sessionMgr.newChannel')}
                          aria-label={t('sessionMgr.newChannel')}
                        >
                          <Icon name="edit" size={15} />
                        </button>
                      )}
                      <button
                        className={menuButtonClass('modal')}
                        onPointerDown={(e) => {
                          e.stopPropagation()
                          showModalProjectMenu(project, e)
                        }}
                        onTouchStart={(e) => e.stopPropagation()}
                        onTouchEnd={(e) => e.stopPropagation()}
                        title={t('sessionMgr.moreOptions')}
                      >
                        <Icon name="more" size={16} />
                      </button>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="ml-5 mt-1.5 border-l border-nexus-border/70 pl-3 pb-1">
                      <div className="flex items-center gap-1.5 border-b border-nexus-border/60 pb-1 text-[11px] font-semibold tracking-wide text-nexus-text-2">
                        <span>#</span>
                        <span>{t('sessionMgr.channels')}</span>
                      </div>
                      {renderMobileTreeChannels()}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="border-t border-nexus-border px-3 py-2 shrink-0">
        <button
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-nexus-border px-2.5 py-2 text-sm text-nexus-text-2 cursor-pointer hover:bg-nexus-bg-2 transition-colors"
          onPointerDown={onNewProject}
          type="button"
        >
          <Icon name="plus" size={14} />
          <span>{t('sessionMgr.newProject')}</span>
        </button>
      </div>

      {activeChannelMenu && (
        <>
          <div className="fixed inset-0 z-[150]" onPointerDown={() => { setLongPressMenu(null); setChannelMenu(null) }} />
          <div
            className="fixed bg-nexus-bg border border-nexus-border rounded-lg py-1 min-w-[120px] shadow-[0_4px_20px_rgba(0,0,0,0.3)] z-[151]"
            style={{ left: activeChannelMenu.x, top: activeChannelMenu.y }}
          >
            <button className="flex items-center gap-2 px-4 py-2.5 bg-transparent border-none text-nexus-text text-sm cursor-pointer w-full text-left" onPointerDown={() => handleRenameChannel(activeChannelMenu.channel)}>
              <Icon name="pencil" size={14} />
              <span>{t('common.rename')}</span>
            </button>
            <div className="h-px bg-nexus-border my-1" />
            <button className="flex items-center gap-2 px-4 py-2.5 bg-transparent border-none text-nexus-error text-sm cursor-pointer w-full text-left" onPointerDown={() => handleCloseChannel(activeChannelMenu.channel)}>
              <Icon name="x" size={14} />
              <span>{t('common.close')}</span>
            </button>
          </div>
        </>
      )}
    </div>
  )

  // ====== Shared content ======
  const content = (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {/* Project 列表 */}
        <div className="flex-1 py-2 flex flex-col min-h-0" >
          <div className="px-3 pb-1.5 border-b border-nexus-border mb-1.5">
            <div className="text-xs font-semibold text-nexus-text tracking-wide flex items-center justify-between gap-1.5">
              <div className="flex items-center gap-1.5">
                <span className="text-sm">📁</span>
                {t('sessionMgr.projects')}
              </div>
              {isSidebar && (
                <button
                  className="bg-transparent border-none text-nexus-text-2 cursor-pointer p-1 flex items-center justify-center opacity-70 hover:opacity-100 transition-opacity"
                  onClick={handleRefresh}
                  title={t('sessionMgr.refresh') || 'Refresh'}
                >
                  <Icon name="refresh" size={14} />
                </button>
              )}
            </div>
          </div>

          <div
            className="flex-1 overflow-y-auto px-1.5 min-h-0"
          >
            {loadingProjects ? (
              <div className="text-nexus-muted text-sm px-3 py-2">{t('common.loading')}</div>
            ) : projects.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-3 py-4 text-nexus-muted">
                <div className="text-[28px] mb-1.5 opacity-50">📁</div>
                <div className="text-sm">{t('sessionMgr.noProjects')}</div>
              </div>
            ) : projects.map(project => {
              const isActive = project.name === currentProject
              return (
                <div
                  key={project.name}
                  data-menu-row
                  className={`flex items-start gap-2 px-2.5 py-1.5 rounded cursor-pointer mb-0.5 select-none group/item ${isActive ? 'bg-blue-500/15' : ''}`}
                  onPointerDown={() => {
                    if (project.name !== currentProject) handleProjectClick(project)
                  }}
                  onContextMenu={isSidebar ? (e) => { e.preventDefault(); handleSidebarContext(e, undefined, project) } : undefined}
                >
                  <span className={`w-2 h-2 rounded-full shrink-0 mt-0.5 ${isActive ? 'bg-blue-500' : 'bg-nexus-muted'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-nexus-text truncate leading-tight" title={project.name}>{project.name}</div>
                    {project.path && (
                      <div className="text-[11px] text-nexus-text-2 font-mono truncate mt-0.5" title={project.path}>
                        {formatPath(project.path)}
                      </div>
                    )}
                  </div>
                  <span className="text-xs text-nexus-text-2 font-mono shrink-0">({project.channelCount})</span>
                  {!isSidebar && (
                    <button
                      className={menuButtonClass('modal')}
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        showModalProjectMenu(project, e)
                      }}
                      onTouchStart={(e) => e.stopPropagation()}
                      onTouchEnd={(e) => e.stopPropagation()}
                      title={t('sessionMgr.moreOptions')}
                    >
                      <Icon name="more" size={16} />
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          <button className="flex items-center justify-center gap-1.5 mx-3 my-1.5 px-2.5 py-1.5 bg-transparent border border-dashed border-nexus-border rounded text-nexus-text-2 text-sm cursor-pointer" onPointerDown={onNewProject}>
            <Icon name="plus" size={14} />
            <span>{t('sessionMgr.newProject')}</span>
          </button>
        </div>

        {/* Channel 列表 */}
        <div className="flex-1 py-2 flex flex-col min-h-0" >
          <div className="px-3 pb-1.5 border-b border-nexus-border mb-1.5">
            <div className="text-xs font-semibold text-nexus-text tracking-wide flex items-center gap-1.5">
              <span className="text-sm">#</span>
              {t('sessionMgr.channels')}
            </div>
          </div>

          <div
            className="flex-1 overflow-y-auto px-1.5 min-h-0"
          >
            {loadingChannels ? (
              <div className="text-nexus-muted text-sm px-3 py-2">{t('common.loading')}</div>
            ) : channels.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-3 py-4 text-nexus-muted">
                <div className="text-[28px] mb-1.5 opacity-50">#</div>
                <div className="text-sm">{t('sessionMgr.noChannels')}</div>
              </div>
            ) : channels.map(channel => {
              const isActive = channel.index === currentChannelIndex
              const status = getChannelStatus(channel, isActive)
              return (
                <div
                  key={channel.index}
                  data-menu-row
                  className={`flex items-start gap-2 px-2.5 py-1.5 rounded cursor-pointer mb-0.5 select-none transition-colors duration-75 group/item ${isActive ? 'bg-nexus-bg-2' : ''} ${!isDesktop && pressChannel === channel.index ? 'bg-nexus-border' : ''}`}
                  style={{ WebkitTouchCallout: 'none' }}
                  onPointerDown={() => { if (isDesktop) doSwitchChannel(channel, false) }}
                  onContextMenu={isSidebar ? (e) => { e.preventDefault(); handleSidebarContext(e, channel, undefined) } : undefined}
                  onTouchStart={(e) => { if (!isDesktop) handleChannelTouchStart(channel, e) }}
                  onTouchEnd={(e) => { if (!isDesktop) { e.preventDefault(); handleChannelTouchEnd(channel) } }}
                  onTouchMove={() => { if (!isDesktop) handleChannelTouchMove() }}
                >
                  <span className="w-2 h-2 rounded-full shrink-0 mt-0.5" style={{ background: STATUS_DOT[status] }} title={status} />
                  <span className="text-nexus-text-2 text-[13px] font-medium select-none shrink-0 mt-0">#</span>
                  <span className="flex-1 text-sm text-nexus-text truncate leading-tight min-w-0" title={channel.name}>{channel.name}</span>
                  {!isSidebar && (
                    <button
                      className={menuButtonClass('modal')}
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        showModalChannelMenu(channel, e)
                      }}
                      onTouchStart={(e) => e.stopPropagation()}
                      onTouchEnd={(e) => e.stopPropagation()}
                      title={t('sessionMgr.moreOptions')}
                    >
                      <Icon name="more" size={16} />
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          <button className="flex items-center justify-center gap-1.5 mx-3 my-1.5 px-2.5 py-1.5 bg-transparent border border-dashed border-nexus-border rounded text-nexus-text-2 text-sm cursor-pointer" onPointerDown={onNewChannel}>
            <Icon name="plus" size={14} />
            <span>{t('sessionMgr.newChannel')}</span>
          </button>

          {/* Modal mode: channel menu overlay */}
          {activeChannelMenu && (
            <>
              <div className="fixed inset-0 z-[150]" onPointerDown={() => { setLongPressMenu(null); setChannelMenu(null) }} />
              <div
                className="fixed bg-nexus-bg border border-nexus-border rounded-lg py-1 min-w-[120px] shadow-[0_4px_20px_rgba(0,0,0,0.3)] z-[151]"
                style={{ left: activeChannelMenu.x, top: activeChannelMenu.y }}
              >
                <button className="flex items-center gap-2 px-4 py-2.5 bg-transparent border-none text-nexus-text text-sm cursor-pointer w-full text-left" onPointerDown={() => handleRenameChannel(activeChannelMenu.channel)}>
                  <Icon name="pencil" size={14} />
                  <span>{t('common.rename')}</span>
                </button>
                <div className="h-px bg-nexus-border my-1" />
                <button className="flex items-center gap-2 px-4 py-2.5 bg-transparent border-none text-nexus-error text-sm cursor-pointer w-full text-left" onPointerDown={() => handleCloseChannel(activeChannelMenu.channel)}>
                  <Icon name="x" size={14} />
                  <span>{t('common.close')}</span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )

  // ====== Sidebar mode ======
  if (isSidebar) {
    return (
      <div className="flex h-full flex-col bg-nexus-bg text-nexus-text">
        <ErrorBanner error={error} onDismiss={() => setError(null)} shrink />

        <div className="pl-3 pr-11 py-2 border-b border-nexus-border shrink-0">
          <div className="text-xs font-semibold text-nexus-text tracking-wide flex items-center justify-between gap-1.5">
            <div className="flex items-center gap-1.5">
              <span className="text-sm">📁</span>
              {t('sessionMgr.projects')}
            </div>
            <button
              className="bg-transparent border-none text-nexus-text-2 cursor-pointer p-1 flex items-center justify-center opacity-70 hover:opacity-100 transition-opacity"
              onClick={handleRefresh}
              title={t('sessionMgr.refresh') || 'Refresh'}
              type="button"
            >
              <Icon name="refresh" size={14} />
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2">
          {loadingProjects ? (
            <div className="px-3 py-2 text-sm text-nexus-muted">{t('common.loading')}</div>
          ) : projects.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-lg px-3 py-6 text-nexus-muted">
              <div className="text-[28px] mb-2 opacity-50">📁</div>
              <div className="text-sm">{t('sessionMgr.noProjects')}</div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {projects.map(project => {
                const isCurrent = project.name === currentProject
                const isExpanded = isCurrent && expandedProjectName === project.name
                const canShowCodex = codexHistoryEnabled && isCurrent
                const tabsClass = 'flex w-full items-stretch border-b border-nexus-border/70'
                return (
                  <div key={project.name}>
                    <div
                      data-menu-row
                      className={`group/item flex items-start gap-2 rounded-xl px-2.5 py-2.5 cursor-pointer select-none transition-colors ${isCurrent ? 'bg-nexus-accent/10' : 'hover:bg-nexus-bg-2/60'}`}
                      onPointerDown={() => { void handleTreeProjectToggle(project) }}
                      onContextMenu={(e) => { e.preventDefault(); handleSidebarContext(e, undefined, project) }}
                    >
                      <span className="mt-0.5 shrink-0 text-nexus-text-2">
                        <Icon name={isExpanded ? 'arrowDown' : 'arrowRight'} size={14} />
                      </span>
                      <span className={`w-2 h-2 rounded-full shrink-0 mt-1 ${isCurrent ? 'bg-nexus-accent' : 'bg-nexus-muted'}`} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-nexus-text truncate leading-tight" title={project.name}>{project.name}</div>
                        {project.path && (
                          <div className="text-[11px] text-nexus-text-2 font-mono truncate mt-0.5" title={project.path}>
                            {formatPath(project.path)}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <span className="text-xs text-nexus-text-2 font-mono shrink-0">{project.channelCount}</span>
                        {isCurrent && (
                          <button
                            className={treeRowActionButtonClass}
                            onPointerDown={(e) => {
                              e.stopPropagation()
                              onNewChannel()
                            }}
                            type="button"
                            title={t('sessionMgr.newChannel')}
                            aria-label={t('sessionMgr.newChannel')}
                          >
                            <Icon name="edit" size={15} />
                          </button>
                        )}
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="ml-5 mt-1.5 border-l border-nexus-border/70 pl-3 pb-1">
                        <div className={tabsClass}>
                          <button
                            className={sidebarTabClass(activeSidebarDetailView === 'channels')}
                            onClick={() => onSidebarDetailViewChange?.('channels')}
                            type="button"
                          >
                            {t('sessionMgr.channels')}
                          </button>
                          {codexHistoryEnabled && (
                            <button
                              className={`${sidebarTabClass(activeSidebarDetailView === 'codex')} ${canShowCodex ? '' : 'cursor-not-allowed opacity-50 hover:text-nexus-text-2'}`}
                              onClick={() => {
                                if (!canShowCodex) return
                                onSidebarDetailViewChange?.('codex')
                              }}
                              type="button"
                              disabled={!canShowCodex}
                              title={t('codexSessions.title')}
                              aria-label={t('codexSessions.title')}
                            >
                              {t('codexSessions.shortTitle')}
                            </button>
                          )}
                        </div>

                        {activeSidebarDetailView === 'channels' ? (
                          renderSidebarChannels()
                        ) : (
                          <div className="mt-2">
                            <CodexSessionsPanel
                              token={token}
                              projectName={currentProject}
                              layout="sidebar"
                              variant="compact"
                              onResumeSuccess={onCodexResumeSuccess}
                              onDeleteSuccess={onCodexDeleteSuccess}
                              onStartNewCodex={onStartNewCodex}
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="border-t border-nexus-border px-3 py-2 shrink-0">
          <button
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-nexus-border px-2.5 py-2 text-sm text-nexus-text-2 cursor-pointer hover:bg-nexus-bg-2 transition-colors"
            onPointerDown={onNewProject}
            type="button"
          >
            <Icon name="plus" size={14} />
            <span>{t('sessionMgr.newProject')}</span>
          </button>
        </div>

        {/* Sidebar right-click menu - channel */}
        {sidebarChannelMenu && (
          <>
            <div className="fixed inset-0 z-[150]" onPointerDown={() => setSidebarChannelMenu(null)} />
            <div
              className="fixed bg-nexus-bg border border-nexus-border rounded-lg py-1 min-w-[120px] shadow-[0_4px_20px_rgba(0,0,0,0.3)] z-[151]"
              style={{ left: sidebarChannelMenu.x, top: sidebarChannelMenu.y }}
            >
              <button className="flex items-center gap-2 px-4 py-2.5 bg-transparent border-none text-nexus-text text-sm cursor-pointer w-full text-left" onPointerDown={() => handleRenameChannel(sidebarChannelMenu.channel)}>
                <Icon name="pencil" size={14} />
                <span>{t('common.rename')}</span>
              </button>
              <div className="h-px bg-nexus-border my-1" />
              <button className="flex items-center gap-2 px-4 py-2.5 bg-transparent border-none text-nexus-error text-sm cursor-pointer w-full text-left" onPointerDown={() => handleCloseChannel(sidebarChannelMenu.channel)}>
                <Icon name="x" size={14} />
                <span>{t('common.close')}</span>
              </button>
            </div>
          </>
        )}

        {/* Sidebar right-click menu - project */}
        {sidebarProjectMenu && (
          <>
            <div className="fixed inset-0 z-[150]" onPointerDown={() => setSidebarProjectMenu(null)} />
            <div
              className="fixed bg-nexus-bg border border-nexus-border rounded-lg py-1 min-w-[120px] shadow-[0_4px_20px_rgba(0,0,0,0.3)] z-[151]"
              style={{ left: sidebarProjectMenu.x, top: sidebarProjectMenu.y }}
            >
              <div className="px-4 py-1.5 text-xs font-semibold text-nexus-text-2 border-b border-nexus-border mb-0">
                {sidebarProjectMenu.project.name}
              </div>
              <button className="flex items-center gap-2 px-4 py-2.5 bg-transparent border-none text-nexus-text text-sm cursor-pointer w-full text-left" onPointerDown={() => handleRenameProject(sidebarProjectMenu.project)}>
                <Icon name="pencil" size={14} />
                <span>{t('common.rename')}</span>
              </button>
              <div className="h-px bg-nexus-border my-1" />
              <button className="flex items-center gap-2 px-4 py-2.5 bg-transparent border-none text-nexus-error text-sm cursor-pointer w-full text-left" onPointerDown={() => handleCloseProject(sidebarProjectMenu.project)}>
                <Icon name="x" size={14} />
                <span>{t('sessionMgr.closeProject')}</span>
              </button>
            </div>
          </>
        )}
      </div>
    )
  }

  // ====== Modal mode ======
  return (
    <div className={isDesktop ? 'fixed inset-0 bg-black/70 z-[100] flex items-center justify-center p-5' : 'fixed inset-0 bg-black/60 z-[100]'}>
      <GhostShield />
      <div className={isDesktop
        ? 'bg-nexus-bg border border-nexus-border rounded-xl flex flex-col text-nexus-text w-full max-w-[400px] max-h-[85vh] shadow-[0_20px_60px_rgba(0,0,0,0.5)] overflow-hidden'
        : 'fixed inset-0 bg-nexus-bg flex flex-col text-nexus-text'
      }>
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-nexus-border shrink-0">
          <span className="text-base font-semibold">{t('sessionMgr.title')}</span>
          <div className="flex items-center gap-2">
            <button className="bg-transparent border-none text-nexus-text-2 cursor-pointer p-1 flex items-center justify-center" onPointerDown={handleRefresh} title={t('sessionMgr.refresh') || '刷新'}>
              <Icon name="refresh" size={16} />
            </button>
            <button className="bg-transparent border-none text-nexus-text-2 cursor-pointer text-2xl leading-none px-1 flex items-center justify-center" onPointerDown={onClose}>
              <Icon name="x" size={20} />
            </button>
          </div>
        </div>

        {isDesktop ? content : renderMobileTreeContent()}

        {/* Modal mode: project menu overlay */}
        {projectMenu && (
          <>
            <div className="fixed inset-0 z-[150]" onPointerDown={() => setProjectMenu(null)} />
            <div
              className="fixed bg-nexus-bg border border-nexus-border rounded-lg py-1 min-w-[120px] shadow-[0_4px_20px_rgba(0,0,0,0.3)] z-[151]"
              style={{ left: projectMenu.x, top: projectMenu.y }}
            >
              <div className="px-4 py-1.5 text-xs font-semibold text-nexus-text-2 border-b border-nexus-border mb-0">{projectMenu.project.name}</div>
              <button className="flex items-center gap-2 px-4 py-2.5 bg-transparent border-none text-nexus-text text-sm cursor-pointer w-full text-left" onPointerDown={() => handleRenameProject(projectMenu.project)}>
                <Icon name="pencil" size={14} />
                <span>{t('common.rename')}</span>
              </button>
              <div className="h-px bg-nexus-border my-1" />
              <button className="flex items-center gap-2 px-4 py-2.5 bg-transparent border-none text-nexus-error text-sm cursor-pointer w-full text-left" onPointerDown={() => handleCloseProject(projectMenu.project)}>
                <Icon name="x" size={14} />
                <span>{t('sessionMgr.closeProject')}</span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
})
