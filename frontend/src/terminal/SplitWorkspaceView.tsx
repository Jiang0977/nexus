import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject, type UIEvent } from 'react'
import type { Terminal as XTerm } from '@xterm/xterm'
import { Icon } from '../icons'
import { ScrollbackOverlay } from './ScrollbackOverlay'
import { TerminalPane, type FocusedPaneRuntime, type PaneStatus } from './TerminalPane'
import { normalizeTerminalScrollbackText, TERMINAL_SCROLLBACK_COPY_LINES } from './terminalClipboard'
import { useWorkspaceLayout } from './useWorkspaceLayout'
import {
  LAYOUT_MODES,
  PANE_COUNT_BY_MODE,
  visiblePanesForLayout,
  type LayoutMode,
  type PaneState,
  type PaneTarget,
} from './splitLayoutTypes'
import { THEMES, type ThemeMode } from './theme'

interface Props {
  activePaneTermRef: MutableRefObject<XTerm | null>
  activeTargetRef: MutableRefObject<PaneTarget | null>
  clearRequest?: {
    requestId: number
    target: PaneTarget
  } | null
  focusRequest?: {
    requestId: number
    target: PaneTarget
  } | null
  onFocusedPaneTargetChange: (target: PaneTarget | null) => void
  onFocusedRuntimeChange: (runtime: FocusedPaneRuntime | null) => void
  onVisiblePanesChange?: (panes: PaneState[], focusedPaneId: string) => void
  themeMode: ThemeMode
  token: string
}

const MODE_LABEL: Record<LayoutMode, string> = {
  single: 'Single',
  vertical: 'V Split',
  horizontal: 'H Split',
  'grid-2x2': '2x2',
  'grid-3x3': '3x3',
}

const GRID_STYLE: Record<LayoutMode, CSSProperties> = {
  single: { gridTemplateColumns: 'minmax(0, 1fr)', gridTemplateRows: 'minmax(0, 1fr)' },
  vertical: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gridTemplateRows: 'minmax(0, 1fr)' },
  horizontal: { gridTemplateColumns: 'minmax(0, 1fr)', gridTemplateRows: 'repeat(2, minmax(0, 1fr))' },
  'grid-2x2': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gridTemplateRows: 'repeat(2, minmax(0, 1fr))' },
  'grid-3x3': { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gridTemplateRows: 'repeat(3, minmax(0, 1fr))' },
}

interface PaneScrollbackState {
  content: string
  loading: boolean
  title: string
  visible: boolean
}

function saveStateLabel(saveState: 'loading' | 'saving' | 'saved' | 'unsaved', hasError: boolean) {
  if (saveState === 'loading') return '布局加载中'
  if (saveState === 'saving') return '布局保存中'
  if (saveState === 'saved' && !hasError) return '布局已保存'
  return '布局未保存'
}

export function SplitWorkspaceView({
  activePaneTermRef,
  activeTargetRef,
  clearRequest = null,
  focusRequest = null,
  onFocusedPaneTargetChange,
  onFocusedRuntimeChange,
  onVisiblePanesChange,
  themeMode,
  token,
}: Props) {
  const { error, focusPane, layout, saveState, setMode, setPaneTarget } = useWorkspaceLayout(token)
  const [paneStatuses, setPaneStatuses] = useState<Record<string, PaneStatus>>({})
  const [paneScrollback, setPaneScrollback] = useState<PaneScrollbackState>({
    content: '',
    loading: false,
    title: '终端文本',
    visible: false,
  })
  const focusedRuntimeRef = useRef<FocusedPaneRuntime | null>(null)
  const focusedPaneIdRef = useRef(layout.focusedPaneId)
  const handledClearRequestIdRef = useRef(0)
  const handledFocusRequestIdRef = useRef(0)
  const paneScrollbackOverlayRef = useRef<HTMLDivElement>(null)
  const scrollbackRequestIdRef = useRef(0)
  focusedPaneIdRef.current = layout.focusedPaneId
  const visiblePanes = useMemo(() => visiblePanesForLayout(layout), [layout])
  const isCompact = layout.mode === 'grid-3x3'
  const scrollbackTheme = THEMES[themeMode] as Record<string, unknown>
  const scrollbackBackground = String(scrollbackTheme.background ?? '#1a1a2e')
  const scrollbackForeground = String(scrollbackTheme.foreground ?? '#e2e8f0')
  const scrollbackMuted = String(scrollbackTheme.brightBlack ?? '#4a5568')

  const publishFocusedRuntime = useCallback((runtime: FocusedPaneRuntime) => {
    focusedRuntimeRef.current = runtime
    activePaneTermRef.current = runtime.termRef.current
    activeTargetRef.current = runtime.target
    onFocusedRuntimeChange(runtime)
    onFocusedPaneTargetChange(runtime.target)
  }, [activePaneTermRef, activeTargetRef, onFocusedPaneTargetChange, onFocusedRuntimeChange])

  const handleFocusedPane = useCallback((paneId: string, runtime: FocusedPaneRuntime) => {
    publishFocusedRuntime(runtime)
    focusPane(paneId)
  }, [focusPane, publishFocusedRuntime])

  const handleFocusedRuntimeReady = useCallback((paneId: string, runtime: FocusedPaneRuntime) => {
    if (paneId !== focusedPaneIdRef.current) return
    publishFocusedRuntime(runtime)
  }, [publishFocusedRuntime])

  const handlePaneStatusChange = useCallback((paneId: string, status: PaneStatus) => {
    setPaneStatuses((current) => current[paneId] === status ? current : { ...current, [paneId]: status })
  }, [])

  const closePaneScrollback = useCallback(() => {
    scrollbackRequestIdRef.current += 1
    setPaneScrollback((current) => ({
      ...current,
      content: '',
      loading: false,
      visible: false,
    }))
  }, [])

  const handlePaneScrollbackScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30
    if (atBottom) closePaneScrollback()
  }, [closePaneScrollback])

  const openPaneScrollback = useCallback((target: PaneTarget, windowName?: string) => {
    const requestId = scrollbackRequestIdRef.current + 1
    scrollbackRequestIdRef.current = requestId
    const windowLabel = windowName || `#${target.windowIndex}`

    setPaneScrollback({
      content: '',
      loading: true,
      title: `${target.session} / ${windowLabel} 终端文本`,
      visible: true,
    })

    const focusedRuntime = focusedRuntimeRef.current
    const focusedTarget = focusedRuntime?.target
    const columns = focusedTarget?.session === target.session
      && focusedTarget.windowIndex === target.windowIndex
      ? focusedRuntime?.termRef.current?.cols
      : undefined

    fetch(`/api/sessions/${target.windowIndex}/scrollback?session=${encodeURIComponent(target.session)}&lines=${TERMINAL_SCROLLBACK_COPY_LINES}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((response) => response.ok ? response.json() : Promise.reject(response.status))
      .then(({ content }: { content: string }) => {
        if (scrollbackRequestIdRef.current !== requestId) return
        setPaneScrollback((current) => ({
          ...current,
          content: normalizeTerminalScrollbackText(content.trimEnd(), { columns }),
          loading: false,
        }))
      })
      .catch((error: unknown) => {
        if (scrollbackRequestIdRef.current !== requestId) return
        console.error('[SplitWorkspaceView] Failed to load pane scrollback', {
          error,
          target,
        })
        setPaneScrollback((current) => ({
          ...current,
          content: '(加载失败)',
          loading: false,
        }))
      })
  }, [token])

  useEffect(() => {
    if (!paneScrollback.content || !paneScrollbackOverlayRef.current) return
    const el = paneScrollbackOverlayRef.current
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 50)
  }, [paneScrollback.content])

  useEffect(() => {
    onVisiblePanesChange?.(visiblePanes, layout.focusedPaneId)
  }, [layout.focusedPaneId, onVisiblePanesChange, visiblePanes])

  useEffect(() => {
    if (!clearRequest) return
    if (clearRequest.requestId === handledClearRequestIdRef.current) return
    handledClearRequestIdRef.current = clearRequest.requestId

    const matchedPanes = visiblePanes.filter((pane) => (
      pane.target?.session === clearRequest.target.session
      && pane.target?.windowIndex === clearRequest.target.windowIndex
    ))
    if (matchedPanes.length === 0) return

    const panesToClear = [...matchedPanes].sort((left, right) => {
      if (left.id === layout.focusedPaneId) return 1
      if (right.id === layout.focusedPaneId) return -1
      return left.id.localeCompare(right.id)
    })

    for (const pane of panesToClear) {
      setPaneTarget(pane.id, null)
    }
  }, [clearRequest, layout.focusedPaneId, setPaneTarget, visiblePanes])

  useEffect(() => {
    if (!focusRequest) return
    if (focusRequest.requestId === handledFocusRequestIdRef.current) return
    const matchedPane = visiblePanes.find((pane) => (
      pane.target?.session === focusRequest.target.session
      && pane.target?.windowIndex === focusRequest.target.windowIndex
    ))
    if (!matchedPane) return
    handledFocusRequestIdRef.current = focusRequest.requestId
    focusPane(matchedPane.id)
  }, [focusPane, focusRequest, visiblePanes])

  const liveCount = useMemo(() => visiblePanes.filter((pane) => paneStatuses[pane.id] === 'live').length, [paneStatuses, visiblePanes])
  const wsCount = liveCount
  const occupiedCount = visiblePanes.filter((pane) => pane.target).length
  const statusLabel = saveStateLabel(saveState, Boolean(error))

  return (
    <div data-testid="split-workspace-view" className="flex min-h-0 flex-1 flex-col overflow-hidden bg-nexus-bg text-nexus-text">
      <div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-nexus-border px-4">
        <div className="min-w-0 flex-1 truncate text-base font-semibold">工作区视图</div>
        <div className="flex shrink-0 items-center gap-1 rounded border border-nexus-border bg-nexus-bg2/30 p-0.5">
          {LAYOUT_MODES.map((mode) => (
            <button
              key={mode}
              className={`h-8 rounded px-3 text-sm transition-colors ${
                layout.mode === mode
                  ? 'bg-nexus-accent text-white'
                  : 'bg-transparent text-nexus-text-2 hover:bg-nexus-bg2 hover:text-nexus-text'
              }`}
              onClick={() => setMode(mode)}
              type="button"
            >
              {MODE_LABEL[mode]}
            </button>
          ))}
        </div>
        <div className={`flex shrink-0 items-center gap-1.5 text-sm ${saveState === 'saved' && !error ? 'text-nexus-success' : 'text-nexus-warning'}`}>
          <Icon name={saveState === 'saved' && !error ? 'check' : 'alert'} size={16} />
          <span className="max-w-[120px] truncate">{statusLabel}</span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden p-2">
        <div
          data-testid="split-layout-grid"
          className="grid h-full min-h-0 gap-2"
          style={GRID_STYLE[layout.mode]}
        >
          {visiblePanes.map((pane, index) => (
            <TerminalPane
              key={pane.id}
              compact={isCompact}
              focused={pane.id === layout.focusedPaneId}
              index={index + 1}
              onClearTarget={(paneId) => setPaneTarget(paneId, null)}
              onFocusPane={handleFocusedPane}
              onFocusedRuntimeReady={handleFocusedRuntimeReady}
              onPaneStatusChange={handlePaneStatusChange}
              onOpenScrollback={openPaneScrollback}
              onSetTarget={setPaneTarget}
              layoutMode={layout.mode}
              pane={pane}
              themeMode={themeMode}
              token={token}
            />
          ))}
        </div>
      </div>

      <div className="flex h-9 shrink-0 items-center gap-5 border-t border-nexus-border px-4 text-xs text-nexus-text-2">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-nexus-success" />
          已连接 {liveCount}/{PANE_COUNT_BY_MODE[layout.mode]} panes
        </span>
        <span className="h-4 w-px bg-nexus-border" />
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-nexus-success" />
          WS {wsCount}
        </span>
        <span className="h-4 w-px bg-nexus-border" />
        <span>已占用 {occupiedCount}</span>
        <span className="h-4 w-px bg-nexus-border" />
        <span className={saveState === 'saved' && !error ? 'text-nexus-success' : 'text-nexus-warning'}>{statusLabel}</span>
        <span className="ml-auto">mode {layout.mode}</span>
      </div>
      <ScrollbackOverlay
        visible={paneScrollback.visible}
        background={scrollbackBackground}
        content={paneScrollback.content}
        fontFamily="Menlo, Monaco, monospace"
        fontSize={14}
        foreground={scrollbackForeground}
        hint="这里可直接选中文字，滚到底部返回终端"
        loading={paneScrollback.loading}
        loadingLabel="加载中..."
        muted={scrollbackMuted}
        onClose={closePaneScrollback}
        onScroll={handlePaneScrollbackScroll}
        overlayRef={paneScrollbackOverlayRef}
        title={paneScrollback.title}
      />
    </div>
  )
}
