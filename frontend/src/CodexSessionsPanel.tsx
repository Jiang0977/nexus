import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import GhostShield from './GhostShield'
import { buildCodexSessionDetailFields } from './codexSessionDetailFields.js'
import { Icon } from './icons'

interface CodexSessionItem {
  id: string
  title: string
  updatedAt: string
  cwd: string
  attributionKind: 'repo-root' | 'cwd'
}

interface CodexSessionsResponse {
  scope: {
    project: string
    path: string
    repoRoot: string
    summary: string
  }
  items: CodexSessionItem[]
  nextCursor: string | null
  warning: {
    codes: string[]
    message: string
  } | null
}

interface CodexSessionDetail {
  id: string
  title: string
  updatedAt: string
  startedAt: string
  cwd: string
  attributionKind: 'repo-root' | 'cwd'
  source: string
  originator: string
  cliVersion: string
  modelProvider: string
}

interface Props {
  token: string
  projectName: string
  layout?: 'sidebar' | 'modal'
  onClose?: () => void
  onResumeSuccess?: (channelIndex: number) => void
  onDeleteSuccess?: (closedWindowIndexes: number[]) => void | Promise<void>
  onStartNewCodex?: () => void
}

function formatUpdatedAt(value: string) {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function basename(value: string) {
  const parts = String(value || '').split('/').filter(Boolean)
  return parts[parts.length - 1] || value || '/'
}

function panelErrorMessage(status: number) {
  if (status === 404) return 'codexSessions.projectNotFound'
  return 'codexSessions.loadFailed'
}

function warningMessage(warning: CodexSessionsResponse['warning'], t: ReturnType<typeof useTranslation>['t']) {
  if (!warning) return ''
  const codes = warning.codes || []
  if (codes.includes('partial_results') && codes.includes('attribution_unavailable')) {
    return t('codexSessions.warningCombined')
  }
  if (codes.includes('attribution_unavailable')) {
    return t('codexSessions.warningAttribution')
  }
  return t('codexSessions.warningPartial')
}

function detailFieldLabel(key: string, t: ReturnType<typeof useTranslation>['t']) {
  switch (key) {
    case 'source':
      return t('codexSessions.detailFields.source')
    case 'originator':
      return t('codexSessions.detailFields.originator')
    case 'cliVersion':
      return t('codexSessions.detailFields.cliVersion')
    case 'modelProvider':
      return t('codexSessions.detailFields.modelProvider')
    case 'startedAt':
      return t('codexSessions.detailFields.startedAt')
    default:
      return key
  }
}

export default function CodexSessionsPanel({
  token,
  projectName,
  layout = 'sidebar',
  onClose,
  onResumeSuccess,
  onDeleteSuccess,
  onStartNewCodex,
}: Props) {
  const { t } = useTranslation()
  const [items, setItems] = useState<CodexSessionItem[]>([])
  const [scope, setScope] = useState<CodexSessionsResponse['scope'] | null>(null)
  const [warning, setWarning] = useState<CodexSessionsResponse['warning'] | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [resumingId, setResumingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [expandedDetails, setExpandedDetails] = useState<Record<string, boolean>>({})
  const [detailCache, setDetailCache] = useState<Record<string, CodexSessionDetail>>({})
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({})
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null)

  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token])

  const loadSessions = useCallback(async (opts?: { cursor?: string | null; append?: boolean }) => {
    if (!projectName) {
      setItems([])
      setScope(null)
      setWarning(null)
      setNextCursor(null)
      setLoading(false)
      setError(null)
      return
    }

    const append = opts?.append === true
    if (append) setLoadingMore(true)
    else {
      setLoading(true)
      setError(null)
    }

    try {
      const params = new URLSearchParams({ project: projectName, limit: '10' })
      if (opts?.cursor) params.set('cursor', opts.cursor)

      const response = await fetch(`/api/codex-sessions?${params.toString()}`, { headers })
      if (!response.ok) {
        setError(t(panelErrorMessage(response.status)))
        if (!append) {
          setItems([])
          setScope(null)
          setWarning(null)
          setNextCursor(null)
        }
        return
      }

      const data = await response.json() as CodexSessionsResponse
      setScope(data.scope)
      setWarning(data.warning)
      setNextCursor(data.nextCursor)
      setItems(prev => append ? [...prev, ...data.items] : data.items)
      setError(null)
    } catch {
      setError(t('codexSessions.loadFailed'))
      if (!append) {
        setItems([])
        setScope(null)
        setWarning(null)
        setNextCursor(null)
      }
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [headers, projectName, t])

  useEffect(() => {
    setActionError(null)
    setResumingId(null)
    setDeletingId(null)
    setExpandedDetails({})
    setDetailCache({})
    setDetailErrors({})
    setLoadingDetailId(null)
    loadSessions()
  }, [loadSessions])

  const handleResume = useCallback(async (sessionId: string) => {
    setActionError(null)
    setResumingId(sessionId)
    try {
      const response = await fetch(`/api/codex-sessions/${encodeURIComponent(sessionId)}/resume`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ project: projectName }),
      })
      if (!response.ok) {
        setActionError(t('codexSessions.resumeFailed'))
        return
      }

      const data = await response.json() as { channelIndex?: number }
      if (typeof data.channelIndex === 'number') {
        onResumeSuccess?.(data.channelIndex)
      }
      if (layout === 'modal') onClose?.()
    } catch {
      setActionError(t('codexSessions.resumeFailed'))
    } finally {
      setResumingId(null)
    }
  }, [headers, layout, onClose, onResumeSuccess, projectName, t])

  const handleDelete = useCallback(async (sessionId: string, title: string) => {
    setActionError(null)
    if (!confirm(t('codexSessions.deleteConfirm', { title }))) {
      return
    }

    setDeletingId(sessionId)
    try {
      const response = await fetch(`/api/codex-sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ project: projectName }),
      })
      if (!response.ok) {
        setActionError(t('codexSessions.deleteFailed'))
        return
      }

      const data = await response.json() as { closedWindowIndexes?: number[] }
      try {
        await onDeleteSuccess?.(Array.isArray(data.closedWindowIndexes) ? data.closedWindowIndexes : [])
      } catch {
        // Deletion already succeeded server-side; keep UI on the success path.
      }
      await loadSessions()
    } catch {
      setActionError(t('codexSessions.deleteFailed'))
    } finally {
      setDeletingId(null)
    }
  }, [headers, loadSessions, onDeleteSuccess, projectName, t])

  const handleToggleDetail = useCallback(async (sessionId: string) => {
    const isExpanded = expandedDetails[sessionId] === true
    if (isExpanded) {
      setExpandedDetails(prev => ({ ...prev, [sessionId]: false }))
      return
    }

    setExpandedDetails(prev => ({ ...prev, [sessionId]: true }))
    if (detailCache[sessionId] || loadingDetailId === sessionId) return

    setDetailErrors(prev => ({ ...prev, [sessionId]: '' }))
    setLoadingDetailId(sessionId)
    try {
      const params = new URLSearchParams({ project: projectName })
      const response = await fetch(`/api/codex-sessions/${encodeURIComponent(sessionId)}/detail?${params.toString()}`, { headers })
      if (!response.ok) {
        setDetailErrors(prev => ({ ...prev, [sessionId]: t('codexSessions.detailLoadFailed') }))
        return
      }

      const data = await response.json() as CodexSessionDetail
      setDetailCache(prev => ({ ...prev, [sessionId]: data }))
    } catch {
      setDetailErrors(prev => ({ ...prev, [sessionId]: t('codexSessions.detailLoadFailed') }))
    } finally {
      setLoadingDetailId(null)
    }
  }, [detailCache, expandedDetails, headers, loadingDetailId, projectName, t])

  const panelBody = (
    <div className={`flex flex-col min-h-0 ${layout === 'sidebar' ? 'h-full bg-nexus-bg' : ''}`}>
      <div className={`flex items-center justify-between gap-3 ${layout === 'sidebar' ? 'px-4 py-3 border-b border-nexus-border' : 'px-4 py-3.5 border-b border-nexus-border flex-shrink-0'}`}>
        <div className="min-w-0">
          <div className="text-nexus-text text-sm font-semibold truncate">
            {t('codexSessions.title')} {scope?.project ? `· ${scope.project}` : projectName ? `· ${projectName}` : ''}
          </div>
          <div className="text-[11px] text-nexus-text-2 mt-1 truncate">
            {scope ? (
              scope.repoRoot
                ? t('codexSessions.scopeRepo', { path: scope.repoRoot })
                : t('codexSessions.scopeCwd', { path: scope.path })
            ) : t('codexSessions.scopePending')}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            className="bg-transparent border border-nexus-border rounded-md text-nexus-text-2 text-sm px-2.5 py-1.5 cursor-pointer hover:bg-nexus-bg-2 transition-colors"
            onClick={() => loadSessions()}
            disabled={loading}
          >
            <span className="flex items-center gap-1.5">
              <Icon name="refresh" size={14} />
              <span>{t('common.refresh')}</span>
            </span>
          </button>
          {layout === 'modal' && (
            <button
              className="bg-transparent border border-nexus-border rounded-md text-nexus-text text-sm px-2.5 py-1.5 cursor-pointer hover:bg-nexus-bg-2 transition-colors"
              onClick={onClose}
            >
              <span className="flex items-center gap-1.5">
                <Icon name="arrowLeft" size={14} />
                <span>{t('codexSessions.backToSession')}</span>
              </span>
            </button>
          )}
        </div>
      </div>

      <div className={`${layout === 'sidebar' ? 'px-4 pt-3 pb-2' : 'px-4 pt-3 pb-2 flex-shrink-0'}`}>
        <div className="text-[11px] uppercase tracking-wide text-nexus-text-2 mb-2">{t('codexSessions.primaryAction')}</div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            className="bg-nexus-bg-2 border border-nexus-border rounded-md text-nexus-text text-sm px-3 py-2 cursor-pointer hover:bg-nexus-tab-active transition-colors"
            onClick={onStartNewCodex}
          >
            {t('codexSessions.startNew')}
          </button>
          {nextCursor && (
            <button
              className="bg-transparent border border-nexus-border rounded-md text-nexus-text-2 text-sm px-3 py-2 cursor-pointer hover:bg-nexus-bg-2 transition-colors"
              onClick={() => loadSessions({ cursor: nextCursor, append: true })}
              disabled={loadingMore}
            >
              {loadingMore ? t('common.loading') : t('codexSessions.loadMore')}
            </button>
          )}
        </div>
        <div className="text-[12px] text-nexus-text-2 mt-2">
          {t('codexSessions.resumeHint')}
        </div>
      </div>

      {warning && (
        <div className={`${layout === 'sidebar' ? 'px-4 pb-2' : 'px-4 pb-2 flex-shrink-0'}`}>
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
            <div className="flex items-start gap-2">
              <div className="text-amber-400 mt-0.5">
                <Icon name="alert" size={16} />
              </div>
              <div className="min-w-0">
                <div className="text-amber-200 text-sm font-medium">{t('codexSessions.warningTitle')}</div>
                <div className="text-amber-100/90 text-xs mt-1 leading-5">{warningMessage(warning, t)}</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {actionError && (
        <div className={`${layout === 'sidebar' ? 'px-4 pb-2' : 'px-4 pb-2 flex-shrink-0'}`}>
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-red-200 text-sm">
            {actionError}
          </div>
        </div>
      )}

      <div className={`flex-1 min-h-0 ${layout === 'sidebar' ? 'overflow-y-auto px-4 pb-4' : 'overflow-y-auto px-4 pb-4'}`}>
        {loading ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 4 }).map((_, index) => (
              <div
                key={index}
                className="rounded-xl border border-nexus-border bg-nexus-bg-2/60 px-3 py-3 animate-pulse"
              >
                <div className="h-4 w-2/3 bg-nexus-border rounded" />
                <div className="mt-2 h-3 w-1/3 bg-nexus-border rounded" />
              </div>
            ))}
          </div>
        ) : error && items.length === 0 ? (
          <div className="rounded-xl border border-nexus-border bg-nexus-bg-2/60 px-4 py-5">
            <div className="text-nexus-text text-base font-semibold">{t('codexSessions.errorTitle')}</div>
            <div className="text-nexus-text-2 text-sm mt-2 leading-6">{error}</div>
            <div className="flex flex-wrap gap-2 mt-4">
              <button
                className="bg-nexus-accent border-none rounded-md text-white text-sm font-semibold px-3 py-2 cursor-pointer"
                onClick={() => loadSessions()}
              >
                {t('codexSessions.retry')}
              </button>
              {layout === 'modal' && (
                <button
                  className="bg-transparent border border-nexus-border rounded-md text-nexus-text text-sm px-3 py-2 cursor-pointer"
                  onClick={onClose}
                >
                  {t('codexSessions.backToSession')}
                </button>
              )}
            </div>
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-nexus-border bg-nexus-bg-2/40 px-4 py-6">
            <div className="text-nexus-text text-base font-semibold">{t('codexSessions.emptyTitle')}</div>
            <div className="text-nexus-text-2 text-sm mt-2 leading-6">{t('codexSessions.emptyDescription')}</div>
            <div className="flex flex-wrap gap-2 mt-4">
              <button
                className="bg-nexus-accent border-none rounded-md text-white text-sm font-semibold px-3 py-2 cursor-pointer"
                onClick={onStartNewCodex}
              >
                {t('codexSessions.startNew')}
              </button>
              <button
                className="bg-transparent border border-nexus-border rounded-md text-nexus-text text-sm px-3 py-2 cursor-pointer"
                onClick={() => loadSessions()}
              >
                {t('common.refresh')}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {items.map(item => (
              <div key={item.id} className="rounded-xl border border-nexus-border bg-nexus-bg-2/60 px-3 py-3">
                <div className="flex flex-col">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-nexus-text leading-6 break-words">
                      {item.title}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 mt-1.5 text-xs text-nexus-text-2">
                      <span>{formatUpdatedAt(item.updatedAt)}</span>
                      <span className="inline-flex items-center gap-1 rounded-full border border-nexus-border px-2 py-0.5">
                        <span className={`inline-block w-1.5 h-1.5 rounded-full ${item.attributionKind === 'repo-root' ? 'bg-green-400' : 'bg-amber-400'}`} />
                        <span>{item.attributionKind === 'repo-root' ? t('codexSessions.matchRepo') : t('codexSessions.matchPath')}</span>
                      </span>
                    </div>
                    <div className="text-xs text-nexus-text-2 mt-2 break-all">
                      {basename(item.cwd)} · {item.cwd}
                    </div>
                    <div className="mt-2">
                      <button
                        className="bg-transparent border border-nexus-border rounded-md text-nexus-text-2 text-xs px-2.5 py-1.5 cursor-pointer hover:bg-nexus-bg-2 transition-colors"
                        onClick={() => handleToggleDetail(item.id)}
                        disabled={loadingDetailId === item.id}
                        type="button"
                      >
                        {loadingDetailId === item.id
                          ? t('codexSessions.loadingDetails')
                          : expandedDetails[item.id]
                            ? t('codexSessions.hideDetails')
                            : t('codexSessions.details')}
                      </button>
                    </div>
                  </div>
                  {expandedDetails[item.id] && (
                    <div className="mt-3 rounded-lg border border-nexus-border bg-nexus-bg px-3 py-3">
                      <div className="text-xs font-semibold uppercase tracking-wide text-nexus-text-2">
                        {t('codexSessions.detailTitle')}
                      </div>
                      {detailErrors[item.id] ? (
                        <div className="mt-2 text-sm text-red-300">{detailErrors[item.id]}</div>
                      ) : loadingDetailId === item.id ? (
                        <div className="mt-2 text-sm text-nexus-text-2">{t('common.loading')}</div>
                      ) : buildCodexSessionDetailFields(detailCache[item.id]).length === 0 ? (
                        <div className="mt-2 text-sm text-nexus-text-2">{t('codexSessions.detailEmpty')}</div>
                      ) : (
                        <div className="mt-2 grid gap-2">
                          {buildCodexSessionDetailFields(detailCache[item.id]).map(field => (
                            <div key={field.key} className="flex flex-col gap-0.5 text-sm">
                              <div className="text-[11px] uppercase tracking-wide text-nexus-text-2">
                                {detailFieldLabel(field.key, t)}
                              </div>
                              <div className="text-nexus-text break-all">
                                {field.key === 'startedAt' ? formatUpdatedAt(field.value) : field.value}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="mt-3 pt-3 border-t border-nexus-border">
                    <div className="flex items-center gap-2">
                      <button
                        className="flex-1 min-h-[44px] bg-transparent border border-nexus-border rounded-lg text-nexus-text-2 text-sm font-medium px-3 py-2 cursor-pointer hover:bg-nexus-tab-active transition-colors disabled:opacity-60 disabled:cursor-default"
                        onClick={() => handleDelete(item.id, item.title)}
                        disabled={resumingId === item.id || deletingId === item.id}
                      >
                        <span className="flex items-center justify-center gap-1.5">
                          <Icon name="trash" size={14} />
                          <span>{deletingId === item.id ? t('codexSessions.deleting') : t('common.delete')}</span>
                        </span>
                      </button>
                      <button
                        className="flex-1 min-h-[44px] bg-transparent border border-nexus-border rounded-lg text-nexus-text text-sm font-medium px-3 py-2 cursor-pointer hover:bg-nexus-tab-active transition-colors disabled:opacity-60 disabled:cursor-default"
                        onClick={() => handleResume(item.id)}
                        disabled={resumingId === item.id || deletingId === item.id}
                      >
                        {resumingId === item.id ? t('codexSessions.opening') : t('codexSessions.resume')}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )

  if (layout === 'sidebar') {
    return panelBody
  }

  return (
    <>
      <GhostShield />
      <div className="fixed inset-0 z-[410] bg-black/55" onPointerDown={onClose} />
      <div className="fixed inset-x-0 bottom-0 z-[411] bg-nexus-menu-bg rounded-t-2xl border border-nexus-border border-b-0 max-h-[76vh] flex flex-col shadow-[0_-10px_32px_rgba(0,0,0,0.38)]">
        {panelBody}
      </div>
    </>
  )
}
