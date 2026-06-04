import type { RefObject, UIEvent } from 'react'
import GhostShield from '../GhostShield'
import { Icon } from '../icons'

interface ScrollbackOverlayProps {
  content: string
  fontFamily: string
  fontSize: number
  foreground: string
  hint: string
  loading: boolean
  loadingLabel: string
  muted: string
  bottomSpacerPx?: number
  onClose: () => void
  onScroll: (event: UIEvent<HTMLDivElement>) => void
  overlayRef: RefObject<HTMLDivElement>
  title: string
  visible: boolean
  background: string
}

export const MOBILE_SCROLLBACK_BOTTOM_SPACER_PX = 320
export const MOBILE_SCROLLBACK_INITIAL_BOTTOM_OFFSET_PX = 160

export function ScrollbackOverlay({
  background,
  bottomSpacerPx = 0,
  content,
  fontFamily,
  fontSize,
  foreground,
  hint,
  loading,
  loadingLabel,
  muted,
  onClose,
  onScroll,
  overlayRef,
  title,
  visible,
}: ScrollbackOverlayProps) {
  if (!visible) return null

  return (
    <div className="fixed inset-0 z-[500] flex flex-col" style={{ background }}>
      <GhostShield />
      <div className="flex shrink-0 items-center justify-between border-b px-3.5 py-2.5" style={{ borderColor: `${muted}44` }}>
        <span className="text-sm font-semibold" style={{ color: foreground }}>{title}</span>
        <span className="flex-1 px-3 text-center text-xs" style={{ color: muted }}>{hint}</span>
        <button className="flex items-center justify-center border-none bg-transparent p-1 cursor-pointer" style={{ color: muted }} onClick={onClose}>
          <Icon name="x" size={20} />
        </button>
      </div>
      <div
        ref={overlayRef}
        data-scrollback-overlay="true"
        onScroll={onScroll}
        className="flex-1 overflow-auto py-2 select-text"
        style={{ WebkitOverflowScrolling: 'touch', userSelect: 'text', WebkitUserSelect: 'text', cursor: 'text' }}
      >
        {loading ? (
          <div className="p-8 text-center" style={{ color: muted, fontFamily, fontSize }}>{loadingLabel}</div>
        ) : (
          <>
            <pre
              data-scrollback-content="true"
              className="m-0 whitespace-pre p-3 leading-tight select-text"
              style={{ color: foreground, cursor: 'text', fontFamily, fontSize, userSelect: 'text', WebkitUserSelect: 'text' }}
            >
              {content}
            </pre>
            {bottomSpacerPx > 0 && (
              <div
                aria-hidden="true"
                data-scrollback-bottom-spacer="true"
                style={{ height: bottomSpacerPx }}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}
