import { useState, useEffect, useRef, useId, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import GhostShield from './GhostShield'
import { Icon } from './icons'

interface Task {
  id: string
  session_name: string
  prompt: string
  status: 'success' | 'error' | 'running'
  output?: string
  error?: string
  createdAt: string
  completedAt?: string
  exitCode?: number
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
  const [sessionName, setSessionName] = useState(
    activeWindowName || (windows.find(w => w.active)?.name ?? (windows[0]?.name ?? ''))
  )
  const [requestError, setRequestError] = useState<string | null>(null)

  const isMountedRef = useRef(true)
  const outputRef = useRef<HTMLPreElement>(null)
  const abortRef = useRef<AbortController | null>(null)

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

  useEffect(() => {
    if (!sessionName) {
      const fallback = activeWindowName || (windows.find(w => w.active)?.name ?? (windows[0]?.name ?? ''))
      if (fallback) {
        setSessionName(fallback)
      }
    }
  }, [activeWindowName, windows, sessionName])

  async function fetchTasks() {
    try {
      const r = await fetch('/api/tasks', { headers: { Authorization: `Bearer ${token}` } })
      if (!isMountedRef.current) return
      if (r.ok) {
        const data = await r.json()
        if (isMountedRef.current) {
          setTasks(Array.isArray(data) ? data : [])
          setRequestError(null)
        }
      } else {
        const errText = await r.text().catch(() => '')
        if (isMountedRef.current) {
          setRequestError(t('tasks.fetchFailed', { status: r.status, details: errText ? ` (${errText})` : '' }))
        }
      }
    } catch (e: any) {
      if (isMountedRef.current) {
        setRequestError(t('tasks.networkError', { message: e.message || String(e) }))
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
        setRequestError(null)
      } else {
        const errText = await r.text().catch(() => '')
        setRequestError(t('tasks.deleteFailed', { status: r.status, details: errText ? ` (${errText})` : '' }))
      }
    } catch (e: any) {
      if (isMountedRef.current) {
        setRequestError(t('tasks.networkError', { message: e.message || String(e) }))
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

  async function runTask() {
    if (!prompt.trim() || isRunning || !sessionName || !tmuxSession) return
    setIsRunning(true)
    setStreamOutput('')
    setSelectedTaskId(null)
    setRequestError(null)

    const controller = new AbortController()
    abortRef.current = controller
    let sawDone = false

    try {
      const r = await fetch('/api/tasks', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_name: sessionName, prompt: prompt.trim(), tmux_session: tmuxSession }),
        signal: controller.signal,
      })

      if (!isMountedRef.current) return

      if (!r.ok || !r.body) {
        const errText = await r.text().catch(() => '')
        if (isMountedRef.current) {
          const errMsg = t('tasks.requestFailed', { status: r.status }) + (errText ? ` (${errText})` : '')
          setStreamOutput(errMsg)
          setRequestError(errMsg)
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
        setRequestError(interruptedMsg)
      }
    } catch (e: any) {
      if (e.name !== 'AbortError' && isMountedRef.current) {
        const errMsg = t('tasks.networkError', { message: e.message || String(e) })
        setStreamOutput(prev => (prev ? prev + '\n' : '') + errMsg)
        setRequestError(errMsg)
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
            <Icon name="clipboard" size={20} />
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
        {requestError && (
          <div className="px-5 py-2 bg-nexus-error/10 border-b border-nexus-error/20 text-[12px] text-nexus-error shrink-0 flex items-center justify-between">
            <span className="truncate" title={requestError}>{requestError}</span>
            <button
              aria-label={t('common.close')}
              className="bg-transparent border-none text-nexus-error cursor-pointer text-xs p-0 ml-2 shrink-0"
              onClick={() => setRequestError(null)}
            >
              ✕
            </button>
          </div>
        )}

        {/* Session selector */}
        <div className="flex items-center gap-2 px-5 py-2.5 border-b border-nexus-border shrink-0">
          <span className="text-nexus-text-2 text-[13px] shrink-0">{t('tasks.session')}</span>
          <select
            className="flex-1 bg-nexus-bg-2 border border-nexus-border rounded-md text-nexus-text px-2 py-1 text-[13px] font-mono cursor-pointer"
            value={sessionName}
            onChange={e => setSessionName(e.target.value)}
          >
            {windows.map(w => (
              <option key={w.index} value={w.name}>{w.index}: {w.name}</option>
            ))}
          </select>
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
              className={`bg-nexus-accent border-none rounded-md text-white cursor-pointer text-[13px] font-semibold px-4 py-2 self-end transition-opacity duration-200 ${isRunning || !prompt.trim() || !sessionName || !tmuxSession ? 'opacity-50' : 'opacity-100'}`}
              onClick={runTask}
              disabled={isRunning || !prompt.trim() || !sessionName || !tmuxSession}
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
                    setRequestError(null)
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
                  return (
                    <div
                      key={task.id}
                      className={`flex items-center gap-2 px-5 py-2.5 cursor-pointer border-b border-nexus-border transition-colors duration-150 ${activeTask?.id === task.id ? 'bg-nexus-tab-active' : ''}`}
                      onClick={() => setSelectedTaskId(activeTask?.id === task.id ? null : task.id)}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${task.status === 'success' ? 'bg-nexus-success' : isTaskRunning ? 'bg-nexus-warning animate-pulse' : 'bg-nexus-error'}`} />
                      <span className="flex-1 text-nexus-text text-[13px] font-mono overflow-hidden text-ellipsis whitespace-nowrap" title={task.prompt}>{task.prompt.slice(0, 60)}{task.prompt.length > 60 ? '...' : ''}</span>
                      <span className="text-nexus-muted text-[11px] shrink-0">{task.session_name}</span>
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
              <span className="text-nexus-text-2 text-xs font-mono">
                {activeTask.session_name} — {activeTask.status === 'running' ? t('tasks.runningStatus') : activeTask.status}
              </span>
              <div className="flex gap-1 ml-auto">
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
