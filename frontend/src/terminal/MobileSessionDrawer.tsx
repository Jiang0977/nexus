import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import GhostShield from '../GhostShield'
import { Icon } from '../icons'
import { getWindowStatus, STATUS_DOT_COLOR, STATUS_DOT_TITLE } from '../windowStatus'
import type { TmuxWindow, WindowOutput } from './useTerminalSessions'

interface Props {
  activeTmuxSession: string
  activeWindowIndex: number
  onClose: () => void
  onCloseWindow: (index: number) => void
  onNewChannel: () => void
  onNewProject: () => void
  onRenameWindow: (index: number, name: string) => void
  onSwitchSession: (session: string) => void
  onSwitchWindow: (index: number) => void
  tmuxSessions: string[]
  windowOutputs: Record<number, WindowOutput>
  windows: TmuxWindow[]
}

export function MobileSessionDrawer({
  activeTmuxSession,
  activeWindowIndex,
  onClose,
  onCloseWindow,
  onNewChannel,
  onNewProject,
  onRenameWindow,
  onSwitchSession,
  onSwitchWindow,
  tmuxSessions,
  windowOutputs,
  windows,
}: Props) {
  const { t } = useTranslation()
  const [menuIndex, setMenuIndex] = useState<number | null>(null)
  const [renameIndex, setRenameIndex] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')

  function closeDrawer() {
    setMenuIndex(null)
    setRenameIndex(null)
    onClose()
  }

  return (
    <>
      <GhostShield />
      <div className="fixed inset-0 z-[400] bg-black/50" onPointerDown={closeDrawer} />
      <div className="fixed bottom-0 left-0 right-0 z-[401] bg-nexus-menu-bg rounded-t-xl border border-nexus-border border-b-0 max-h-[70vh] flex flex-col shadow-[0_-4px_24px_rgba(0,0,0,0.4)]">
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-nexus-border flex-shrink-0">
          <span className="text-nexus-text font-semibold text-[15px]">{t('sessionMgr.title')}</span>
          <button
            className="bg-transparent border-none text-nexus-text-2 cursor-pointer p-1 flex items-center justify-center"
            onPointerDown={(event) => {
              event.preventDefault()
              closeDrawer()
              ;(document.activeElement as HTMLElement | null)?.blur()
            }}
          >
            <Icon name="x" size={20} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-1.5">
          {windows.map((window) => {
            const status = getWindowStatus(windowOutputs[window.index])
            const isActive = window.index === activeWindowIndex
            const isMenuOpen = menuIndex === window.index
            const isRenaming = renameIndex === window.index

            return (
              <div key={window.index} className="border-b border-nexus-border">
                <div className={`flex items-center gap-3 px-4 py-3 ${isActive ? 'bg-nexus-tab-active' : 'bg-transparent'}`}>
                  <span
                    className="w-2 h-2 rounded-full flex-shrink-0 inline-block"
                    style={{ background: STATUS_DOT_COLOR[status] }}
                    title={t(STATUS_DOT_TITLE[status])}
                  />
                  {isRenaming ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(event) => setRenameValue(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          onRenameWindow(window.index, renameValue.trim() || window.name)
                          setRenameIndex(null)
                        }
                        if (event.key === 'Escape') setRenameIndex(null)
                      }}
                      onBlur={() => setRenameIndex(null)}
                      className="flex-1 bg-nexus-bg border border-nexus-accent rounded-md text-nexus-text text-sm font-mono py-1 px-2 outline-none"
                      onClick={(event) => event.stopPropagation()}
                    />
                  ) : (
                    <span
                      className="flex-1 text-nexus-text text-sm font-mono overflow-hidden text-ellipsis whitespace-nowrap cursor-pointer"
                      onPointerUp={(event) => {
                        event.stopPropagation()
                        onSwitchWindow(window.index)
                        closeDrawer()
                      }}
                    >
                      {window.name}
                    </span>
                  )}
                  {isActive && !isRenaming && (
                    <span className="text-nexus-accent text-sm font-semibold flex-shrink-0 flex items-center">
                      <Icon name="check" size={14} />
                    </span>
                  )}
                  <button
                    className="bg-transparent border-none text-nexus-text-2 cursor-pointer p-1 flex-shrink-0 flex items-center justify-center"
                    onPointerDown={(event) => {
                      event.stopPropagation()
                      setMenuIndex(isMenuOpen ? null : window.index)
                      setRenameIndex(null)
                    }}
                  >
                    <Icon name="more" size={18} />
                  </button>
                </div>
                {isMenuOpen && !isRenaming && (
                  <div className="flex gap-2 px-4 py-1.5 pb-2.5 bg-nexus-bg">
                    <button
                      className="flex-1 bg-transparent border border-nexus-border rounded-md text-nexus-text text-sm py-1.5 cursor-pointer"
                      onPointerDown={(event) => {
                        event.stopPropagation()
                        setRenameValue(window.name)
                        setRenameIndex(window.index)
                        setMenuIndex(null)
                      }}
                    >
                      <span className="flex items-center justify-center gap-1">
                        <Icon name="pencil" size={14} />
                        改名
                      </span>
                    </button>
                    <button
                      className="flex-1 bg-transparent border border-nexus-error rounded-md text-nexus-error text-sm py-1.5 cursor-pointer"
                      onPointerDown={(event) => {
                        event.stopPropagation()
                        onCloseWindow(window.index)
                        setMenuIndex(null)
                        if (windows.length <= 1) closeDrawer()
                      }}
                    >
                      <span className="flex items-center justify-center gap-1">
                        <Icon name="x" size={14} />
                        关闭
                      </span>
                    </button>
                  </div>
                )}
              </div>
            )
          })}
          {tmuxSessions.length > 1 && (
            <div className="px-4 pt-2.5 pb-1 text-nexus-muted text-[11px] uppercase tracking-wide">{t('sessionMgr.projects')}</div>
          )}
          {tmuxSessions.length > 1 && tmuxSessions.map((session) => (
            <div
              key={session}
              className={`flex items-center gap-2.5 px-4 py-2.5 cursor-pointer ${session === activeTmuxSession ? 'bg-nexus-tab-active' : 'bg-transparent'}`}
              onClick={() => {
                onSwitchSession(session)
                closeDrawer()
              }}
            >
              <span className="flex items-center gap-1.5 text-sm">
                {session === activeTmuxSession ? <span className="text-nexus-accent"><Icon name="check" size={14} /></span> : <span className="w-3.5" />}
                <span className={session === activeTmuxSession ? 'text-nexus-accent' : 'text-nexus-text-2'}>{session}</span>
              </span>
            </div>
          ))}
        </div>
        <div className="px-4 py-3 border-t border-nexus-border flex-shrink-0 flex gap-2">
          <button
            className="flex-1 bg-nexus-accent border-none rounded-lg text-white text-sm font-semibold py-3 cursor-pointer flex items-center justify-center gap-1.5"
            style={{ touchAction: 'manipulation' }}
            onClick={() => {
              closeDrawer()
              onNewProject()
            }}
          >
            <span>📁</span>
            <span>{t('sessionMgr.newProject')}</span>
          </button>
          <button
            className="flex-1 bg-nexus-bg-2 border border-nexus-border rounded-lg text-nexus-text text-sm font-semibold py-3 cursor-pointer flex items-center justify-center gap-1.5"
            style={{ touchAction: 'manipulation' }}
            onClick={() => {
              closeDrawer()
              onNewChannel()
            }}
          >
            <span>➕</span>
            <span>{t('sessionMgr.newChannel')}</span>
          </button>
        </div>
      </div>
    </>
  )
}
