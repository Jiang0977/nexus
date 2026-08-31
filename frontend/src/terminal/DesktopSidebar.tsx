import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../icons'
import { getWindowStatus, STATUS_DOT_COLOR } from '../windowStatus'
import type { ThemeMode } from './theme'
import type { TmuxWindow, WindowOutput } from './useTerminalSessions'

interface Props {
  activeWindowIndex: number
  codexHistoryEnabled: boolean
  expandedContent: ReactNode
  onAttachWindow: (index: number) => void
  onCollapse: () => void
  onExpand: () => void
  onOpenCodexHistory: (trigger?: HTMLElement | null) => void
  onOpenFiles: () => void
  onOpenNewSession: () => void
  onOpenNewWindow: () => void
  onOpenPromptLibrary: () => void
  onOpenSettings: () => void
  onOpenUpload: () => void
  onOpenWorkspace: () => void
  onToggleTheme: () => void
  sidebarCollapsed: boolean
  themeMode: ThemeMode
  toolbar: ReactNode
  width: number
  windows: TmuxWindow[]
  windowOutputs: Record<number, WindowOutput>
}

export function DesktopSidebar({
  activeWindowIndex,
  codexHistoryEnabled,
  expandedContent,
  onAttachWindow,
  onCollapse,
  onExpand,
  onOpenCodexHistory,
  onOpenFiles,
  onOpenNewSession,
  onOpenNewWindow,
  onOpenPromptLibrary,
  onOpenSettings,
  onOpenUpload,
  onOpenWorkspace,
  onToggleTheme,
  sidebarCollapsed,
  themeMode,
  toolbar,
  width,
  windows,
  windowOutputs,
}: Props) {
  const { t } = useTranslation()

  return (
    <div
      className="flex-shrink-0 flex flex-col bg-nexus-bg"
      style={{ width: sidebarCollapsed ? 48 : width, overflow: 'hidden' }}
    >
      {sidebarCollapsed ? (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-nexus-bg" style={{ maxWidth: 48 }}>
          <button
            onClick={(event) => {
              event.stopPropagation()
              onExpand()
            }}
            className="w-12 h-10 bg-transparent border-none text-nexus-text-2 flex items-center justify-center cursor-pointer shrink-0"
            title="展开侧边栏"
          >
            <Icon name="chevronRight" size={18} />
          </button>
          <div className="flex-1 overflow-y-auto overflow-x-hidden py-2 flex flex-col gap-0.5">
            {windows.map((window) => {
              const status = getWindowStatus(windowOutputs[window.index])
              const isActive = window.index === activeWindowIndex
              return (
                <button
                  key={window.index}
                  onClick={(event) => {
                    event.stopPropagation()
                    onAttachWindow(window.index)
                  }}
                  className="w-12 h-10 bg-transparent border-none flex items-center justify-center cursor-pointer relative"
                  style={{
                    background: isActive ? 'var(--nexus-tab-active)' : 'transparent',
                    borderLeft: isActive ? '3px solid var(--nexus-accent)' : '3px solid transparent',
                  }}
                  title={window.name}
                >
                  <span className="w-2 h-2 rounded-full" style={{ background: STATUS_DOT_COLOR[status] }} />
                </button>
              )
            })}
          </div>

          <div className="border-t border-nexus-border" onPointerDown={(event) => event.stopPropagation()} />

          <div className="flex-shrink-0 flex flex-col" onClick={(event) => event.stopPropagation()}>
            <button
              onClick={(event) => {
                event.stopPropagation()
                onOpenNewSession()
              }}
              className="w-12 h-10 bg-transparent border-none text-nexus-text-2 flex items-center justify-center cursor-pointer"
              title={t('sessionMgr.newProject')}
            >
              <Icon name="folderPlus" size={18} />
            </button>

            <button
              onClick={(event) => {
                event.stopPropagation()
                onOpenNewWindow()
              }}
              className="w-12 h-10 bg-transparent border-none text-nexus-text-2 flex items-center justify-center cursor-pointer"
              title={t('sessionMgr.newChannel')}
            >
              <Icon name="plus" size={18} />
            </button>

            <button
              onClick={(event) => {
                event.stopPropagation()
                onOpenFiles()
              }}
              className="w-12 h-10 bg-transparent border-none text-nexus-text-2 flex items-center justify-center cursor-pointer"
              title="文件列表"
            >
              <Icon name="folder" size={18} />
            </button>

            <button
              onClick={(event) => {
                event.stopPropagation()
                onOpenWorkspace()
              }}
              className="w-12 h-10 bg-transparent border-none text-nexus-text-2 flex items-center justify-center cursor-pointer"
              title="浏览工作目录"
            >
              <Icon name="folderOpen" size={18} />
            </button>

            <button
              onClick={(event) => {
                event.stopPropagation()
                onOpenUpload()
              }}
              className="w-12 h-10 bg-transparent border-none text-nexus-text-2 flex items-center justify-center cursor-pointer"
              title="上传文件"
            >
              <Icon name="paperclip" size={18} />
            </button>

            <button
              onClick={(event) => {
                event.stopPropagation()
                onOpenPromptLibrary()
              }}
              className="w-12 h-10 bg-transparent border-none text-nexus-text-2 flex items-center justify-center cursor-pointer"
              title={t('promptLibrary.title')}
              aria-label={t('promptLibrary.title')}
            >
              <Icon name="clipboard" size={18} />
            </button>

            {codexHistoryEnabled && (
              <button
                onClick={(event) => {
                  event.stopPropagation()
                  onOpenCodexHistory(event.currentTarget)
                }}
                className="w-12 h-10 bg-transparent border-none text-nexus-text-2 flex items-center justify-center cursor-pointer"
                title={t('codexSessions.title')}
                aria-label={t('codexSessions.title')}
              >
                <Icon name="history" size={18} />
              </button>
            )}

            <div className="flex-1" />

            <button
              onClick={(event) => {
                event.stopPropagation()
                onToggleTheme()
              }}
              className="w-12 h-10 bg-transparent border-none text-nexus-text-2 flex items-center justify-center cursor-pointer"
              title={themeMode === 'dark' ? '切换亮色' : '切换暗色'}
            >
              <Icon name={themeMode === 'dark' ? 'sun' : 'moon'} size={18} />
            </button>

            <button
              onClick={(event) => {
                event.stopPropagation()
                onOpenSettings()
              }}
              className="w-12 h-10 bg-transparent border-none text-nexus-text-2 flex items-center justify-center cursor-pointer"
              title={t('sessionMgr.title')}
            >
              <Icon name="settings" size={18} />
            </button>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden relative">
          <button
            onClick={(event) => {
              event.stopPropagation()
              onCollapse()
            }}
            className="absolute top-1.5 right-1.5 z-50 w-7 h-7 flex items-center justify-center rounded cursor-pointer bg-nexus-bg/80 border border-nexus-border text-nexus-text-2 hover:bg-nexus-bg transition-colors"
            title="收起侧边栏"
          >
            <Icon name="chevronLeft" size={16} />
          </button>
          <div className="flex-1 min-h-0 overflow-hidden">
            {expandedContent}
          </div>
          <div className="border-t border-nexus-border shrink-0" onClick={(event) => event.stopPropagation()}>
            {toolbar}
          </div>
        </div>
      )}
    </div>
  )
}
