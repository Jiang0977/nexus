import { lazy, Suspense, type RefObject } from 'react'
import type { SessionManagerV2Handle } from '../SessionManagerV2'
import type { ShellType } from '../shellType'
import type { ThemeMode } from './theme'
import type { TmuxWindow } from './useTerminalSessions'

const loadSessionManager = () => import('../SessionManager')
export const preloadSessionManagerV2 = () => import('../SessionManagerV2')
const loadWorkspaceSelector = () => import('../WorkspaceSelector')
const loadNewWindowDialog = () => import('../NewWindowDialog')
const loadFilePanel = () => import('../FilePanel')
const loadWorkspaceBrowser = () => import('../WorkspaceBrowser')
const loadGeneralSettings = () => import('../GeneralSettings')
const loadPromptLibrary = () => import('../PromptLibrary')
const loadTaskPanel = () => import('../TaskPanel')
export const preloadCodexSessionsPanel = () => import('../CodexSessionsPanel')

const SessionManager = lazy(loadSessionManager)
const SessionManagerV2 = lazy(preloadSessionManagerV2)
const WorkspaceSelector = lazy(loadWorkspaceSelector)
const NewWindowDialog = lazy(loadNewWindowDialog)
const FilePanel = lazy(loadFilePanel)
const WorkspaceBrowser = lazy(loadWorkspaceBrowser)
const GeneralSettings = lazy(loadGeneralSettings)
const PromptLibrary = lazy(loadPromptLibrary)
const TaskPanel = lazy(loadTaskPanel)
const CodexSessionsPanel = lazy(preloadCodexSessionsPanel)

interface Props {
  activeTmuxSession: string
  activeWindowIndex: number
  activeWindowName: string
  activeWindowProjectPath?: string
  codexHistoryEnabled: boolean
  codexHistoryFocusReturnTarget: HTMLElement | null
  onAttachWindow: (index: number) => void
  onCloseCodexSessions: () => void
  onCloseFiles: () => void
  onCloseGeneralSettings: () => void
  onCloseNewSession: () => void
  onCloseNewWindow: () => void
  onClosePromptLibrary: () => void
  onCloseSessionManager: () => void
  onCloseSessionManagerV2: () => void
  onCloseTasks: () => void
  onCloseWorkspace: () => void
  onCodexDeleteSuccess: (closedWindowIndexes: number[]) => void | Promise<void>
  onCodexResumeSuccess: (index: number) => void
  onCreateSession: (path: string, shellType: ShellType, profile?: string) => void
  onNewWindowConfirm: (shellType: ShellType, profile?: string) => void
  onOpenApiConfig: () => void
  onInsertPromptToTerminal: (content: string) => boolean
  onSessionManagerNewChannel: () => void
  onSessionManagerNewProject: () => void
  onStartNewCodexFromModal: () => void
  onSwitchSession: (name: string, lastChannel?: number) => void
  sessionManagerRef: RefObject<SessionManagerV2Handle>
  showCodexSessions: boolean
  showFiles: boolean
  showGeneralSettings: boolean
  showNewSession: boolean
  showNewWindow: boolean
  showPromptLibrary: boolean
  showSessionManager: boolean
  showSessionManagerV2: boolean
  showTasks: boolean
  showWorkspace: boolean
  themeMode: ThemeMode
  token: string
  toggleTheme: () => void
  windows: TmuxWindow[]
}

export function TerminalModalStack({
  activeTmuxSession,
  activeWindowIndex,
  activeWindowName,
  activeWindowProjectPath,
  codexHistoryEnabled,
  codexHistoryFocusReturnTarget,
  onAttachWindow,
  onCloseCodexSessions,
  onCloseFiles,
  onCloseGeneralSettings,
  onCloseNewSession,
  onCloseNewWindow,
  onClosePromptLibrary,
  onCloseSessionManager,
  onCloseSessionManagerV2,
  onCloseTasks,
  onCloseWorkspace,
  onCodexDeleteSuccess,
  onCodexResumeSuccess,
  onCreateSession,
  onNewWindowConfirm,
  onOpenApiConfig,
  onInsertPromptToTerminal,
  onSessionManagerNewChannel,
  onSessionManagerNewProject,
  onStartNewCodexFromModal,
  onSwitchSession,
  sessionManagerRef,
  showCodexSessions,
  showFiles,
  showGeneralSettings,
  showNewSession,
  showNewWindow,
  showPromptLibrary,
  showSessionManager,
  showSessionManagerV2,
  showTasks,
  showWorkspace,
  themeMode,
  token,
  toggleTheme,
  windows,
}: Props) {
  return (
    <>
      {showFiles && (
        <Suspense fallback={null}>
          <FilePanel
            token={token}
            onClose={onCloseFiles}
          />
        </Suspense>
      )}
      {showPromptLibrary && (
        <Suspense fallback={null}>
          <PromptLibrary
            token={token}
            onClose={onClosePromptLibrary}
            onInsertToTerminal={onInsertPromptToTerminal}
          />
        </Suspense>
      )}
      {showTasks && (
        <Suspense fallback={null}>
          <TaskPanel
            token={token}
            windows={windows}
            activeWindowName={activeWindowName}
            tmuxSession={activeTmuxSession}
            onClose={onCloseTasks}
          />
        </Suspense>
      )}
      {showWorkspace && (
        <Suspense fallback={null}>
          <WorkspaceBrowser
            token={token}
            onClose={onCloseWorkspace}
            currentSession={activeTmuxSession}
          />
        </Suspense>
      )}
      {showCodexSessions && codexHistoryEnabled && (
        <Suspense fallback={null}>
          <CodexSessionsPanel
            token={token}
            projectName={activeTmuxSession}
            layout="modal"
            focusReturnTarget={codexHistoryFocusReturnTarget}
            onClose={onCloseCodexSessions}
            onResumeSuccess={onCodexResumeSuccess}
            onDeleteSuccess={onCodexDeleteSuccess}
            onStartNewCodex={onStartNewCodexFromModal}
          />
        </Suspense>
      )}
      {showSessionManager && (
        <Suspense fallback={null}>
          <SessionManager
            token={token}
            onClose={onCloseSessionManager}
          />
        </Suspense>
      )}
      {showSessionManagerV2 && (
        <Suspense fallback={null}>
          <SessionManagerV2
            ref={sessionManagerRef}
            token={token}
            currentProject={activeTmuxSession}
            currentChannelIndex={activeWindowIndex}
            onClose={onCloseSessionManagerV2}
            onSwitchProject={onSwitchSession}
            onSwitchChannel={onAttachWindow}
            onNewProject={onSessionManagerNewProject}
            onNewChannel={onSessionManagerNewChannel}
          />
        </Suspense>
      )}
      {showNewSession && (
        <Suspense fallback={null}>
          <WorkspaceSelector
            token={token}
            onClose={onCloseNewSession}
            onConfirm={onCreateSession}
          />
        </Suspense>
      )}
      {showNewWindow && (
        <Suspense fallback={null}>
          <NewWindowDialog
            token={token}
            projectPath={activeWindowProjectPath}
            onClose={onCloseNewWindow}
            onConfirm={onNewWindowConfirm}
          />
        </Suspense>
      )}
      {showGeneralSettings && (
        <Suspense fallback={null}>
          <GeneralSettings
            token={token}
            themeMode={themeMode}
            onToggleTheme={toggleTheme}
            onClose={onCloseGeneralSettings}
            onOpenApiConfig={onOpenApiConfig}
          />
        </Suspense>
      )}
    </>
  )
}
