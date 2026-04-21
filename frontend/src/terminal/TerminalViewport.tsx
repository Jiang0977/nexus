import type { RefObject } from 'react'
import { Icon } from '../icons'

interface Props {
  containerRef: RefObject<HTMLDivElement>
  isConnecting: boolean
  isScrolledUp: boolean
  onFocusTerminal?: () => void
  onFetchScrollback: () => void
  onScrollToBottom: () => void
  selectTextLabel: string
}

export function TerminalViewport({
  containerRef,
  isConnecting,
  isScrolledUp,
  onFocusTerminal,
  onFetchScrollback,
  onScrollToBottom,
  selectTextLabel,
}: Props) {
  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden relative">
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden relative"
        onClick={onFocusTerminal}
      />
      <button
        type="button"
        className="absolute top-3 right-3 z-40 inline-flex items-center gap-1.5 rounded-md border border-nexus-border bg-nexus-bg/80 px-2.5 py-1.5 text-xs font-medium text-nexus-text backdrop-blur-sm cursor-pointer active:scale-95 hover:bg-nexus-bg-2/90"
        onClick={(event) => {
          event.stopPropagation()
          onFetchScrollback()
        }}
        title={selectTextLabel}
        aria-label={selectTextLabel}
      >
        <Icon name="copy" size={14} />
        <span>{selectTextLabel}</span>
      </button>
      {isConnecting && (
        <div className="absolute inset-0 bg-nexus-bg flex flex-col items-center justify-center gap-3 z-10">
          <div className="w-8 h-8 border-[3px] border-nexus-border border-t-nexus-accent rounded-full animate-spin" />
          <span className="text-nexus-text-2 text-sm">Connecting...</span>
        </div>
      )}
      {isScrolledUp && (
        <button
          className="absolute bottom-3 right-3 w-9 h-9 rounded-full bg-nexus-accent border-none text-white text-lg cursor-pointer z-50 flex items-center justify-center shadow-lg backdrop-blur-sm"
          onClick={onScrollToBottom}
          title="滚到底部"
        >
          <Icon name="arrowDown" size={16} />
        </button>
      )}
    </div>
  )
}
