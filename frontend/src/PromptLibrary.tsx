import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import GhostShield from './GhostShield'
import { Icon } from './icons'
import {
  MAX_PROMPT_CONTENT_CHARS,
  MAX_PROMPT_TITLE_CHARS,
  PromptLibraryRequestError,
  createPrompt,
  deletePrompt,
  listPrompts,
  reorderPrompts,
  updatePrompt,
  type PromptRecord,
} from './promptLibrary/api'

interface Props {
  token: string
  onClose: () => void
  onInsertToTerminal: (content: string) => boolean
}
interface Draft {
  title: string
  content: string
}

type MobileView = 'list' | 'editor'

interface PromptDragState {
  pointerId: number
  promptId: string
  handle: HTMLButtonElement
  baseline: PromptRecord[]
  current: PromptRecord[]
  offsetX: number
  offsetY: number
}

interface PromptDragPreview {
  left: number
  top: number
  width: number
  height: number
  prompt: PromptRecord
  orderedIds: string[]
}

const EMPTY_DRAFT: Draft = { title: '', content: '' }

function movePromptToIndex(prompts: PromptRecord[], promptId: string, targetIndex: number) {
  const sourceIndex = prompts.findIndex(prompt => prompt.id === promptId)
  if (sourceIndex < 0 || sourceIndex === targetIndex) return prompts
  const next = [...prompts]
  const [moved] = next.splice(sourceIndex, 1)
  next.splice(targetIndex, 0, moved)
  return next
}

function promptOrderMatches(left: PromptRecord[], right: PromptRecord[]) {
  return left.length === right.length && left.every((prompt, index) => prompt.id === right[index]?.id)
}

export default function PromptLibrary({ token, onClose, onInsertToTerminal }: Props) {
  const { t, i18n } = useTranslation()
  const titleInputRef = useRef<HTMLInputElement>(null)
  const promptListRef = useRef<HTMLDivElement>(null)
  const noticeTimerRef = useRef<number | null>(null)
  const dragRef = useRef<PromptDragState | null>(null)
  const reorderInFlightRef = useRef(false)
  const [prompts, setPrompts] = useState<PromptRecord[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [creatingNew, setCreatingNew] = useState(false)
  const [query, setQuery] = useState('')
  const [mobileView, setMobileView] = useState<MobileView>('list')
  const [loading, setLoading] = useState(true)
  const [loadedSuccessfully, setLoadedSuccessfully] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [reordering, setReordering] = useState(false)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [dragPreview, setDragPreview] = useState<PromptDragPreview | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const selectedPrompt = useMemo(
    () => prompts.find(prompt => prompt.id === selectedId) ?? null,
    [prompts, selectedId],
  )
  const dirty = creatingNew
    ? Boolean(draft.title || draft.content)
    : Boolean(selectedPrompt && (
      draft.title !== selectedPrompt.title || draft.content !== selectedPrompt.content
    ))
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredPrompts = useMemo(() => {
    if (!normalizedQuery) return prompts
    return prompts.filter(prompt => (
      prompt.title.toLocaleLowerCase().includes(normalizedQuery)
      || prompt.content.toLocaleLowerCase().includes(normalizedQuery)
    ))
  }, [normalizedQuery, prompts])
  const sortingUnavailable = !loadedSuccessfully
    || loading
    || saving
    || deleting
    || Boolean(normalizedQuery)
    || prompts.length < 2
  const sortingDisabled = sortingUnavailable || reordering

  const showNotice = useCallback((message: string) => {
    setNotice(message)
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => setNotice(''), 2200)
  }, [])

  const persistPromptOrder = useCallback(async (previous: PromptRecord[], next: PromptRecord[]) => {
    if (reorderInFlightRef.current || promptOrderMatches(previous, next)) return
    reorderInFlightRef.current = true
    setReordering(true)
    setError('')
    try {
      const library = await reorderPrompts(
        token,
        next.map(prompt => prompt.id),
        previous.map(prompt => prompt.id),
      )
      setPrompts(library.prompts)
      showNotice(t('promptLibrary.reorderSaved'))
    } catch (reorderError) {
      if (reorderError instanceof PromptLibraryRequestError && reorderError.status === 409) {
        try {
          const library = await listPrompts(token)
          setPrompts(library.prompts)
          setError(t('promptLibrary.reorderConflict'))
        } catch {
          setPrompts(previous)
          setError(t('promptLibrary.reorderFailed'))
        }
      } else {
        setPrompts(previous)
        setError(t('promptLibrary.reorderFailed'))
      }
    } finally {
      reorderInFlightRef.current = false
      setReordering(false)
    }
  }, [showNotice, t, token])

  const cancelActiveDrag = useCallback(() => {
    const drag = dragRef.current
    if (!drag) return false
    dragRef.current = null
    if (drag.handle.hasPointerCapture(drag.pointerId)) {
      drag.handle.releasePointerCapture(drag.pointerId)
    }
    setPrompts(drag.baseline)
    setDraggingId(null)
    setDragOverId(null)
    setDragPreview(null)
    return true
  }, [])

  const applySelection = useCallback((prompt: PromptRecord | null) => {
    setSelectedId(prompt?.id ?? null)
    setCreatingNew(false)
    setDraft(prompt ? { title: prompt.title, content: prompt.content } : EMPTY_DRAFT)
  }, [])

  const loadLibrary = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError('')
    try {
      const library = await listPrompts(token, signal)
      setPrompts(library.prompts)
      setLoadedSuccessfully(true)
      applySelection(library.prompts[0] ?? null)
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === 'AbortError') return
      setLoadedSuccessfully(false)
      setError(loadError instanceof Error ? loadError.message : t('promptLibrary.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [applySelection, t, token])

  useEffect(() => {
    const controller = new AbortController()
    void loadLibrary(controller.signal)
    return () => {
      controller.abort()
      const drag = dragRef.current
      if (drag?.handle.hasPointerCapture(drag.pointerId)) {
        drag.handle.releasePointerCapture(drag.pointerId)
      }
      dragRef.current = null
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    }
  }, [loadLibrary])

  const confirmDiscard = useCallback(() => (
    !dirty || window.confirm(t('promptLibrary.unsavedConfirm'))
  ), [dirty, t])

  const handleClose = useCallback(() => {
    if (cancelActiveDrag() || saving || deleting || reordering || !confirmDiscard()) return
    onClose()
  }, [cancelActiveDrag, confirmDiscard, deleting, onClose, reordering, saving])

  const handleSave = useCallback(async () => {
    if (reordering || dragRef.current) return
    const title = draft.title.trim()
    if (!title) {
      setError(t('promptLibrary.titleRequired'))
      titleInputRef.current?.focus()
      return
    }
    if (!draft.content.trim()) {
      setError(t('promptLibrary.contentRequired'))
      return
    }
    if (title.length > MAX_PROMPT_TITLE_CHARS || draft.content.length > MAX_PROMPT_CONTENT_CHARS) {
      setError(t('promptLibrary.tooLong'))
      return
    }

    setSaving(true)
    setError('')
    try {
      const saved = creatingNew
        ? await createPrompt(token, { title, content: draft.content })
        : await updatePrompt(token, selectedId!, { title, content: draft.content })
      setPrompts(current => creatingNew
        ? [saved, ...current]
        : current.map(prompt => prompt.id === saved.id ? saved : prompt))
      applySelection(saved)
      showNotice(t('common.saved'))
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('promptLibrary.saveFailed'))
    } finally {
      setSaving(false)
    }
  }, [applySelection, creatingNew, draft, reordering, selectedId, showNotice, t, token])

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && cancelActiveDrag()) {
        event.preventDefault()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 's') {
        event.preventDefault()
        if (!saving && !reordering && !dragRef.current && (creatingNew || selectedPrompt)) void handleSave()
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        handleClose()
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [cancelActiveDrag, creatingNew, handleClose, handleSave, reordering, saving, selectedPrompt])

  function handleSelect(prompt: PromptRecord) {
    if (prompt.id === selectedId && !creatingNew) {
      setMobileView('editor')
      return
    }
    if (!confirmDiscard()) return
    applySelection(prompt)
    setError('')
    setMobileView('editor')
  }

  function handleNew() {
    if (!loadedSuccessfully || reordering || dragRef.current || !confirmDiscard()) return
    setSelectedId(null)
    setCreatingNew(true)
    setDraft(EMPTY_DRAFT)
    setError('')
    setMobileView('editor')
    window.setTimeout(() => titleInputRef.current?.focus(), 0)
  }

  function handleBackToList() {
    if (!confirmDiscard()) return
    if (creatingNew) applySelection(prompts[0] ?? null)
    else if (selectedPrompt) setDraft({ title: selectedPrompt.title, content: selectedPrompt.content })
    setError('')
    setMobileView('list')
  }

  function handlePromptPointerDown(event: ReactPointerEvent<HTMLButtonElement>, prompt: PromptRecord) {
    if (sortingDisabled || reorderInFlightRef.current || event.button !== 0) return
    const card = event.currentTarget.closest<HTMLElement>('[data-prompt-id]')
    if (!card) return
    const bounds = card.getBoundingClientRect()
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      promptId: prompt.id,
      handle: event.currentTarget,
      baseline: prompts,
      current: prompts,
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top,
    }
    setDraggingId(prompt.id)
    setDragOverId(prompt.id)
    setDragPreview({
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
      prompt,
      orderedIds: prompts.map(item => item.id),
    })
    setError('')
  }

  function handlePromptPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()

    const list = promptListRef.current
    if (list) {
      const bounds = list.getBoundingClientRect()
      const edge = Math.min(56, bounds.height / 4)
      if (event.clientY < bounds.top + edge) list.scrollBy({ top: -14 })
      else if (event.clientY > bounds.bottom - edge) list.scrollBy({ top: 14 })
    }

    const cards = list
      ? [...list.querySelectorAll<HTMLElement>('[data-prompt-id]')]
      : []
    const target = cards.reduce<HTMLElement | null>((closest, card) => {
      if (!closest) return card
      const cardBounds = card.getBoundingClientRect()
      const closestBounds = closest.getBoundingClientRect()
      const cardDistance = Math.abs(event.clientY - (cardBounds.top + cardBounds.height / 2))
      const closestDistance = Math.abs(event.clientY - (closestBounds.top + closestBounds.height / 2))
      return cardDistance < closestDistance ? card : closest
    }, null)
    const targetId = target?.dataset.promptId
    if (!targetId) return
    const targetIndex = drag.current.findIndex(prompt => prompt.id === targetId)
    if (targetIndex < 0) return
    const next = movePromptToIndex(drag.current, drag.promptId, targetIndex)
    setDragOverId(targetId)
    if (next !== drag.current) drag.current = next
    setDragPreview(current => current ? {
      ...current,
      left: Math.min(
        Math.max(8, event.clientX - drag.offsetX),
        Math.max(8, window.innerWidth - current.width - 8),
      ),
      top: event.clientY - drag.offsetY,
      orderedIds: drag.current.map(item => item.id),
    } : current)
  }

  function handlePromptPointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setDraggingId(null)
    setDragOverId(null)
    setDragPreview(null)
    setPrompts(drag.current)
    void persistPromptOrder(drag.baseline, drag.current)
  }

  function handlePromptPointerCancel(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    cancelActiveDrag()
  }

  function handlePromptReorderKey(event: ReactKeyboardEvent<HTMLButtonElement>, prompt: PromptRecord) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    event.stopPropagation()
    if (sortingDisabled || reorderInFlightRef.current) return
    const sourceIndex = prompts.findIndex(item => item.id === prompt.id)
    if (sourceIndex < 0) return
    const targetIndex = event.key === 'ArrowUp' ? sourceIndex - 1 : sourceIndex + 1
    if (targetIndex < 0 || targetIndex >= prompts.length) return
    const previous = prompts
    const next = movePromptToIndex(previous, prompt.id, targetIndex)
    setPrompts(next)
    void persistPromptOrder(previous, next)
  }

  async function deletePromptRecord(prompt: PromptRecord, returnToList: boolean) {
    if (reordering || dragRef.current) return
    if (!window.confirm(t('promptLibrary.deleteConfirm', { title: prompt.title }))) return
    setDeleting(true)
    setError('')
    try {
      await deletePrompt(token, prompt.id)
      const remaining = prompts.filter(item => item.id !== prompt.id)
      setPrompts(remaining)
      if (selectedId === prompt.id) applySelection(remaining[0] ?? null)
      if (returnToList) setMobileView('list')
      showNotice(t('promptLibrary.deleted'))
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : t('promptLibrary.deleteFailed'))
    } finally {
      setDeleting(false)
    }
  }

  async function handleDelete() {
    if (reordering || dragRef.current) return
    if (creatingNew) {
      if (!confirmDiscard()) return
      applySelection(prompts[0] ?? null)
      setMobileView('list')
      return
    }
    if (selectedPrompt) await deletePromptRecord(selectedPrompt, true)
  }

  async function copyPromptContent(content: string) {
    if (!content) return
    let copied = false
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(content)
        copied = true
      } catch {
        // Fall back to the legacy selection path below.
      }
    }
    if (!copied) {
      const textarea = document.createElement('textarea')
      textarea.value = content
      textarea.style.cssText = 'position:fixed;left:-9999px;opacity:0;'
      document.body.appendChild(textarea)
      textarea.select()
      textarea.setSelectionRange(0, content.length)
      copied = document.execCommand('copy')
      document.body.removeChild(textarea)
    }
    if (copied) {
      setError('')
      showNotice(t('common.copied'))
    } else {
      setError(t('promptLibrary.copyFailed'))
    }
  }

  function insertCurrentPrompt() {
    if (!draft.content.trim()) {
      setError(t('promptLibrary.contentRequired'))
      return
    }
    if (!onInsertToTerminal(draft.content)) {
      setError(t('promptLibrary.terminalUnavailable'))
      return
    }
    if (dirty) {
      showNotice(t('promptLibrary.insertedUnsaved'))
      return
    }
    onClose()
  }

  function formatUpdatedAt(value: string) {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value
    return new Intl.DateTimeFormat(i18n.language, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(date)
  }

  const hasEditor = creatingNew || selectedPrompt
  const feedbackError = Boolean(error && loadedSuccessfully)

  return (
    <div className="fixed inset-0 z-[460] flex items-center justify-center bg-black/70 md:p-5">
      <GhostShield />
      <div
        className="relative flex h-full w-full flex-col overflow-hidden bg-nexus-bg text-nexus-text md:h-[min(760px,calc(100dvh-40px))] md:max-w-[980px] md:rounded-xl md:border md:border-nexus-border md:shadow-[0_20px_60px_rgba(0,0,0,0.5)]"
        role="dialog"
        aria-modal="true"
        aria-label={t('promptLibrary.title')}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-nexus-border px-4 py-3.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <Icon name="clipboard" size={19} />
            <h1 className="truncate text-base font-semibold">{t('promptLibrary.title')}</h1>
            <span className="rounded-[10px] bg-nexus-bg-2 px-2 py-0.5 text-[13px] text-nexus-muted">
              {prompts.length}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleNew}
              disabled={!loadedSuccessfully || saving || deleting || reordering}
              aria-label={t('promptLibrary.new')}
              className="flex items-center gap-1.5 rounded-md bg-nexus-accent px-2.5 py-1.5 text-sm font-medium text-white transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon name="plus" size={15} />
              <span className="hidden sm:inline">{t('promptLibrary.new')}</span>
            </button>
            <button
              type="button"
              onClick={handleClose}
              disabled={reordering}
              className="flex h-8 w-8 items-center justify-center bg-transparent text-nexus-text-2 transition-colors hover:text-nexus-text disabled:opacity-40"
              aria-label={t('common.close')}
            >
              <Icon name="x" size={20} />
            </button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <aside className={`${mobileView === 'editor' ? 'hidden md:flex' : 'flex'} w-full shrink-0 flex-col bg-nexus-bg md:w-[330px] md:border-r md:border-nexus-border`}>
            <div className="shrink-0 border-b border-nexus-border p-3">
              <label className="relative block">
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-nexus-muted">
                  <Icon name="message" size={15} />
                </span>
                <input
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  placeholder={t('promptLibrary.searchPlaceholder')}
                  className="h-9 w-full rounded-md border border-nexus-border bg-nexus-bg-2 pl-9 pr-3 text-sm text-nexus-text outline-none transition-colors placeholder:text-nexus-muted focus:border-nexus-accent"
                />
              </label>
            </div>

            <div ref={promptListRef} className="min-h-0 flex-1 overflow-y-auto p-2">
              {loading ? (
                <div className="flex h-full items-center justify-center gap-2 text-sm text-nexus-muted">
                  <Icon name="refresh" size={18} className="animate-spin" />
                  {t('common.loading')}
                </div>
              ) : !loadedSuccessfully ? (
                <div className="m-2 rounded-lg border border-nexus-error/40 bg-nexus-bg-2 p-4">
                  <div className="mb-2 flex items-center gap-2 text-sm font-medium text-nexus-error">
                    <Icon name="alert" size={16} />
                    {t('promptLibrary.loadFailed')}
                  </div>
                  <p className="mb-3 break-words text-xs leading-5 text-nexus-text-2">{error}</p>
                  <button
                    type="button"
                    onClick={() => void loadLibrary()}
                    className="rounded-md border border-nexus-border bg-transparent px-3 py-1.5 text-xs text-nexus-text"
                  >
                    {t('common.refresh')}
                  </button>
                </div>
              ) : filteredPrompts.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center px-8 text-center">
                  <Icon name="clipboard" size={28} className="mb-3 text-nexus-muted" />
                  <p className="text-sm font-medium text-nexus-text">
                    {query ? t('promptLibrary.noResults') : t('promptLibrary.empty')}
                  </p>
                  <p className="mt-1 max-w-56 text-xs leading-5 text-nexus-text-2">
                    {query ? t('promptLibrary.tryAnotherSearch') : t('promptLibrary.emptyHint')}
                  </p>
                  {!query && (
                    <button
                      type="button"
                      onClick={handleNew}
                      className="mt-4 rounded-md bg-nexus-accent px-3 py-2 text-xs font-medium text-white"
                    >
                      {t('promptLibrary.createFirst')}
                    </button>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {filteredPrompts.map(prompt => {
                    const active = prompt.id === selectedId && !creatingNew
                    const isDragging = draggingId === prompt.id
                    const visualOrder = dragPreview?.orderedIds.indexOf(prompt.id)
                    return (
                      <div
                        key={prompt.id}
                        data-prompt-id={prompt.id}
                        data-testid={isDragging ? 'prompt-drag-placeholder' : 'prompt-card'}
                        style={visualOrder === undefined || visualOrder < 0 ? undefined : { order: visualOrder }}
                        className={`relative overflow-hidden rounded-lg border transition-[border-color,background-color,box-shadow] ${isDragging
                          ? 'border-2 border-dashed border-nexus-accent/70 bg-nexus-accent/5 shadow-[inset_0_0_0_1px_rgba(59,130,246,0.08)]'
                          : dragOverId === prompt.id && draggingId
                            ? 'border-nexus-accent bg-nexus-accent/10 ring-1 ring-inset ring-nexus-accent'
                            : active
                          ? 'border-nexus-accent/60 bg-nexus-accent/10'
                          : 'border-nexus-border bg-nexus-bg-2 hover:border-nexus-text-2/50'
                        }`}
                      >
                        <button
                          type="button"
                          data-testid="prompt-drag-handle"
                          onPointerDown={event => handlePromptPointerDown(event, prompt)}
                          onPointerMove={handlePromptPointerMove}
                          onPointerUp={handlePromptPointerUp}
                          onPointerCancel={handlePromptPointerCancel}
                          onLostPointerCapture={handlePromptPointerCancel}
                          onKeyDown={event => handlePromptReorderKey(event, prompt)}
                          onClick={event => {
                            event.preventDefault()
                            event.stopPropagation()
                          }}
                          disabled={sortingUnavailable}
                          aria-disabled={sortingDisabled}
                          aria-label={normalizedQuery
                            ? t('promptLibrary.reorderSearchDisabled')
                            : t('promptLibrary.reorderPrompt', { title: prompt.title })}
                          title={normalizedQuery
                            ? t('promptLibrary.reorderSearchDisabled')
                            : t('promptLibrary.reorderPrompt', { title: prompt.title })}
                          className={`absolute left-0.5 top-0.5 z-10 flex h-11 w-11 touch-none items-center justify-center rounded-md text-nexus-muted transition-colors hover:bg-nexus-bg hover:text-nexus-text active:cursor-grabbing aria-disabled:cursor-not-allowed aria-disabled:opacity-35 enabled:cursor-grab md:left-1.5 md:top-1.5 md:h-8 md:w-8 ${isDragging ? 'opacity-0' : ''}`}
                        >
                          <Icon name="grip" size={16} />
                        </button>
                        <button
                          type="button"
                          data-testid="prompt-open-button"
                          onClick={() => handleSelect(prompt)}
                          className={`relative block w-full py-2.5 pl-12 pr-3 text-left md:pl-11 ${isDragging ? 'opacity-0' : ''}`}
                        >
                          <div data-testid="prompt-card-title" className="truncate pr-5 text-sm font-medium text-nexus-text">{prompt.title}</div>
                          <div className="mt-1 line-clamp-2 text-xs leading-5 text-nexus-text-2">
                            {prompt.content.replace(/\s+/g, ' ')}
                          </div>
                          <div className="mt-1.5 text-[10px] text-nexus-muted">
                            {formatUpdatedAt(prompt.updatedAt)}
                          </div>
                          <span className="absolute right-3 top-3 text-nexus-muted">
                            <Icon name="arrowRight" size={13} />
                          </span>
                        </button>
                        <div className={`grid grid-cols-2 border-t border-nexus-border/80 ${isDragging ? 'opacity-0' : ''}`}>
                          <button
                            type="button"
                            onClick={() => void copyPromptContent(prompt.content)}
                            disabled={deleting || reordering}
                            aria-label={t('promptLibrary.copyPrompt', { title: prompt.title })}
                            className="flex h-9 items-center justify-center gap-1.5 border-r border-nexus-border/80 text-xs text-nexus-text-2 transition-colors hover:bg-nexus-bg hover:text-nexus-text disabled:opacity-40"
                          >
                            <Icon name="copy" size={14} />
                            {t('common.copy')}
                          </button>
                          <button
                            type="button"
                            onClick={() => void deletePromptRecord(prompt, false)}
                            disabled={deleting || reordering}
                            aria-label={t('promptLibrary.deletePrompt', { title: prompt.title })}
                            className="flex h-9 items-center justify-center gap-1.5 text-xs text-nexus-text-2 transition-colors hover:bg-nexus-error/10 hover:text-nexus-error disabled:opacity-40"
                          >
                            <Icon name="trash" size={14} />
                            {t('common.delete')}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
            <div className="shrink-0 border-t border-nexus-border px-3 py-2 text-xs text-nexus-muted">
              {reordering
                ? t('promptLibrary.reordering')
                : normalizedQuery
                  ? t('promptLibrary.reorderSearchDisabled')
                  : t('promptLibrary.count', { count: filteredPrompts.length })}
            </div>
          </aside>

          <main className={`${mobileView === 'list' ? 'hidden md:flex' : 'flex'} min-w-0 flex-1 flex-col bg-nexus-bg`}>
            {!hasEditor ? (
              <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                <Icon name="clipboard" size={30} className="mb-3 text-nexus-muted" />
                <p className="text-sm font-medium">{t('promptLibrary.selectPrompt')}</p>
                <p className="mt-1 max-w-sm text-xs leading-5 text-nexus-text-2">{t('promptLibrary.selectPromptHint')}</p>
                <button
                  type="button"
                  onClick={handleNew}
                  className="mt-4 rounded-md bg-nexus-accent px-3 py-2 text-sm font-medium text-white"
                >
                  {t('promptLibrary.new')}
                </button>
              </div>
            ) : (
              <>
                <div className="flex shrink-0 items-center gap-3 border-b border-nexus-border px-4 py-3">
                  <button
                    type="button"
                    onClick={handleBackToList}
                    className="flex h-8 w-8 items-center justify-center rounded-md border border-nexus-border text-nexus-text-2 md:hidden"
                    aria-label={t('promptLibrary.backToList')}
                  >
                    <Icon name="arrowLeft" size={16} />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-xs text-nexus-text-2">
                      <span className={`h-1.5 w-1.5 rounded-full ${dirty ? 'bg-nexus-warning' : 'bg-nexus-success'}`} />
                      {creatingNew ? t('promptLibrary.newDraft') : dirty ? t('promptLibrary.unsaved') : t('common.saved')}
                    </div>
                    {!creatingNew && selectedPrompt && (
                      <div className="mt-0.5 text-[10px] text-nexus-muted">
                        {t('promptLibrary.updatedAt', { time: formatUpdatedAt(selectedPrompt.updatedAt) })}
                      </div>
                    )}
                  </div>
                  <span className="hidden text-[10px] text-nexus-muted sm:inline">Ctrl / ⌘ + S</span>
                </div>

                <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
                  <div>
                    <label htmlFor="prompt-library-title" className="mb-1.5 block text-xs text-nexus-text-2">
                      {t('promptLibrary.promptTitle')}
                    </label>
                    <input
                      id="prompt-library-title"
                      ref={titleInputRef}
                      value={draft.title}
                      onChange={event => setDraft(current => ({ ...current, title: event.target.value }))}
                      maxLength={MAX_PROMPT_TITLE_CHARS}
                      placeholder={t('promptLibrary.titlePlaceholder')}
                      className="h-10 w-full rounded-md border border-nexus-border bg-nexus-bg-2 px-3 text-sm text-nexus-text outline-none transition-colors placeholder:text-nexus-muted focus:border-nexus-accent"
                    />
                  </div>
                  <div className="flex min-h-[280px] flex-1 flex-col">
                    <div className="mb-1.5 flex items-center justify-between">
                      <label htmlFor="prompt-library-content" className="text-xs text-nexus-text-2">
                        {t('promptLibrary.content')}
                      </label>
                      <span className="text-[10px] text-nexus-muted">
                        {draft.content.length.toLocaleString()} / {MAX_PROMPT_CONTENT_CHARS.toLocaleString()}
                      </span>
                    </div>
                    <textarea
                      id="prompt-library-content"
                      value={draft.content}
                      onChange={event => setDraft(current => ({ ...current, content: event.target.value }))}
                      maxLength={MAX_PROMPT_CONTENT_CHARS}
                      placeholder={t('promptLibrary.contentPlaceholder')}
                      spellCheck={false}
                      className="min-h-[260px] flex-1 resize-none rounded-md border border-nexus-border bg-nexus-bg-2 p-3 font-mono text-[13px] leading-6 text-nexus-text outline-none transition-colors placeholder:text-nexus-muted focus:border-nexus-accent"
                    />
                  </div>
                </div>

                <div className="grid shrink-0 grid-cols-2 gap-2 border-t border-nexus-border p-3 sm:flex sm:items-center sm:px-4">
                  <button
                    type="button"
                    onClick={() => void handleDelete()}
                    disabled={saving || deleting || reordering}
                    className="flex h-9 items-center justify-center gap-1.5 rounded-md border border-nexus-border bg-transparent px-3 text-sm text-nexus-error transition-colors hover:bg-nexus-error/10 disabled:opacity-40 sm:mr-auto"
                  >
                    <Icon name="trash" size={15} />
                    {deleting ? t('promptLibrary.deleting') : t('common.delete')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void copyPromptContent(draft.content)}
                    disabled={!draft.content}
                    className="flex h-9 items-center justify-center gap-1.5 rounded-md border border-nexus-border bg-transparent px-3 text-sm text-nexus-text-2 transition-colors hover:bg-nexus-bg-2 disabled:opacity-40"
                  >
                    <Icon name="copy" size={15} />
                    {t('common.copy')}
                  </button>
                  <button
                    type="button"
                    onClick={insertCurrentPrompt}
                    disabled={!draft.content.trim()}
                    className="flex h-9 items-center justify-center gap-1.5 rounded-md border border-nexus-border bg-transparent px-3 text-sm text-nexus-text transition-colors hover:bg-nexus-bg-2 disabled:opacity-40"
                  >
                    <Icon name="message" size={15} />
                    {t('promptLibrary.insertTerminal')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSave()}
                    disabled={saving || deleting || reordering || (!dirty && !creatingNew)}
                    className="flex h-9 items-center justify-center gap-1.5 rounded-md bg-nexus-accent px-4 text-sm font-medium text-white transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:bg-nexus-bg-2 disabled:text-nexus-muted"
                  >
                    <Icon name="save" size={15} />
                    {saving ? t('common.saving') : t('common.save')}
                  </button>
                </div>
              </>
            )}
          </main>
        </div>

        {(notice || feedbackError) && (
          <div
            className={`absolute bottom-4 left-1/2 z-10 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 rounded-lg border bg-nexus-bg px-3 py-2 text-xs shadow-lg ${feedbackError
              ? 'border-nexus-error/50 text-nexus-error'
              : 'border-nexus-success/50 text-nexus-success'
            }`}
            role={feedbackError ? 'alert' : 'status'}
          >
            <Icon name={feedbackError ? 'alert' : 'check'} size={14} />
            <span className="break-words">{feedbackError ? error : notice}</span>
          </div>
        )}
      </div>
      {dragPreview && (
        <div
          data-testid="prompt-drag-ghost"
          aria-hidden="true"
          className="pointer-events-none fixed z-20 overflow-hidden rounded-lg border border-nexus-accent/80 bg-nexus-bg-2 shadow-[0_18px_38px_rgba(0,0,0,0.48),0_0_0_1px_rgba(59,130,246,0.16)]"
          style={{
            left: dragPreview.left,
            top: dragPreview.top,
            width: dragPreview.width,
            minHeight: dragPreview.height,
            transform: 'scale(1.015) rotate(-0.35deg)',
            transformOrigin: '22px 22px',
          }}
        >
          <div className="relative py-2.5 pl-12 pr-3 text-left md:pl-11">
            <span className="absolute left-0.5 top-0.5 flex h-11 w-11 items-center justify-center text-nexus-accent md:left-1.5 md:top-1.5 md:h-8 md:w-8">
              <Icon name="grip" size={16} />
            </span>
            <div className="truncate pr-5 text-sm font-medium text-nexus-text">{dragPreview.prompt.title}</div>
            <div className="mt-1 line-clamp-2 text-xs leading-5 text-nexus-text-2">
              {dragPreview.prompt.content.replace(/\s+/g, ' ')}
            </div>
            <div className="mt-1.5 text-[10px] text-nexus-muted">
              {formatUpdatedAt(dragPreview.prompt.updatedAt)}
            </div>
          </div>
          <div className="h-9 border-t border-nexus-border/80 bg-nexus-accent/5" />
        </div>
      )}
    </div>
  )
}
