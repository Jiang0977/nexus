import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react'
import type { Terminal as XTerm } from '@xterm/xterm'
import { isCodexHistoryEnabled } from '../featureFlags'
import { pickBootstrapSession, sessionExists } from '../sessionBootstrap'
import { DEFAULT_SHELL_TYPE, type ShellType } from '../shellType'
import { createNonOverlappingPoller, pollWindowOutputs } from './windowOutputPolling'

const WINDOW_KEY = 'nexus_window'
const SESSION_SOURCE_KEY = 'nexus_session_source'

export interface TmuxWindow {
  index: number
  name: string
  active: boolean
}

export interface WindowOutput {
  output: string
  clients: number
  idleMs: number
  connected: boolean
}

export interface ProjectInfo {
  name: string
  path: string
  active: boolean
  channelCount: number
}

interface UseTerminalSessionsArgs {
  activeWindowIndex: number
  activeWindowIndexRef: MutableRefObject<number>
  pausePollingRef: MutableRefObject<boolean>
  scrollPositionsRef: MutableRefObject<Record<number, number>>
  setActiveWindowIndex: Dispatch<SetStateAction<number>>
  termRef: RefObject<XTerm | null>
  token: string
}

function getInitialTrustedSession() {
  const source = localStorage.getItem(SESSION_SOURCE_KEY) || ''
  if (source !== 'user') return ''
  return localStorage.getItem('nexus_session') || ''
}

export function useTerminalSessions({
  activeWindowIndex,
  activeWindowIndexRef,
  pausePollingRef,
  scrollPositionsRef,
  setActiveWindowIndex,
  termRef,
  token,
}: UseTerminalSessionsArgs) {
  const [windows, setWindows] = useState<TmuxWindow[]>([])
  const [windowsLoaded, setWindowsLoaded] = useState(false)
  const [windowOutputs, setWindowOutputs] = useState<Record<number, WindowOutput>>({})
  const [tmuxSessions, setTmuxSessions] = useState<string[]>([])
  const [activeTmuxSession, setActiveTmuxSession] = useState<string>(() => getInitialTrustedSession())
  const [wsSessionKey, setWsSessionKey] = useState<string>(() => getInitialTrustedSession())
  const [defaultTmuxSession, setDefaultTmuxSession] = useState('')
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null)
  const [codexHistoryEnabled, setCodexHistoryEnabled] = useState(true)

  const activeTmuxSessionRef = useRef(activeTmuxSession)
  activeTmuxSessionRef.current = activeTmuxSession

  const windowsInitializedRef = useRef(false)
  const windowsLoadedRef = useRef(false)
  const windowsRef = useRef<TmuxWindow[]>([])
  windowsRef.current = windows

  const clearSessionSelection = useCallback(() => {
    localStorage.removeItem('nexus_session')
    localStorage.removeItem(SESSION_SOURCE_KEY)
    localStorage.removeItem(WINDOW_KEY)
    activeTmuxSessionRef.current = ''
    setActiveTmuxSession('')
    setWsSessionKey('')
    setActiveWindowIndex(0)
    setWindows([])
    setWindowOutputs({})
    windowsInitializedRef.current = false
    windowsLoadedRef.current = true
    setWindowsLoaded(true)
  }, [setActiveWindowIndex])

  const fetchWindows = useCallback(async () => {
    try {
      const session = activeTmuxSessionRef.current.trim()
      if (!session) {
        setWindows([])
        setWindowOutputs({})
        return
      }
      const response = await fetch(`/api/sessions?session=${encodeURIComponent(session)}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json()
      const wins = data.windows ?? []
      setWindows(wins)
      if (!windowsLoadedRef.current) {
        windowsLoadedRef.current = true
        setWindowsLoaded(true)
      }
      const currentStillExists = wins.some((window: TmuxWindow) => window.index === activeWindowIndexRef.current)
      if (!windowsInitializedRef.current) {
        windowsInitializedRef.current = true
        if (!currentStillExists) {
          const activeWindow = wins.find((window: TmuxWindow) => window.active)
          if (activeWindow) {
            setActiveWindowIndex(activeWindow.index)
            localStorage.setItem(WINDOW_KEY, String(activeWindow.index))
          }
        }
      } else if (!currentStillExists) {
        const activeWindow = wins.find((window: TmuxWindow) => window.active)
        if (activeWindow) {
          setActiveWindowIndex(activeWindow.index)
          localStorage.setItem(WINDOW_KEY, String(activeWindow.index))
        }
      }
    } catch (error: unknown) {
      console.error('[useTerminalSessions] Failed to fetch windows', {
        error,
        session: activeTmuxSessionRef.current,
      })
    }
  }, [activeWindowIndexRef, setActiveWindowIndex, token])

  const handleSwitchSession = useCallback((newSession: string, lastChannel?: number, source: 'user' | 'bootstrap' = 'user') => {
    if (!newSession) {
      clearSessionSelection()
      return
    }
    localStorage.setItem('nexus_session', newSession)
    localStorage.setItem(SESSION_SOURCE_KEY, source)
    activeTmuxSessionRef.current = newSession
    setActiveTmuxSession(newSession)
    setWsSessionKey(newSession)
    setWindows([])
    if (lastChannel !== undefined && lastChannel !== null) {
      setActiveWindowIndex(lastChannel)
      localStorage.setItem(WINDOW_KEY, String(lastChannel))
    } else {
      setActiveWindowIndex(0)
      localStorage.removeItem(WINDOW_KEY)
    }
    windowsInitializedRef.current = false
    windowsLoadedRef.current = false
    setWindowsLoaded(false)
    setTimeout(() => { void fetchWindows() }, 100)
  }, [clearSessionSelection, fetchWindows, setActiveWindowIndex])

  const attachToWindow = useCallback(async (index: number) => {
    if (termRef.current && activeWindowIndex !== index) {
      const buffer = (termRef.current as any).buffer
      if (buffer?.active) {
        scrollPositionsRef.current[activeWindowIndex] = buffer.active.viewportY
      }
    }

    try {
      const session = activeTmuxSessionRef.current
      const response = await fetch(`/api/sessions/${index}/attach?session=${encodeURIComponent(session)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      setActiveWindowIndex(index)
      localStorage.setItem(WINDOW_KEY, String(index))
      pausePollingRef.current = true
      setTimeout(() => { pausePollingRef.current = false }, 3000)
      setTimeout(() => {
        const savedY = scrollPositionsRef.current[index]
        if (savedY !== undefined && termRef.current) {
          termRef.current.scrollLines(savedY - (termRef.current as any).buffer.active.viewportY)
        }
      }, 500)
    } catch (error: unknown) {
      console.error('[useTerminalSessions] Failed to attach to window', {
        error,
        session: activeTmuxSessionRef.current,
        windowIndex: index,
      })
    }
  }, [activeWindowIndex, pausePollingRef, scrollPositionsRef, setActiveWindowIndex, termRef, token])

  const closeWindow = useCallback(async (index: number) => {
    try {
      const session = activeTmuxSessionRef.current
      const response = await fetch(`/api/sessions/${index}?session=${encodeURIComponent(session)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      await fetchWindows()
    } catch (error: unknown) {
      console.error('[useTerminalSessions] Failed to close window', {
        error,
        session: activeTmuxSessionRef.current,
        windowIndex: index,
      })
    }
  }, [fetchWindows, token])

  const renameWindow = useCallback(async (index: number, name: string) => {
    try {
      const session = activeTmuxSessionRef.current
      const response = await fetch(`/api/sessions/${index}/rename?session=${encodeURIComponent(session)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      await fetchWindows()
    } catch (error: unknown) {
      console.error('[useTerminalSessions] Failed to rename window', {
        error,
        name,
        session: activeTmuxSessionRef.current,
        windowIndex: index,
      })
    }
  }, [fetchWindows, token])

  const createSession = useCallback(async (relPath: string, shellType: ShellType = DEFAULT_SHELL_TYPE, profile?: string) => {
    try {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: relPath, shell_type: shellType, profile }),
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const { name: newProjectName } = await response.json()
      handleSwitchSession(newProjectName, 0)
    } catch (error: unknown) {
      console.error('[useTerminalSessions] Failed to create session', {
        error,
        path: relPath,
        profile,
        shellType,
      })
    }
  }, [handleSwitchSession, token])

  const createWindow = useCallback(async (shellType: ShellType = DEFAULT_SHELL_TYPE, profile?: string) => {
    try {
      const session = activeTmuxSessionRef.current
      const currentProject = (projects ?? []).find((project) => project.name === session)
      const projectPath = currentProject?.path
      const response = await fetch(`/api/projects/${encodeURIComponent(session)}/channels`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ shell_type: shellType, profile, path: projectPath }),
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const { name: newWindowName } = await response.json()
      await new Promise((resolve) => setTimeout(resolve, 300))
      const sessionNow = activeTmuxSessionRef.current
      const listResponse = await fetch(`/api/sessions?session=${encodeURIComponent(sessionNow)}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!listResponse.ok) {
        throw new Error(`HTTP ${listResponse.status}`)
      }
      const data = await listResponse.json()
      const wins: TmuxWindow[] = data.windows ?? []
      setWindows(wins)
      const newWindow = wins.find((window) => window.name === newWindowName)
      if (newWindow) {
        await attachToWindow(newWindow.index)
      }
    } catch (error: unknown) {
      console.error('[useTerminalSessions] Failed to create window', {
        error,
        profile,
        session: activeTmuxSessionRef.current,
        shellType,
      })
    }
  }, [attachToWindow, projects, token])

  useEffect(() => {
    const loadConfig = async () => {
      try {
        const response = await fetch('/api/config', { headers: { Authorization: `Bearer ${token}` } })
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }
        const data = await response.json()
        setDefaultTmuxSession(data.tmuxSession || '')
        setCodexHistoryEnabled(isCodexHistoryEnabled(data))
      } catch (error: unknown) {
        console.error('[useTerminalSessions] Failed to load Nexus config', error)
      }
    }

    void loadConfig()
  }, [token])

  useEffect(() => {
    setProjects(null)

    const fetchSessions = async () => {
      try {
        const response = await fetch('/api/tmux-sessions', { headers: { Authorization: `Bearer ${token}` } })
        if (response.ok) {
          const sessions = await response.json()
          setTmuxSessions(sessions.map((session: { name: string }) => session.name))
          return
        }
        console.error(`[useTerminalSessions] Failed to load tmux sessions: HTTP ${response.status}`)
      } catch (error: unknown) {
        console.error('[useTerminalSessions] Failed to load tmux sessions', error)
      }
    }

    const fetchProjects = async () => {
      try {
        const response = await fetch('/api/projects', { headers: { Authorization: `Bearer ${token}` } })
        if (response.ok) {
          setProjects(await response.json())
          return
        }
        setProjects([])
        console.error(`[useTerminalSessions] Failed to load projects: HTTP ${response.status}`)
      } catch (error: unknown) {
        setProjects([])
        console.error('[useTerminalSessions] Failed to load projects', error)
      }
    }

    void fetchSessions()
    void fetchProjects()

    const interval = setInterval(() => {
      void fetchSessions()
      void fetchProjects()
    }, 10000)

    return () => clearInterval(interval)
  }, [token])

  useEffect(() => {
    if (projects === null) return

    const storedSession = localStorage.getItem('nexus_session') || ''
    const storedSessionSource = localStorage.getItem(SESSION_SOURCE_KEY) || ''
    const validStoredSession = storedSessionSource === 'user' && sessionExists(storedSession, projects)
      ? storedSession
      : ''
    if (storedSession && !validStoredSession) {
      localStorage.removeItem('nexus_session')
      localStorage.removeItem(SESSION_SOURCE_KEY)
    }

    if (sessionExists(activeTmuxSessionRef.current, projects)) return

    const nextSession = pickBootstrapSession({
      storedSession: validStoredSession,
      storedSessionSource,
      activeSession: activeTmuxSessionRef.current,
      defaultSession: defaultTmuxSession,
      projects,
    })

    if (nextSession) {
      handleSwitchSession(nextSession, undefined, 'bootstrap')
      return
    }

    clearSessionSelection()
  }, [clearSessionSelection, defaultTmuxSession, handleSwitchSession, projects])

  useEffect(() => {
    void fetchWindows()
    const interval = setInterval(() => {
      if (!pausePollingRef.current) {
        void fetchWindows()
      }
    }, 2000)
    return () => clearInterval(interval)
  }, [fetchWindows, pausePollingRef])

  useEffect(() => {
    if (!activeTmuxSession || windows.length === 0) {
      setWindowOutputs({})
      return
    }

    const controller = new AbortController()
    const tick = createNonOverlappingPoller(async () => {
      const outputs = await pollWindowOutputs({
        windows,
        session: activeTmuxSession,
        token,
        signal: controller.signal,
        onError: (detail) => {
          console.error('[useTerminalSessions] Failed to poll window output', {
            session: activeTmuxSession,
            windowIndex: detail.windowIndex,
            ...(detail.status !== undefined ? { status: detail.status } : { error: detail.error }),
          })
        },
      })
      if (outputs) setWindowOutputs(outputs)
    })

    const interval = setInterval(() => {
      void tick()
    }, 3000)

    void tick()

    return () => {
      controller.abort()
      clearInterval(interval)
    }
  }, [activeTmuxSession, token, windows])

  return {
    activeTmuxSession,
    activeTmuxSessionRef,
    attachToWindow,
    clearSessionSelection,
    closeWindow,
    codexHistoryEnabled,
    createSession,
    createWindow,
    fetchWindows,
    handleSwitchSession,
    projects,
    renameWindow,
    tmuxSessions,
    windowOutputs,
    windows,
    windowsLoaded,
    windowsRef,
    wsSessionKey,
  }
}
