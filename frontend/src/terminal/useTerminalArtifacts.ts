import { useCallback, useEffect, useRef, useState, type ChangeEvent, type MutableRefObject, type UIEvent } from 'react'
import type { Terminal as XTerm } from '@xterm/xterm'
import type { UploadNotification } from './UploadNotifications'
import { MOBILE_SCROLLBACK_INITIAL_BOTTOM_OFFSET_PX } from './ScrollbackOverlay'
import { normalizeTerminalScrollbackText, TERMINAL_SCROLLBACK_COPY_LINES } from './terminalClipboard'

const MAX_UPLOAD_NOTIFICATIONS = 5

interface UseTerminalArtifactsArgs {
  activeTmuxSessionRef: MutableRefObject<string>
  activeWindowIndexRef: MutableRefObject<number>
  onUploadComplete?: (path: string, filename: string) => void
  termRef: MutableRefObject<XTerm | null>
  token: string
}

export function useTerminalArtifacts({
  activeTmuxSessionRef,
  activeWindowIndexRef,
  onUploadComplete,
  termRef,
  token,
}: UseTerminalArtifactsArgs) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const scrollbackOverlayRef = useRef<HTMLDivElement>(null)
  const triggerScrollbackRef = useRef<() => void>(() => {})
  const showScrollbackRef = useRef(false)
  const uploadFileRef = useRef<(file: File) => Promise<void>>(async () => {})
  const [showScrollback, setShowScrollback] = useState(false)
  const [scrollbackContent, setScrollbackContent] = useState('')
  const [scrollbackLoading, setScrollbackLoading] = useState(false)
  const [uploadNotifications, setUploadNotifications] = useState<UploadNotification[]>([])
  const [uploadConflict, setUploadConflict] = useState<{ show: boolean; file: File | null; filename: string }>({
    show: false,
    file: null,
    filename: '',
  })

  const addUploadNotification = useCallback((filename: string, path: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    setUploadNotifications((prev) => {
      const next = [{ id, filename, path }, ...prev]
      return next.slice(0, MAX_UPLOAD_NOTIFICATIONS)
    })
  }, [])

  const removeUploadNotification = useCallback((id: string) => {
    setUploadNotifications((prev) => prev.filter((notification) => notification.id !== id))
  }, [])

  const uploadFile = useCallback(async (file: File, overwrite = false) => {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('originalName', file.name)

    try {
      const url = overwrite ? '/api/files/upload?overwrite=1' : '/api/files/upload'
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      })

      if (response.status === 409) {
        const data = await response.json()
        setUploadConflict({ show: true, file, filename: data.filename || file.name })
        return
      }

      if (!response.ok) throw new Error(await response.text())

      const data = await response.json()
      const fullPath = data.fullPath || data.url || ''
      const filename = data.originalName || data.filename || file.name
      if (!fullPath) console.warn('[Nexus] Upload response missing fullPath:', data)
      addUploadNotification(filename, fullPath)
      if (fullPath) onUploadComplete?.(fullPath, filename)

      if (!fullPath) {
        termRef.current?.writeln(`\r\n\x1b[32m[Nexus: 文件已上传]\x1b[0m ${filename}`)
      }
    } catch (error: any) {
      console.error('Upload failed:', error)
      const term = termRef.current
      if (term) {
        term.writeln(`\r\n\x1b[31m[Nexus: 上传失败]\x1b[0m ${error.message || 'unknown error'}`)
      }
    }
  }, [addUploadNotification, onUploadComplete, termRef, token])

  const handleFileUpload = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleFileInputChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) void uploadFile(file)
    event.target.value = ''
  }, [uploadFile])

  function handleOverwriteConfirm() {
    if (!uploadConflict.file) return
    void uploadFile(uploadConflict.file, true)
    setUploadConflict({ show: false, file: null, filename: '' })
  }

  function handleOverwriteCancel() {
    setUploadConflict({ show: false, file: null, filename: '' })
    const term = termRef.current
    if (term) {
      term.writeln(`\r\n\x1b[33m[Nexus: 上传已取消]\x1b[0m ${uploadConflict.filename}`)
    }
  }

  uploadFileRef.current = uploadFile

  useEffect(() => {
    function handlePaste(event: ClipboardEvent) {
      const target = event.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
      const items = event.clipboardData?.items
      if (!items) return

      for (let index = 0; index < items.length; index += 1) {
        const item = items[index]
        if (item.kind === 'file') {
          event.preventDefault()
          const file = item.getAsFile()
          if (file) uploadFileRef.current(file)
          return
        }
      }
    }

    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [])

  const closeScrollback = useCallback(() => {
    showScrollbackRef.current = false
    setShowScrollback(false)
    setScrollbackContent('')
  }, [])

  const handleOverlayScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30
    if (atBottom) {
      closeScrollback()
    }
  }, [closeScrollback])

  const fetchScrollback = useCallback(() => {
    if (showScrollbackRef.current) return

    showScrollbackRef.current = true
    setShowScrollback(true)
    setScrollbackLoading(true)

    const windowIndex = activeWindowIndexRef.current
    const session = activeTmuxSessionRef.current
    fetch(`/api/sessions/${windowIndex}/scrollback?session=${encodeURIComponent(session)}&lines=${TERMINAL_SCROLLBACK_COPY_LINES}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((response) => response.ok ? response.json() : Promise.reject(response.status))
      .then(({ content }: { content: string }) => {
        setScrollbackContent(normalizeTerminalScrollbackText(content.trimEnd(), { columns: termRef.current?.cols }))
        setScrollbackLoading(false)
      })
      .catch((error: unknown) => {
        console.error('[Terminal] Failed to load scrollback', {
          error,
          session,
          windowIndex,
        })
        setScrollbackContent('(加载失败)')
        setScrollbackLoading(false)
      })
  }, [activeTmuxSessionRef, activeWindowIndexRef, token])

  useEffect(() => {
    if (!scrollbackContent || !scrollbackOverlayRef.current) return
    const el = scrollbackOverlayRef.current
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - MOBILE_SCROLLBACK_INITIAL_BOTTOM_OFFSET_PX)
  }, [scrollbackContent])

  triggerScrollbackRef.current = fetchScrollback

  const scrollbackTheme = termRef.current?.options.theme ?? {}
  const scrollbackBackground = String((scrollbackTheme as Record<string, unknown>).background ?? '#1a1a2e')
  const scrollbackForeground = String((scrollbackTheme as Record<string, unknown>).foreground ?? '#e2e8f0')
  const scrollbackFontSize = termRef.current?.options.fontSize ?? 14
  const scrollbackFontFamily = termRef.current?.options.fontFamily ?? 'Menlo, Monaco, monospace'
  const scrollbackMuted = String((scrollbackTheme as Record<string, unknown>).brightBlack ?? '#4a5568')

  return {
    closeScrollback,
    fetchScrollback,
    fileInputRef,
    handleFileInputChange,
    handleFileUpload,
    handleOverlayScroll,
    handleOverwriteCancel,
    handleOverwriteConfirm,
    removeUploadNotification,
    scrollbackBackground,
    scrollbackContent,
    scrollbackFontFamily,
    scrollbackFontSize,
    scrollbackForeground,
    scrollbackLoading,
    scrollbackMuted,
    scrollbackOverlayRef,
    showScrollback,
    showScrollbackRef,
    triggerScrollbackRef,
    uploadConflict,
    uploadFile,
    uploadFileRef,
    uploadNotifications,
  }
}
