import type { ReactNode } from 'react'
import { useState } from 'react'
import { Icon } from '../icons'
import { hasChannelDragPayload, parseChannelDragPayload, type PaneTarget } from './splitLayoutTypes'

interface Props {
  children?: ReactNode
  empty?: boolean
  onDropTarget: (target: PaneTarget) => void
}

export function PaneDropTarget({ children, empty = false, onDropTarget }: Props) {
  const [dragActive, setDragActive] = useState(false)

  return (
    <div
      className="relative flex min-h-0 flex-1 overflow-hidden"
      onDragOver={(event) => {
        if (!hasChannelDragPayload(event.dataTransfer)) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'copy'
        setDragActive(true)
      }}
      onDragEnter={(event) => {
        if (!hasChannelDragPayload(event.dataTransfer)) return
        event.preventDefault()
        event.stopPropagation()
        setDragActive(true)
      }}
      onDragLeave={(event) => {
        event.preventDefault()
        event.stopPropagation()
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setDragActive(false)
      }}
      onDrop={(event) => {
        const payload = parseChannelDragPayload(event.dataTransfer)
        if (!payload) return
        event.preventDefault()
        event.stopPropagation()
        setDragActive(false)
        onDropTarget({ session: payload.session, windowIndex: payload.windowIndex })
      }}
    >
      {children}
      {(empty || dragActive) && (
        <div
          className={`absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 border border-dashed ${
            dragActive
              ? 'border-cyan-400 bg-cyan-950/40 text-cyan-200'
              : 'border-nexus-border/80 bg-nexus-bg2/20 text-nexus-text-2'
          }`}
        >
          <div className="flex h-12 w-12 items-center justify-center rounded border border-current/60">
            <Icon name="folderOpen" size={22} />
          </div>
          <div className="text-sm font-medium">{dragActive ? '释放到此 pane' : '拖入窗口'}</div>
          <div className="max-w-[220px] text-center text-xs text-nexus-muted">从左侧「窗口」拖入一个 channel</div>
        </div>
      )}
    </div>
  )
}
