import { useEffect, useRef, useCallback, useMemo, useState, lazy, startTransition, type DragEvent as ReactDragEvent } from 'react'
import type { Terminal as XTerm } from '@xterm/xterm'
import type { SessionManagerSidebarDetailView, SessionManagerV2Handle } from './SessionManagerV2'
import { useTranslation } from 'react-i18next'
import Toolbar from './Toolbar'
import SessionFAB from './SessionFAB'
import DraggableFab from './DraggableFab'
import { Icon } from './icons'
import { getWindowStatus } from './windowStatus'
import { CODEX_SHELL_TYPE, type ShellType } from './shellType'
import { DesktopSidebar } from './terminal/DesktopSidebar'
import { MobileSessionDrawer } from './terminal/MobileSessionDrawer'
import { TerminalModalStack, preloadCodexSessionsPanel, preloadSessionManagerV2 } from './terminal/TerminalModalStack'
import { ProfileGuideOverlay } from './terminal/ProfileGuideOverlay'
import { ScrollbackOverlay } from './terminal/ScrollbackOverlay'
import { TerminalViewport } from './terminal/TerminalViewport'
import { SplitWorkspaceView } from './terminal/SplitWorkspaceView'
import { applyNexusCssVars, getInitialTheme, THEME_KEY, THEMES, type ThemeMode } from './terminal/theme'
import { UploadConflictDialog } from './terminal/UploadConflictDialog'
import { UploadNotifications } from './terminal/UploadNotifications'
import { useTerminalArtifacts } from './terminal/useTerminalArtifacts'
import { useTerminalRuntime } from './terminal/useTerminalRuntime'
import { useTerminalSessions } from './terminal/useTerminalSessions'
import { useProfileGuide } from './terminal/useProfileGuide'
import { WelcomeGuideOverlay } from './terminal/WelcomeGuideOverlay'
import {
  CHANNEL_DRAG_MIME,
  channelTargetKey,
  type PaneState,
  type PaneTarget,
  type SidebarChannelDragPayload,
} from './terminal/splitLayoutTypes'
import type { FocusedPaneRuntime } from './terminal/TerminalPane'

const SessionManagerV2 = lazy(preloadSessionManagerV2)

interface Props {
  token: string
}

const DESKTOP_SIDEBAR_WIDTH = 350

applyNexusCssVars(getInitialTheme())

// Agent 状态推断（F-15）
export default function Terminal({ token }: Props) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const focusedPaneRuntimeRef = useRef<FocusedPaneRuntime | null>(null)
  const focusedPaneTargetRef = useRef<PaneTarget | null>(null)
  const [activeWindowIndex, setActiveWindowIndex] = useState(() => parseInt(localStorage.getItem('nexus_window') || '0', 10))
  const [showSettings, setShowSettings] = useState(false)
  const [showGeneralSettings, setShowGeneralSettings] = useState(false)
  const [showSessionManagerV2, setShowSessionManagerV2] = useState(false)
  const [showCodexSessions, setShowCodexSessions] = useState(false)
  const codexHistoryTriggerRef = useRef<HTMLElement | null>(null)
  const [showNewSession, setShowNewSession] = useState(false)
  const [showNewWindow, setShowNewWindow] = useState(false)
  const [showSessionDrawer, setShowSessionDrawer] = useState(false)
  const [sidebarDetailView, setSidebarDetailView] = useState<SessionManagerSidebarDetailView>('channels')
  const [themeMode, setThemeMode] = useState<ThemeMode>(getInitialTheme)

  const [isWidePC, setIsWidePC] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 768)
  const [showFiles, setShowFiles] = useState(false)
  const [showWorkspace, setShowWorkspace] = useState(false)
  const [splitViewPanes, setSplitViewPanes] = useState<PaneState[]>([])
  const [splitViewFocusedPaneId, setSplitViewFocusedPaneId] = useState<string | null>(null)
  const [splitViewFocusRequest, setSplitViewFocusRequest] = useState<{ requestId: number; target: PaneTarget } | null>(null)
  const [splitViewClearRequest, setSplitViewClearRequest] = useState<{ requestId: number; target: PaneTarget } | null>(null)
  const pausePollingRef = useRef(false)
  const activeWindowIndexRef = useRef(0)
  activeWindowIndexRef.current = activeWindowIndex
  const scrollPositionsRef = useRef<Record<number, number>>({})
  const attachWindowFnRef = useRef<(index: number) => void>(() => {})
  const [showGuide, setShowGuide] = useState(() => localStorage.getItem('nexus_guide_seen') !== 'true')
  const toolbarWrapRef = useRef<HTMLDivElement>(null)
  const toolbarHeightRef = useRef(0)
  // Toolbar 展开状态（移动端点击空白区域时收起）
  // 初始值与 Toolbar 内部逻辑保持一致，确保首次加载时 ref 能正确反映展开状态
  const [toolbarCollapsed, setToolbarCollapsed] = useState<boolean | undefined>(() => {
    const saved = localStorage.getItem('nexus_toolbar_collapsed')
    if (saved !== null) return saved === 'true'
    return window.innerWidth >= 1024 // PC 默认收起，移动端默认展开
  })
  const toolbarCollapsedRef = useRef<boolean | undefined>(undefined)
  useEffect(() => { toolbarCollapsedRef.current = toolbarCollapsed }, [toolbarCollapsed])
  const sessionManagerRef = useRef<SessionManagerV2Handle>(null)
  const { dismissProfileGuide, markProfilesDetected, showProfileGuide } = useProfileGuide({ token })

  const {
    activeTmuxSession,
    activeTmuxSessionRef,
    attachToWindow,
    closeWindow,
    codexHistoryEnabled,
    createSession,
    createWindow,
    fetchWindows,
    handleSwitchSession,
    projects,
    renameWindow,
    tmuxSessions,
    windowOutputs,
    windows,
    windowsLoaded,
    wsSessionKey,
    windowsRef,
  } = useTerminalSessions({
    activeWindowIndex,
    activeWindowIndexRef,
    pausePollingRef,
    scrollPositionsRef,
    setActiveWindowIndex,
    termRef,
    token,
  })

  useEffect(() => {
    if (codexHistoryEnabled) return
    setShowCodexSessions(false)
    setSidebarDetailView((current) => current === 'codex' ? 'channels' : current)
  }, [codexHistoryEnabled])

  attachWindowFnRef.current = (index: number) => { attachToWindow(index) }

  const {
    closeScrollback,
    copiedId,
    fetchScrollback,
    fileInputRef,
    handleCopyNotification,
    handleFileInputChange,
    handleFileUpload,
    handleOverlayScroll,
    handleOverwriteCancel,
    handleOverwriteConfirm,
    removeUploadNotification,
    scrollbackBackground,
    scrollbackContent,
    scrollbackFontFamily,
    scrollbackFontSize,
    scrollbackForeground,
    scrollbackLoading,
    scrollbackMuted,
    scrollbackOverlayRef,
    showScrollback,
    showScrollbackRef,
    triggerScrollbackRef,
    uploadConflict,
    uploadFile,
    uploadFileRef,
    uploadNotifications,
  } = useTerminalArtifacts({
    activeTmuxSessionRef,
    activeWindowIndexRef,
    termRef,
    token,
  })

  const runtimeOverlayOpen = showSessionDrawer || showSettings || showGeneralSettings || showNewSession || showNewWindow || showScrollback || showSessionManagerV2 || showCodexSessions || showFiles
  const {
    containerRef,
    fitTerminal,
    handleCompositionEnd,
    handleCompositionStart,
    handleInputChange,
    handleKeyDown,
    isConnecting,
    isScrolledUp,
    scrollToBottom,
    sendToWs,
    vvHeight,
  } = useTerminalRuntime({
    activeTmuxSession,
    activeTmuxSessionRef,
    activeWindowIndex,
    activeWindowIndexRef,
    attachWindowFnRef,
    enabled: !isWidePC,
    inputRef,
    isWidePC,
    overlayOpen: runtimeOverlayOpen,
    scrollPositionsRef,
    setToolbarCollapsed,
    showScrollbackRef,
    termRef,
    token,
    toolbarCollapsedRef,
    triggerScrollbackRef,
    uploadFileRef,
    windowsLoaded,
    windowsRef,
    wsSessionKey,
  })

  useEffect(() => {
    const check = () => setIsWidePC(window.innerWidth >= 768)
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  // 请求通知权限（首次使用时，静默请求）
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch((error: unknown) => {
        console.error('[Terminal] Failed to request notification permission', error)
      })
    }
  }, [])

  // 跟随系统深色/浅色模式切换（用户未手动设置时）
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!mq) return
    const handler = (e: MediaQueryListEvent) => {
      if (localStorage.getItem(THEME_KEY)) return // user has manual override
      setThemeMode(e.matches ? 'dark' : 'light')
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // CSS vars 统一调用模块级函数，保证一致性
  const applyCssVars = useCallback((mode: ThemeMode) => {
    applyNexusCssVars(mode)
  }, [])

  const applyTheme = useCallback((mode: ThemeMode) => {
    applyCssVars(mode)
    localStorage.setItem(THEME_KEY, mode)
    const term = termRef.current
    if (term) term.options.theme = THEMES[mode]
  }, [applyCssVars])

  const toggleTheme = useCallback(() => {
    const newMode = themeMode === 'dark' ? 'light' : 'dark'
    setThemeMode(newMode)
    applyTheme(newMode)
  }, [themeMode, applyTheme])

  useEffect(() => {
    applyTheme(themeMode)
  }, [themeMode, applyTheme])

  // 动态页面标题：反映当前窗口和 Agent 状态
  useEffect(() => {
    const win = windows.find(w => w.index === activeWindowIndex)
    const taskBadge = ''
    if (!win) { document.title = `${taskBadge}Nexus`; return }
    const status = getWindowStatus(windowOutputs[activeWindowIndex])
    const statusSymbol = status === 'running' ? '⚡' : status === 'waiting' ? '⏳' : status === 'shell' ? '💤' : ''
    document.title = `${taskBadge}${statusSymbol ? statusSymbol + ' ' : ''}${win.name} — Nexus`
    return () => { document.title = 'Nexus' }
  }, [windows, activeWindowIndex, windowOutputs])

  async function handleCodexSessionDelete(closedWindowIndexes: number[]) {
    if (closedWindowIndexes.length === 0) return
    await fetchWindows()
    sessionManagerRef.current?.refresh()
  }

  function openCodexHistory(trigger?: HTMLElement | null) {
    if (!codexHistoryEnabled) return
    codexHistoryTriggerRef.current = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    if (isWidePC) {
      preloadSessionManagerV2()
      localStorage.setItem('nexus_sidebar_collapsed', 'false')
      startTransition(() => {
        setSidebarCollapsed(false)
        setSidebarDetailView('codex')
      })
      return
    }

    preloadCodexSessionsPanel()
    startTransition(() => {
      setShowCodexSessions(true)
    })
  }

  function startNewCodexWindow() {
    createWindow(CODEX_SHELL_TYPE)
  }

  function openNewSessionDialog() {
    setShowNewSession(true)
  }

  function handleCreateSession(path: string, shellType: ShellType, profile?: string) {
    setShowNewSession(false)
    createSession(path, shellType, profile)
  }

  // F-19: 处理新窗口创建（打开配置对话框）
  function handleCreateWindow() {
    setShowNewWindow(true)
  }

  function handleNewWindowConfirm(shellType: ShellType, profile?: string) {
    setShowNewWindow(false)
    void createWindow(shellType, profile)
    setTimeout(() => sessionManagerRef.current?.refresh(), 500)
  }

  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    const saved = localStorage.getItem('nexus_sidebar_collapsed')
    return saved !== null ? saved === 'true' : true // default collapsed
  })
  // Sidebar toggled only by the explicit chevron buttons
  useEffect(() => {
    const el = toolbarWrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      toolbarHeightRef.current = el.offsetHeight
    })
    ro.observe(el)
    toolbarHeightRef.current = el.offsetHeight
    return () => ro.disconnect()
  }, [])

  const toolbarProps = {
    token,
    sendToWs: (data: string) => {
      if (isWidePC) {
        focusedPaneRuntimeRef.current?.sendToWs(data)
        return
      }
      sendToWs(data)
    },
    scrollToBottom: () => {
      if (isWidePC) {
        focusedPaneRuntimeRef.current?.scrollToBottom()
        return
      }
      scrollToBottom()
    },
    onFitTerminal: () => {
      if (isWidePC) {
        focusedPaneRuntimeRef.current?.fitTerminal()
        return
      }
      fitTerminal()
    },
    termRef,
    themeMode,
    onToggleTheme: toggleTheme,
    onOpenSettings: () => setShowGeneralSettings(true),
    onOpenFiles: () => setShowFiles(true),
    onOpenWorkspace: () => setShowWorkspace(true),
    onUpload: handleFileUpload,
    onUploadFile: uploadFile,
    collapsed: toolbarCollapsed,
    onCollapsedChange: setToolbarCollapsed,
  }

  const activeProjectPath = (projects ?? []).find((project) => project.name === activeTmuxSession)?.path

  function handleCodexResumeSuccess(index: number) {
    attachToWindow(index)
    sessionManagerRef.current?.refresh()
  }

  function handleSidebarStartNewCodex() {
    startNewCodexWindow()
    sessionManagerRef.current?.refresh()
  }

  function handleModalStartNewCodex() {
    startNewCodexWindow()
    setShowCodexSessions(false)
    sessionManagerRef.current?.refresh()
  }

  function handleSessionManagerModalNewProject() {
    setShowSessionManagerV2(false)
    openNewSessionDialog()
  }

  function handleSessionManagerModalNewChannel() {
    setShowSessionManagerV2(false)
    handleCreateWindow()
  }

  function handleOpenApiConfig() {
    setShowGeneralSettings(false)
    setShowSettings(true)
  }

  const handleFocusedPaneRuntimeChange = useCallback((runtime: FocusedPaneRuntime | null) => {
    focusedPaneRuntimeRef.current = runtime
    termRef.current = runtime?.termRef.current ?? null
  }, [])

  const handleFocusedPaneTargetChange = useCallback((target: PaneTarget | null) => {
    focusedPaneTargetRef.current = target
  }, [])

  const handleSidebarChannelDragStart = useCallback((event: ReactDragEvent<HTMLElement>, channel: { index: number; name: string }, projectName: string) => {
    if (!projectName) return
    const payload: SidebarChannelDragPayload = {
      type: 'nexus-channel',
      session: projectName,
      windowIndex: channel.index,
      name: channel.name,
    }
    const raw = JSON.stringify(payload)
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData(CHANNEL_DRAG_MIME, raw)
    event.dataTransfer.setData('text/plain', raw)
  }, [])

  const handleSplitViewPanesChange = useCallback((panes: PaneState[], focusedPaneId: string) => {
    setSplitViewPanes(panes)
    setSplitViewFocusedPaneId(focusedPaneId)
  }, [])

  const splitPaneAssignmentsByChannelKey = useMemo(() => {
    const assignments: Record<string, string[]> = {}
    for (const pane of splitViewPanes) {
      if (!pane.target) continue
      const key = channelTargetKey(pane.target.session, pane.target.windowIndex)
      if (!assignments[key]) {
        assignments[key] = []
      }
      assignments[key].push(pane.id)
    }
    return assignments
  }, [splitViewPanes])

  const handleSidebarChannelClick = useCallback((channel: { index: number }, projectName: string) => {
    const key = channelTargetKey(projectName, channel.index)
    if (!splitPaneAssignmentsByChannelKey[key]?.length) return
    setSplitViewFocusRequest((current) => ({
      requestId: (current?.requestId ?? 0) + 1,
      target: {
        session: projectName,
        windowIndex: channel.index,
      },
    }))
  }, [splitPaneAssignmentsByChannelKey])

  const handleSidebarChannelClosed = useCallback((channel: { index: number }, projectName: string) => {
    setSplitViewClearRequest((current) => ({
      requestId: (current?.requestId ?? 0) + 1,
      target: {
        session: projectName,
        windowIndex: channel.index,
      },
    }))
  }, [])

  return (
    <div className="flex flex-col w-full relative" style={{ height: vvHeight ?? '100dvh' }}>
      <ProfileGuideOverlay
        visible={showProfileGuide}
        token={token}
        onDetected={markProfilesDetected}
        onDismiss={dismissProfileGuide}
      />

      <input
        ref={inputRef}
        className="nexus-input-proxy fixed top-0 left-0 w-px h-px opacity-[0.01] text-base pointer-events-none -z-10"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        aria-hidden="true"
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*"
        className="fixed top-0 left-0 w-px h-px opacity-[0.01] text-base pointer-events-none -z-10"
        onChange={handleFileInputChange}
        aria-hidden="true"
      />
      {isWidePC ? (
        <div className="flex flex-col flex-1 overflow-hidden min-h-0">
          <div className="flex flex-1 overflow-hidden min-h-0">
            <DesktopSidebar
              activeWindowIndex={activeWindowIndex}
              codexHistoryEnabled={codexHistoryEnabled}
              expandedContent={(
                <SessionManagerV2
                  ref={sessionManagerRef}
                  token={token}
                  currentProject={activeTmuxSession}
                  currentChannelIndex={activeWindowIndex}
                  onClose={() => {}}
                  onSwitchProject={(name) => handleSwitchSession(name)}
                  onSwitchChannel={(idx) => attachToWindow(idx)}
                  onNewProject={openNewSessionDialog}
                  onNewChannel={handleCreateWindow}
                  layout="sidebar"
                  codexHistoryEnabled={codexHistoryEnabled}
                  sidebarDetailView={sidebarDetailView}
                  onSidebarDetailViewChange={setSidebarDetailView}
                  onCodexResumeSuccess={handleCodexResumeSuccess}
                  onCodexDeleteSuccess={handleCodexSessionDelete}
                  onStartNewCodex={handleSidebarStartNewCodex}
                  activeSplitPaneId={splitViewFocusedPaneId}
                  onChannelDragStart={handleSidebarChannelDragStart}
                  onChannelClosed={handleSidebarChannelClosed}
                  onSidebarChannelClick={handleSidebarChannelClick}
                  paneAssignmentsByChannelKey={splitPaneAssignmentsByChannelKey}
                />
              )}
              onAttachWindow={attachToWindow}
              onCollapse={() => {
                setSidebarCollapsed(true)
                localStorage.setItem('nexus_sidebar_collapsed', 'true')
              }}
              onExpand={() => {
                setSidebarCollapsed(false)
                localStorage.setItem('nexus_sidebar_collapsed', 'false')
              }}
              onOpenCodexHistory={openCodexHistory}
              onOpenFiles={() => setShowFiles(true)}
              onOpenNewSession={openNewSessionDialog}
              onOpenNewWindow={handleCreateWindow}
              onOpenSettings={() => setShowSessionManagerV2(true)}
              onOpenUpload={handleFileUpload}
              onOpenWorkspace={() => setShowWorkspace(true)}
              onToggleTheme={toggleTheme}
              sidebarCollapsed={sidebarCollapsed}
              themeMode={themeMode}
              toolbar={<Toolbar {...toolbarProps} embedded />}
              width={DESKTOP_SIDEBAR_WIDTH}
              windows={windows}
              windowOutputs={windowOutputs}
            />
            <div className="flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden relative">
              <SplitWorkspaceView
                activePaneTermRef={termRef}
                activeTargetRef={focusedPaneTargetRef}
                clearRequest={splitViewClearRequest}
                focusRequest={splitViewFocusRequest}
                onFocusedPaneTargetChange={handleFocusedPaneTargetChange}
                onFocusedRuntimeChange={handleFocusedPaneRuntimeChange}
                onVisiblePanesChange={handleSplitViewPanesChange}
                themeMode={themeMode}
                token={token}
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col flex-1 overflow-hidden min-h-0">
          <TerminalViewport
            containerRef={containerRef}
            isConnecting={isConnecting}
            isScrolledUp={isScrolledUp}
            onFetchScrollback={fetchScrollback}
            onScrollToBottom={scrollToBottom}
            selectTextLabel={t('terminal.selectText')}
          />
          {!!activeTmuxSession && codexHistoryEnabled && (
            <DraggableFab
              onClick={openCodexHistory}
              storageKey="nexus_codex_history_fab_pos"
              title={t('codexSessions.title')}
              size={48}
              bottomInset={toolbarHeightRef.current}
              defaultSide="left"
              zIndex={349}
              style={{
                background: 'var(--nexus-bg2)',
                color: 'var(--nexus-text)',
                border: '1px solid var(--nexus-border)',
                boxShadow: '0 2px 12px rgba(0,0,0,0.18)',
                backdropFilter: 'blur(6px)',
              }}
              ariaLabel={t('codexSessions.title')}
            >
              <Icon name="history" size={20} />
            </DraggableFab>
          )}
          <SessionFAB onClick={() => setShowSessionManagerV2(v => !v)} windowCount={windows.length} bottomInset={toolbarHeightRef.current} />
          <div ref={toolbarWrapRef}><Toolbar {...toolbarProps} /></div>
        </div>
      )}

      {showSessionDrawer && !isWidePC && (
        <MobileSessionDrawer
          activeTmuxSession={activeTmuxSession}
          activeWindowIndex={activeWindowIndex}
          onClose={() => setShowSessionDrawer(false)}
          onCloseWindow={closeWindow}
          onNewChannel={handleCreateWindow}
          onNewProject={openNewSessionDialog}
          onRenameWindow={renameWindow}
          onSwitchSession={handleSwitchSession}
          onSwitchWindow={attachToWindow}
          tmuxSessions={tmuxSessions}
          windowOutputs={windowOutputs}
          windows={windows}
        />
      )}
      <TerminalModalStack
        activeTmuxSession={activeTmuxSession}
        activeWindowIndex={activeWindowIndex}
        activeWindowProjectPath={activeProjectPath}
        codexHistoryEnabled={codexHistoryEnabled}
        codexHistoryFocusReturnTarget={codexHistoryTriggerRef.current}
        onAttachWindow={attachToWindow}
        onCloseCodexSessions={() => setShowCodexSessions(false)}
        onCloseFiles={() => setShowFiles(false)}
        onCloseGeneralSettings={() => setShowGeneralSettings(false)}
        onCloseNewSession={() => setShowNewSession(false)}
        onCloseNewWindow={() => setShowNewWindow(false)}
        onCloseSessionManager={() => setShowSettings(false)}
        onCloseSessionManagerV2={() => setShowSessionManagerV2(false)}
        onCloseWorkspace={() => setShowWorkspace(false)}
        onCodexDeleteSuccess={handleCodexSessionDelete}
        onCodexResumeSuccess={handleCodexResumeSuccess}
        onCreateSession={handleCreateSession}
        onNewWindowConfirm={handleNewWindowConfirm}
        onOpenApiConfig={handleOpenApiConfig}
        onSessionManagerNewChannel={handleSessionManagerModalNewChannel}
        onSessionManagerNewProject={handleSessionManagerModalNewProject}
        onStartNewCodexFromModal={handleModalStartNewCodex}
        onSwitchSession={handleSwitchSession}
        sessionManagerRef={sessionManagerRef}
        showCodexSessions={showCodexSessions}
        showFiles={showFiles}
        showGeneralSettings={showGeneralSettings}
        showNewSession={showNewSession}
        showNewWindow={showNewWindow}
        showSessionManager={showSettings}
        showSessionManagerV2={showSessionManagerV2}
        showWorkspace={showWorkspace}
        themeMode={themeMode}
        token={token}
        toggleTheme={toggleTheme}
      />

      <WelcomeGuideOverlay
        visible={showGuide}
        onClose={() => {
          setShowGuide(false)
          localStorage.setItem('nexus_guide_seen', 'true')
        }}
      />

      {/* 空状态提示：只在数据加载完成后才显示 */}
      {!isWidePC && windows.length === 0 && windowsLoaded && !isConnecting && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-center text-nexus-muted">
          <div className="text-5xl mb-3">🖥️</div>
          <div className="text-base mb-2">没有活动会话</div>
          <div className="text-sm">点击「+ 新建」开始</div>
        </div>
      )}

      <UploadConflictDialog
        visible={uploadConflict.show}
        filename={uploadConflict.filename}
        onCancel={handleOverwriteCancel}
        onConfirm={handleOverwriteConfirm}
      />
      <ScrollbackOverlay
        visible={showScrollback}
        background={scrollbackBackground}
        content={scrollbackContent}
        fontFamily={scrollbackFontFamily}
        fontSize={scrollbackFontSize}
        foreground={scrollbackForeground}
        hint={t('terminal.scrollbackHint')}
        loading={scrollbackLoading}
        loadingLabel="加载中..."
        muted={scrollbackMuted}
        onClose={closeScrollback}
        onScroll={handleOverlayScroll}
        overlayRef={scrollbackOverlayRef}
        title={t('terminal.scrollbackTitle')}
      />
      <UploadNotifications
        notifications={uploadNotifications}
        copiedId={copiedId}
        onCopy={handleCopyNotification}
        onRemove={removeUploadNotification}
        bottomOffset={isWidePC ? 16 : (toolbarHeightRef.current + 16)}
      />
    </div>
  )
}
