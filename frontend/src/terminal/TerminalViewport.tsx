import type { RefObject } from 'react'
import { Icon } from '../icons'
import type { TerminalScrollMode } from './terminalApplicationScroll'
import { TerminalScrollModeSelect } from './TerminalScrollModeSelect'

interface Props {
  containerRef: RefObject<HTMLDivElement>
  isConnecting: boolean
  connectionError?: string | null
  isScrolledUp: boolean
  onFocusTerminal?: () => void
  onFetchScrollback: () => void
  onScrollToBottom: () => void
  selectTextLabel: string
  scrollMode: TerminalScrollMode
  onScrollModeChange: (mode: TerminalScrollMode) => void
}

export function TerminalViewport({
  containerRef,
  isConnecting,
  connectionError,
  isScrolledUp,
  onFocusTerminal,
  onFetchScrollback,
  onScrollToBottom,
  selectTextLabel,
  scrollMode,
  onScrollModeChange,
}: Props) {
  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden relative">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-nexus-border bg-nexus-bg px-2 py-1">
        <TerminalScrollModeSelect value={scrollMode} onChange={onScrollModeChange} />
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-nexus-border bg-nexus-bg/80 px-2.5 py-1.5 text-xs font-medium text-nexus-text cursor-pointer active:scale-95 hover:bg-nexus-bg-2/90"
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
      </div>
      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-hidden relative"
        onClick={onFocusTerminal}
      />
      {isConnecting && (
        <div className="absolute inset-0 bg-nexus-bg flex flex-col items-center justify-center gap-3 z-10">
          <div className="w-8 h-8 border-[3px] border-nexus-border border-t-nexus-accent rounded-full animate-spin" />
          <span className="text-nexus-text-2 text-sm">Connecting...</span>
        </div>
      )}
      {connectionError && !isConnecting && (
        <div className="absolute inset-0 bg-nexus-bg/95 flex flex-col items-center justify-center gap-3 z-20" role="alert" aria-live="assertive">
          <div className="w-8 h-8 text-nexus-error" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-full h-full">
              <path fillRule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25zm-1.72 6.97a.75.75 0 10-1.06 1.06L10.94 12l-1.72 1.72a.75.75 0 101.06 1.06L12 13.06l1.72 1.72a.75.75 0 101.06-1.06L13.06 12l1.72-1.72a.75.75 0 10-1.06-1.06L12 10.94l-1.72-1.72z" clipRule="evenodd" />
            </svg>
          </div>
          <span className="text-nexus-error text-sm font-medium text-center px-4">{connectionError}</span>
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
