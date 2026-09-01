import { useState, useEffect, useRef, useId, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import GhostShield from './GhostShield'
import { Icon } from './icons'

interface Task {
  id: string
  session_name: string
  tmux_session?: string
  prompt: string
  status: 'success' | 'error' | 'running'
  output?: string
  error?: string
  createdAt: string
  completedAt?: string
  exitCode?: number
}

interface ProjectOption {
  name: string
  path: string
  active?: boolean
  channelCount?: number
}

interface ChannelOption {
  index: number
  name: string
  active?: boolean
  cwd?: string
}

interface Props {
  token: string
  windows: { index: number; name: string; active?: boolean }[]
  activeWindowName: string
  tmuxSession: string
  onClose: () => void
}

export default function TaskPanel({ token, windows, activeWindowName, tmuxSession, onClose }: Props) {
  const { t } = useTranslation()
  const titleId = useId()
  const [tasks, setTasks] = useState<Task[]>([])
  const [prompt, setPrompt] = useState('')
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [streamOutput, setStreamOutput] = useState('')

  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [selectedProject, setSelectedProject] = useState(tmuxSession || '')
  const [channelsProject, setChannelsProject] = useState<string | null>(null)
  const [channels, setChannels] = useState<ChannelOption[]>([])
  const [selectedChannel, setSelectedChannel] = useState(
    activeWindowName || (windows.find(w => w.active)?.name ?? (windows[0]?.name ?? ''))
  )

  const [loadingProjects, setLoadingProjects] = useState(false)
  const [loadingChannels, setLoadingChannels] = useState(false)
  const [projectsError, setProjectsError] = useState<string | null>(null)
  const [channelsError, setChannelsError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const isMountedRef = useRef(true)
  const outputRef = useRef<HTMLPreElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const channelRequestIdRef = useRef(0)
  const initialProjectRef = useRef(tmuxSession || '')
  const initialChannelRef = useRef(
    activeWindowName || (windows.find(w => w.active)?.name ?? (windows[0]?.name ?? ''))
  )
  const lastLoadedProjectRef = useRef<string | null>(null)
  const initialLoadedRef = useRef(false)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      if (abortRef.current) {
        abortRef.current.abort()
        abortRef.current = null
      }
    }
  }, [])

  // Fetch projects on mount / token change
  useEffect(() => {
    let active = true
    setLoadingProjects(true)
    setProjectsError(null)

    fetch('/api/projects', { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        if (!active) return
        if (r.ok) {
          const data = await r.json()
          if (!active) return
          const projectList: ProjectOption[] = Array.isArray(data) ? data : []
          setProjects(projectList)
          setSelectedProject((current) => {
            if (current && projectList.some(p => p.name === current)) {
              return current
            }
            if (tmuxSession && projectList.some(p => p.name === tmuxSession)) {
              return tmuxSession
            }
            const activeProj = projectList.find(p => p.active)
            if (activeProj) return activeProj.name
            return projectList[0]?.name ?? ''
          })
        } else {
          const errText = await r.text().catch(() => '')
          if (!active) return
          setProjectsError(t('tasks.loadProjectsFailed', { status: r.status, details: errText ? ` (${errText})` : '' }))
        }
      })
      .catch((e: any) => {
        if (!active) return
        setProjectsError(t('tasks.networkError', { message: e.message || String(e) }))
      })
      .finally(() => {
        if (active) setLoadingProjects(false)
      })

    return () => {
      active = false
    }
  }, [token, tmuxSession, t])

  // When selectedProject changes, fetch channels for it
  useEffect(() => {
    const proj = selectedProject.trim()
    if (!proj) {
      setChannelsProject(null)
      setChannels([])
      setSelectedChannel('')
      setChannelsError(null)
      lastLoadedProjectRef.current = null
      setLoadingChannels(false)
      return
    }

    const requestId = ++channelRequestIdRef.current
    setLoadingChannels(true)
    setChannelsError(null)

    fetch(`/api/projects/${encodeURIComponent(proj)}/channels`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (r) => {
        if (!isMountedRef.current || channelRequestIdRef.current !== requestId) return
        if (r.ok) {
          const data = await r.json()
          if (!isMountedRef.current || channelRequestIdRef.current !== requestId) return
          const responseProject = typeof data.project === 'string' && data.project.trim() ? data.project.trim() : proj
          const rawChannels: ChannelOption[] = Array.isArray(data.channels) ? data.channels : []
          setChannelsProject(responseProject)
          setChannels(rawChannels)
          if (lastLoadedProjectRef.current === responseProject) {
            setSelectedChannel(prev => {
              if (prev && rawChannels.some(c => c.name === prev)) {
                return prev
              }
              const activeCh = rawChannels.find(c => c.active)
              if (activeCh) return activeCh.name
              return rawChannels[0]?.name ?? ''
            })
          } else if (!initialLoadedRef.current && responseProject === initialProjectRef.current) {
            initialLoadedRef.current = true
            const preferred = initialChannelRef.current
            if (preferred && rawChannels.some(c => c.name === preferred)) {
              setSelectedChannel(preferred)
            } else {
              const activeCh = rawChannels.find(c => c.active)
              setSelectedChannel(activeCh ? activeCh.name : (rawChannels[0]?.name ?? ''))
            }
          } else {
            initialLoadedRef.current = true
            const activeCh = rawChannels.find(c => c.active)
            setSelectedChannel(activeCh ? activeCh.name : (rawChannels[0]?.name ?? ''))
          }
          lastLoadedProjectRef.current = responseProject
        } else {
          const errText = await r.text().catch(() => '')
          if (!isMountedRef.current || channelRequestIdRef.current !== requestId) return
          setChannelsProject(null)
          setChannels([])
          setSelectedChannel('')
          setChannelsError(t('tasks.loadChannelsFailed', { status: r.status, details: errText ? ` (${errText})` : '' }))
          lastLoadedProjectRef.current = null
        }
      })
      .catch((e: any) => {
        if (!isMountedRef.current || channelRequestIdRef.current !== requestId) return
        setChannelsProject(null)
        setChannels([])
        setSelectedChannel('')
        setChannelsError(t('tasks.networkError', { message: e.message || String(e) }))
        lastLoadedProjectRef.current = null
      })
      .finally(() => {
        if (isMountedRef.current && channelRequestIdRef.current === requestId) {
          setLoadingChannels(false)
        }
      })
  }, [selectedProject, token, t])

  useEffect(() => {
    fetchTasks()
    const interval = setInterval(fetchTasks, 5000)
    return () => clearInterval(interval)
  }, [token])

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [streamOutput])

  async function fetchTasks() {
    try {
      const r = await fetch('/api/tasks', { headers: { Authorization: `Bearer ${token}` } })
      if (!isMountedRef.current) return
      if (r.ok) {
        const data = await r.json()
        if (isMountedRef.current) {
          setTasks(Array.isArray(data) ? data : [])
          setActionError(null)
        }
      } else {
        const errText = await r.text().catch(() => '')
        if (isMountedRef.current) {
          setActionError(t('tasks.fetchFailed', { status: r.status, details: errText ? ` (${errText})` : '' }))
        }
      }
    } catch (e: any) {
      if (isMountedRef.current) {
        setActionError(t('tasks.networkError', { message: e.message || String(e) }))
      }
    }
  }

  async function deleteTask(id: string, e: React.MouseEvent) {
    e.stopPropagation()
    try {
      const r = await fetch(`/api/tasks/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!isMountedRef.current) return
      if (r.ok) {
        setTasks(prev => prev.filter(item => item.id !== id))
        if (selectedTaskId === id) setSelectedTaskId(null)
        setActionError(null)
      } else {
        const errText = await r.text().catch(() => '')
        setActionError(t('tasks.deleteFailed', { status: r.status, details: errText ? ` (${errText})` : '' }))
      }
    } catch (e: any) {
      if (isMountedRef.current) {
        setActionError(t('tasks.networkError', { message: e.message || String(e) }))
      }
    }
  }

  function processSseBlock(block: string, onChunk: (c: string) => void): boolean {
    const lines = block.split(/\r?\n/)
    let eventType = ''
    const dataLines: string[] = []

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''))
      }
    }

    if (eventType === 'done') {
      return true
    }

    if (dataLines.length > 0) {
      const dataStr = dataLines.join('\n')
      try {
        const parsed = JSON.parse(dataStr)
        if (parsed.chunk !== undefined && typeof parsed.chunk === 'string') {
          onChunk(parsed.chunk)
        }
      } catch {
        // ignore malformed frame JSON
      }
    }
    return false
  }

  const targetProject = selectedProject.trim()
  const targetChannel = selectedChannel.trim()

  const isTargetsReady = Boolean(
    !loadingProjects &&
    !loadingChannels &&
    !projectsError &&
    !channelsError &&
    targetProject &&
    projects.some(p => p.name === targetProject) &&
    channelsProject === targetProject &&
    targetChannel &&
    channels.some(c => c.name === targetChannel)
  )

  async function runTask() {
    const targetProject = selectedProject.trim()
    const targetChannel = selectedChannel.trim()
    if (!prompt.trim() || isRunning || !targetProject || !targetChannel || !isTargetsReady) return
    setIsRunning(true)
    setStreamOutput('')
    setSelectedTaskId(null)
    setActionError(null)

    const controller = new AbortController()
    abortRef.current = controller
    let sawDone = false

    try {
      const r = await fetch('/api/tasks', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_name: targetChannel, prompt: prompt.trim(), tmux_session: targetProject }),
        signal: controller.signal,
      })

      if (!isMountedRef.current) return

      if (!r.ok || !r.body) {
        const errText = await r.text().catch(() => '')
        if (isMountedRef.current) {
          const errMsg = t('tasks.requestFailed', { status: r.status }) + (errText ? ` (${errText})` : '')
          setStreamOutput(errMsg)
          setActionError(errMsg)
          setIsRunning(false)
        }
        return
      }

      const reader = r.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          buffer += decoder.decode()
          if (buffer.trim()) {
            const finalParts = buffer.split(/(?:\r?\n){2}/)
            for (const part of finalParts) {
              if (!part.trim()) continue
              if (processSseBlock(part, (chunk) => {
                if (isMountedRef.current) {
                  setStreamOutput(prev => prev + chunk)
                }
              })) {
                sawDone = true
                break
              }
            }
          }
          break
        }
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split(/(?:\r?\n){2}/)
        buffer = parts.pop() || ''

        for (const part of parts) {
          if (!part.trim()) continue
          const reachedDone = processSseBlock(part, (chunk) => {
            if (isMountedRef.current) {
              setStreamOutput(prev => prev + chunk)
            }
          })
          if (reachedDone) {
            sawDone = true
            break
          }
        }
        if (sawDone) break
      }

      if (!sawDone && isMountedRef.current && !controller.signal.aborted) {
        const interruptedMsg = t('tasks.streamInterrupted')
        setStreamOutput(prev => (prev ? prev + '\n' : '') + interruptedMsg)
        setActionError(interruptedMsg)
      }
    } catch (e: any) {
      if (e.name !== 'AbortError' && isMountedRef.current) {
        const errMsg = t('tasks.networkError', { message: e.message || String(e) })
        setStreamOutput(prev => (prev ? prev + '\n' : '') + errMsg)
        setActionError(errMsg)
      }
    } finally {
      abortRef.current = null
      if (isMountedRef.current) {
        setIsRunning(false)
        if (sawDone) {
          setPrompt('')
        }
        fetchTasks()
      }
    }
  }

  const activeTask = useMemo(() => {
    if (!selectedTaskId) return null
    return tasks.find(t => t.id === selectedTaskId) ?? null
  }, [selectedTaskId, tasks])

  const displayedError = projectsError || channelsError || actionError

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 bg-black/40 z-[300] flex items-stretch justify-end"
    >
      <GhostShield />
      <div className="w-[440px] max-w-[100vw] bg-nexus-bg border-l border-nexus-border flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-nexus-border shrink-0">
          <span id={titleId} className="flex items-center gap-2 text-nexus-text text-[15px] font-semibold">
            <Icon name="play" size={20} />
            {t('tasks.title')}
          </span>
          <button
            aria-label={t('common.close')}
            className="flex items-center justify-center bg-transparent border-none text-nexus-text-2 text-2xl cursor-pointer p-0 leading-none"
            onClick={onClose}
          >
            <Icon name="x" size={20} />
          </button>
        </div>

        {/* Notice */}
        <div className="px-5 py-2 bg-nexus-bg-2 border-b border-nexus-border text-[12px] text-nexus-muted leading-relaxed shrink-0">
          {t('tasks.backgroundNotice')}
        </div>

        {/* Global Request/Action Error Message */}
        {displayedError && (
          <div className="px-5 py-2 bg-nexus-error/10 border-b border-nexus-error/20 text-[12px] text-nexus-error shrink-0 flex items-center justify-between">
            <span className="truncate" title={displayedError}>{displayedError}</span>
            <button
              aria-label={t('common.close')}
              className="bg-transparent border-none text-nexus-error cursor-pointer text-xs p-0 ml-2 shrink-0"
              onClick={() => {
                if (projectsError) setProjectsError(null)
                if (channelsError) setChannelsError(null)
                if (actionError) setActionError(null)
              }}
            >
              ✕
            </button>
          </div>
        )}

        {/* Target selectors: Project & Channel */}
        <div className="flex flex-col gap-2 px-5 py-2.5 border-b border-nexus-border shrink-0">
          {/* Project selector */}
          <div className="flex items-center gap-2">
            <span className="text-nexus-text-2 text-[13px] shrink-0 w-16">{t('tasks.project')}</span>
            <select
              aria-label={t('tasks.project')}
              className="flex-1 min-w-0 bg-nexus-bg-2 border border-nexus-border rounded-md text-nexus-text px-2 py-1 text-[13px] font-mono cursor-pointer disabled:opacity-50"
              value={selectedProject}
              disabled={isRunning || loadingProjects || projects.length === 0}
              onChange={e => {
                const nextProj = e.target.value
                setSelectedProject(nextProj)
                setChannelsProject(null)
                setChannels([])
                setSelectedChannel('')
                setChannelsError(null)
                lastLoadedProjectRef.current = null
              }}
            >
              {loadingProjects ? (
                <option value="">{t('tasks.loadingProjects')}</option>
              ) : projects.length === 0 ? (
                <option value="">{t('tasks.noProjects')}</option>
              ) : (
                projects.map(p => (
                  <option key={p.name} value={p.name} title={p.path}>
                    {p.name} ({p.path})
                  </option>
                ))
              )}
            </select>
          </div>

          {/* Channel selector */}
          <div className="flex items-center gap-2">
            <span className="text-nexus-text-2 text-[13px] shrink-0 w-16">{t('tasks.channel')}</span>
            <select
              aria-label={t('tasks.channel')}
              className="flex-1 min-w-0 bg-nexus-bg-2 border border-nexus-border rounded-md text-nexus-text px-2 py-1 text-[13px] font-mono cursor-pointer disabled:opacity-50"
              value={selectedChannel}
              disabled={isRunning || loadingChannels || channels.length === 0}
              onChange={e => setSelectedChannel(e.target.value)}
            >
              {loadingChannels ? (
                <option value="">{t('tasks.loadingChannels')}</option>
              ) : channels.length === 0 ? (
                <option value="">{t('tasks.noChannels')}</option>
              ) : (
                channels.map(c => (
                  <option key={c.index} value={c.name}>
                    {c.index}: {c.name}{c.active ? ' *' : ''}
                  </option>
                ))
              )}
            </select>
          </div>
        </div>

        {/* Prompt input */}
        <div className="px-5 py-3 border-b border-nexus-border flex flex-col gap-2 shrink-0">
          <textarea
            className="bg-nexus-bg-2 border border-nexus-border rounded-lg text-nexus-text px-3 py-2.5 text-[13px] font-mono resize-none outline-none leading-relaxed"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            placeholder={t('tasks.promptPlaceholder')}
            rows={4}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                runTask()
              }
            }}
          />
          <div className="flex gap-2 self-end">
            <button
              className={`bg-nexus-accent border-none rounded-md text-white cursor-pointer text-[13px] font-semibold px-4 py-2 self-end transition-opacity duration-200 ${isRunning || !prompt.trim() || !isTargetsReady ? 'opacity-50' : 'opacity-100'}`}
              onClick={runTask}
              disabled={isRunning || !prompt.trim() || !isTargetsReady}
            >
              {isRunning ? t('tasks.running') : t('tasks.sendTask')}
            </button>
          </div>
        </div>

        {/* Output area for active stream */}
        {(isRunning || streamOutput) && (
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            <div className="flex items-center gap-2 px-5 py-2 border-b border-nexus-border shrink-0">
              {isRunning && <span className="w-2 h-2 rounded-full bg-nexus-success animate-spin shrink-0" />}
              <span className="text-nexus-text-2 text-xs font-mono">{isRunning ? t('tasks.runningStatus') : t('tasks.output')}</span>
              {!isRunning && streamOutput && (
                <button
                  className="ml-auto bg-transparent border-none text-nexus-text-2 cursor-pointer text-[13px] px-1 py-0.5 leading-none rounded hover:text-nexus-text"
                  title={t('tasks.backToHistory')}
                  aria-label={t('tasks.backToHistory')}
                  onClick={() => {
                    setStreamOutput('')
                    setActionError(null)
                    setSelectedTaskId(null)
                  }}
                >
                  {t('tasks.backToHistory')}
                </button>
              )}
            </div>
            <pre ref={outputRef} className="flex-1 m-0 px-5 py-3 text-nexus-text text-xs font-mono overflow-y-auto whitespace-pre-wrap break-words leading-relaxed">{streamOutput || ' '}</pre>
          </div>
        )}

        {/* Task history list */}
        {!isRunning && !streamOutput && (
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            <div className="px-5 py-2 text-nexus-text-2 text-xs font-semibold border-b border-nexus-border shrink-0">{t('tasks.history')}</div>
            {tasks.length === 0 ? (
              <div className="p-5 text-nexus-muted text-[13px] text-center">{t('tasks.noTasks')}</div>
            ) : (
              <div className="overflow-y-auto flex-1">
                {tasks.map(task => {
                  const isTaskRunning = task.status === 'running'
                  const targetLabel = task.tmux_session ? `${task.tmux_session} / ${task.session_name}` : task.session_name
                  return (
                    <div
                      key={task.id}
                      className={`flex items-center gap-2 px-5 py-2.5 cursor-pointer border-b border-nexus-border transition-colors duration-150 ${activeTask?.id === task.id ? 'bg-nexus-tab-active' : ''}`}
                      onClick={() => setSelectedTaskId(activeTask?.id === task.id ? null : task.id)}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${task.status === 'success' ? 'bg-nexus-success' : isTaskRunning ? 'bg-nexus-warning animate-pulse' : 'bg-nexus-error'}`} />
                      <span className="flex-1 text-nexus-text text-[13px] font-mono overflow-hidden text-ellipsis whitespace-nowrap" title={task.prompt}>{task.prompt.slice(0, 60)}{task.prompt.length > 60 ? '...' : ''}</span>
                      <span className="text-nexus-muted text-[11px] max-w-[120px] truncate shrink-0" title={targetLabel}>{targetLabel}</span>
                      {!isTaskRunning && (
                        <button
                          aria-label={t('common.delete')}
                          className="flex items-center justify-center bg-transparent border-none text-nexus-muted cursor-pointer text-[11px] px-0.5 shrink-0 leading-none opacity-60 hover:opacity-100"
                          onClick={(e) => deleteTask(task.id, e)}
                          title={t('common.delete')}
                        >
                          <Icon name="x" size={14} />
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* Selected historical task detail output */}
        {activeTask && !isRunning && !streamOutput && (
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden border-t border-nexus-border">
            <div className="flex items-center gap-2 px-5 py-2 border-b border-nexus-border shrink-0">
              {activeTask.status === 'running' && <span className="w-2 h-2 rounded-full bg-nexus-success animate-spin shrink-0" />}
              <span
                className="flex-1 min-w-0 truncate text-nexus-text-2 text-xs font-mono"
                title={`${activeTask.tmux_session ? `${activeTask.tmux_session} / ${activeTask.session_name}` : activeTask.session_name} — ${activeTask.status === 'running' ? t('tasks.runningStatus') : activeTask.status}`}
              >
                {activeTask.tmux_session ? `${activeTask.tmux_session} / ${activeTask.session_name}` : activeTask.session_name} — {activeTask.status === 'running' ? t('tasks.runningStatus') : activeTask.status}
              </span>
              <div className="flex gap-1 ml-auto shrink-0">
                {activeTask.status !== 'running' && (
                  <button
                    className="bg-transparent border-none text-nexus-text-2 cursor-pointer text-[13px] px-1 py-0.5 leading-none rounded hover:text-nexus-text"
                    title={t('tasks.reusePrompt')}
                    aria-label={t('tasks.reusePrompt')}
                    onClick={() => {
                      setPrompt(activeTask.prompt)
                      setSelectedTaskId(null)
                    }}
                  >
                    ↩
                  </button>
                )}
                <button
                  className="bg-transparent border-none text-nexus-text-2 cursor-pointer text-[13px] px-1 py-0.5 leading-none rounded hover:text-nexus-text"
                  title={t('tasks.copyOutput')}
                  aria-label={t('tasks.copyOutput')}
                  onClick={() => {
                    const text = activeTask.output || activeTask.error || ''
                    if (text) navigator.clipboard.writeText(text).catch(() => {})
                  }}
                >
                  ⎘
                </button>
              </div>
            </div>
            <pre className="flex-1 m-0 px-5 py-3 text-nexus-text text-xs font-mono overflow-y-auto whitespace-pre-wrap break-words leading-relaxed">{activeTask.output || activeTask.error || (activeTask.status === 'running' ? t('tasks.waitingOutput') : t('tasks.noOutput'))}</pre>
          </div>
        )}
      </div>
    </div>
  )
}
