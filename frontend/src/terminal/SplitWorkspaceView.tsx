import { useCallback, useMemo, useRef, useState, type CSSProperties, type MutableRefObject } from 'react'
import type { Terminal as XTerm } from '@xterm/xterm'
import { Icon } from '../icons'
import { TerminalPane, type FocusedPaneRuntime, type PaneStatus } from './TerminalPane'
import { useWorkspaceLayout } from './useWorkspaceLayout'
import {
  LAYOUT_MODES,
  PANE_COUNT_BY_MODE,
  visiblePanesForLayout,
  type LayoutMode,
  type PaneTarget,
} from './splitLayoutTypes'
import type { ThemeMode } from './theme'

interface Props {
  activePaneTermRef: MutableRefObject<XTerm | null>
  activeTargetRef: MutableRefObject<PaneTarget | null>
  onFocusedPaneTargetChange: (target: PaneTarget | null) => void
  onFocusedRuntimeChange: (runtime: FocusedPaneRuntime | null) => void
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

function saveStateLabel(saveState: 'loading' | 'saving' | 'saved' | 'unsaved', hasError: boolean) {
  if (saveState === 'loading') return '布局加载中'
  if (saveState === 'saving') return '布局保存中'
  if (saveState === 'saved' && !hasError) return '布局已保存'
  return '布局未保存'
}

export function SplitWorkspaceView({
  activePaneTermRef,
  activeTargetRef,
  onFocusedPaneTargetChange,
  onFocusedRuntimeChange,
  themeMode,
  token,
}: Props) {
  const { error, focusPane, layout, saveState, setMode, setPaneTarget } = useWorkspaceLayout(token)
  const [paneStatuses, setPaneStatuses] = useState<Record<string, PaneStatus>>({})
  const focusedRuntimeRef = useRef<FocusedPaneRuntime | null>(null)
  const visiblePanes = visiblePanesForLayout(layout)
  const isCompact = layout.mode === 'grid-3x3'

  const handleFocusedPane = useCallback((paneId: string, runtime: FocusedPaneRuntime) => {
    focusedRuntimeRef.current = runtime
    activePaneTermRef.current = runtime.termRef.current
    activeTargetRef.current = runtime.target
    focusPane(paneId)
    onFocusedRuntimeChange(runtime)
    onFocusedPaneTargetChange(runtime.target)
  }, [activePaneTermRef, activeTargetRef, focusPane, onFocusedPaneTargetChange, onFocusedRuntimeChange])

  const handlePaneStatusChange = useCallback((paneId: string, status: PaneStatus) => {
    setPaneStatuses((current) => current[paneId] === status ? current : { ...current, [paneId]: status })
  }, [])

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
              onPaneStatusChange={handlePaneStatusChange}
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
    </div>
  )
}
