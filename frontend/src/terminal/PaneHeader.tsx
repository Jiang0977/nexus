import { Icon } from '../icons'
import type { PaneTarget } from './splitLayoutTypes'
import type { PaneConnectionState } from './useTerminalPaneRuntime'
import type { TerminalScrollMode } from './terminalApplicationScroll'
import { TerminalScrollModeSelect } from './TerminalScrollModeSelect'

type PaneHealth = PaneConnectionState | 'stale' | 'checking'

interface Props {
  index: number
  focused: boolean
  health: PaneHealth
  onClear: () => void
  onFit: () => void
  onOpenScrollback: () => void
  scrollMode: TerminalScrollMode
  onScrollModeChange: (mode: TerminalScrollMode) => void
  target: PaneTarget | null
  windowName?: string
}

const STATUS_META: Record<PaneHealth, { label: string; color: string }> = {
  empty: { label: '空', color: 'var(--nexus-muted)' },
  checking: { label: '检查中', color: 'var(--nexus-warning)' },
  loading: { label: '连接中', color: 'var(--nexus-warning)' },
  live: { label: '运行中', color: 'var(--nexus-success)' },
  error: { label: '错误', color: 'var(--nexus-error)' },
  stale: { label: '已失效', color: 'var(--nexus-error)' },
}

export function PaneHeader({ focused, health, index, onClear, onFit, onOpenScrollback, scrollMode, onScrollModeChange, target, windowName }: Props) {
  const meta = STATUS_META[health]
  const title = target
    ? `${target.session} / ${windowName || `#${target.windowIndex}`}`
    : '(空)'
  const canOpenScrollback = Boolean(target && health !== 'stale')

  return (
    <div className={`flex h-9 min-h-9 items-center gap-2 border-b px-3 text-sm ${focused ? 'border-nexus-accent/80' : 'border-nexus-border'}`}>
      <span className="w-4 shrink-0 text-right font-mono text-nexus-text">{index}</span>
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: meta.color }} />
      <div className="min-w-0 flex-1 truncate text-nexus-text" title={title}>
        {title}
      </div>
      <span className="shrink-0 text-xs font-semibold" style={{ color: meta.color }}>
        {meta.label}
      </span>
      {target && (
        <TerminalScrollModeSelect value={scrollMode} onChange={onScrollModeChange} />
      )}
      {target && (
        <button
          aria-label="选字复制"
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded border border-transparent bg-transparent ${
            canOpenScrollback
              ? 'text-nexus-text-2 hover:border-nexus-border hover:text-nexus-text'
              : 'cursor-not-allowed text-nexus-muted'
          }`}
          disabled={!canOpenScrollback}
          onClick={(event) => {
            event.stopPropagation()
            onOpenScrollback()
          }}
          title="选字复制"
          type="button"
        >
          <Icon name="copy" size={13} />
        </button>
      )}
      <button
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-transparent bg-transparent text-nexus-text-2 hover:border-nexus-border hover:text-nexus-text"
        onClick={onFit}
        title="适配大小"
        type="button"
      >
        <Icon name="refresh" size={13} />
      </button>
      <button
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-transparent bg-transparent text-nexus-text-2 hover:border-nexus-border hover:text-nexus-text"
        onClick={onClear}
        title="移除 pane target"
        type="button"
      >
        <Icon name="x" size={14} />
      </button>
    </div>
  )
}
