import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react'
import type { ChangeEvent, CompositionEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { THEMES, getInitialTheme } from './theme'
import type { TmuxWindow } from './useTerminalSessions'

const FONT_SIZE_KEY = 'nexus_font_size'
const TAP_THRESHOLD = 8

interface UseTerminalRuntimeArgs {
  activeTmuxSession: string
  activeTmuxSessionRef: MutableRefObject<string>
  activeWindowIndex: number
  activeWindowIndexRef: MutableRefObject<number>
  attachWindowFnRef: MutableRefObject<(index: number) => void>
  inputRef: RefObject<HTMLInputElement | null>
  isWidePC: boolean
  overlayOpen: boolean
  scrollPositionsRef: MutableRefObject<Record<number, number>>
  setToolbarCollapsed: Dispatch<SetStateAction<boolean | undefined>>
  showScrollbackRef: MutableRefObject<boolean>
  termRef: MutableRefObject<XTerm | null>
  token: string
  toolbarCollapsedRef: MutableRefObject<boolean | undefined>
  triggerScrollbackRef: MutableRefObject<() => void>
  uploadFileRef: MutableRefObject<(file: File) => Promise<void>>
  windowsLoaded: boolean
  windowsRef: MutableRefObject<TmuxWindow[]>
  wsSessionKey: string
}

export function useTerminalRuntime({
  activeTmuxSession,
  activeTmuxSessionRef,
  activeWindowIndex,
  activeWindowIndexRef,
  attachWindowFnRef,
  inputRef,
  isWidePC,
  overlayOpen,
  scrollPositionsRef,
  setToolbarCollapsed,
  showScrollbackRef,
  termRef,
  token,
  toolbarCollapsedRef,
  triggerScrollbackRef,
  uploadFileRef,
  windowsLoaded,
  windowsRef,
  wsSessionKey,
}: UseTerminalRuntimeArgs) {
  const containerRef = useRef<HTMLDivElement>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const userScrolledRef = useRef(false)
  const lastContainerSizeRef = useRef({ w: 0, h: 0 })
  const hasConnectedRef = useRef(false)
  const keyboardVisibleRef = useRef(false)
  const isComposingRef = useRef(false)
  const overlayOpenRef = useRef(overlayOpen)
  const [isConnecting, setIsConnecting] = useState(false)
  const [isScrolledUp, setIsScrolledUp] = useState(false)
  const [vvHeight, setVvHeight] = useState<number | null>(null)

  useEffect(() => {
    overlayOpenRef.current = overlayOpen
  }, [overlayOpen])

  const sendToWs = useCallback((data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data)
    }
  }, [])

  const fitNow = useCallback(() => {
    const term = termRef.current
    const fitAddon = fitAddonRef.current
    if (!term || !fitAddon) return

    const wasAtBottom = !userScrolledRef.current
    fitAddon.fit()
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    }
    if (wasAtBottom) {
      userScrolledRef.current = false
      term.scrollToBottom()
    }
  }, [])

  const scrollToBottom = useCallback(() => {
    termRef.current?.scrollToBottom()
    userScrolledRef.current = false
    setIsScrolledUp(false)
  }, [])

  const fitTerminal = useCallback(() => {
    const term = termRef.current
    const container = containerRef.current
    if (!term || !container) return

    const rect = container.getBoundingClientRect()
    lastContainerSizeRef.current = { w: rect.width, h: rect.height }

    window.setTimeout(() => {
      requestAnimationFrame(() => {
        if (!termRef.current) return
        fitNow()
      })
    }, 150)
  }, [fitNow])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let rafId: number | null = null
    let debounceTimer: number | null = null

    function doResize() {
      const term = termRef.current
      const containerEl = containerRef.current
      if (!term || !containerEl) return

      const rect = containerEl.getBoundingClientRect()
      const wDelta = Math.abs(rect.width - lastContainerSizeRef.current.w)
      const hDelta = Math.abs(rect.height - lastContainerSizeRef.current.h)
      if (wDelta < 2 && hDelta < 2) return

      lastContainerSizeRef.current = { w: rect.width, h: rect.height }

      if (rafId) cancelAnimationFrame(rafId)
      if (debounceTimer) window.clearTimeout(debounceTimer)

      debounceTimer = window.setTimeout(() => {
        rafId = requestAnimationFrame(() => {
          fitNow()
          rafId = null
        })
      }, 150)
    }

    const ro = new ResizeObserver(doResize)
    ro.observe(container)

    function onOrientationChange() {
      lastContainerSizeRef.current = { w: 0, h: 0 }
      window.setTimeout(doResize, 300)
    }

    function onVisibilityChange() {
      if (document.visibilityState === 'visible') fitNow()
    }

    function onPageShow() {
      fitNow()
    }

    window.addEventListener('orientationchange', onOrientationChange)
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pageshow', onPageShow)
    window.setTimeout(doResize, 100)

    return () => {
      ro.disconnect()
      window.removeEventListener('orientationchange', onOrientationChange)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pageshow', onPageShow)
      if (rafId) cancelAnimationFrame(rafId)
      if (debounceTimer) window.clearTimeout(debounceTimer)
    }
  }, [fitNow])

  useEffect(() => {
    const fontSize = parseInt(localStorage.getItem(FONT_SIZE_KEY) || '16', 10)
    const initialTheme = getInitialTheme()
    const term = new XTerm({
      theme: THEMES[initialTheme],
      fontSize,
      fontFamily: 'Menlo, Monaco, "Cascadia Code", "Fira Code", monospace',
      scrollback: 10000,
      cursorBlink: true,
      cursorInactiveStyle: 'block',
      allowProposedApi: true,
      screenReaderMode: true,
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)
    termRef.current = term
    fitAddonRef.current = fitAddon

    const maybeContainerEl = containerRef.current
    if (!maybeContainerEl) {
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
      return
    }
    const containerEl: HTMLDivElement = maybeContainerEl

    term.open(containerEl)
    requestAnimationFrame(() => fitAddon.fit())

    const xtermTextarea = term.textarea
    if (xtermTextarea && window.innerWidth < 1024) {
      xtermTextarea.inputMode = 'none'
      xtermTextarea.addEventListener('touchstart', (event: TouchEvent) => {
        if (!keyboardVisibleRef.current) event.preventDefault()
      }, { passive: false })
    }

    const viewport = containerEl.querySelector('.xterm-viewport') as HTMLElement | null
    if (viewport) {
      viewport.style.pointerEvents = 'auto'
      viewport.style.userSelect = 'text'
    }

    const screen = containerEl.querySelector('.xterm-screen') as HTMLElement | null
    if (screen) screen.style.userSelect = 'text'

    function onGlobalKeyDown(event: KeyboardEvent) {
      if (event.isComposing) return
      if (window.innerWidth < 768) return
      if (overlayOpenRef.current) return

      if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
        return
      }

      const clipboardMod = event.ctrlKey || event.metaKey
      const clipboardKey = event.key.toLowerCase()
      const noOtherMod = !event.shiftKey && !event.altKey

      if (clipboardMod && clipboardKey === 'c' && noOtherMod) {
        if (term.hasSelection()) {
          event.preventDefault()
          navigator.clipboard.writeText(term.getSelection()).catch((error: unknown) => {
            console.error('[Terminal] Failed to copy selected terminal text', error)
          })
          return
        }
        if (event.metaKey) return
      }

      if (clipboardMod && clipboardKey === 'v' && noOtherMod) {
        event.preventDefault()
        navigator.clipboard.readText().then((text) => {
          if (text && wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(text)
          }
        }).catch((error: unknown) => {
          console.error('[Terminal] Failed to read clipboard text', error)
        })
        return
      }

      const whitelist = [
        { ctrl: true, key: 'r' },
        { ctrl: true, key: 'l' },
        { ctrl: true, key: 't' },
        { ctrl: true, key: 'n' },
        { ctrl: true, key: 'w' },
        { ctrl: true, shift: true, key: 't' },
        { ctrl: true, shift: true, key: 'n' },
        { ctrl: true, key: 'tab' },
        { ctrl: true, shift: true, key: 'tab' },
      ]

      const isWhitelisted = whitelist.some((item) => {
        if (item.ctrl !== undefined && item.ctrl !== event.ctrlKey) return false
        if (item.shift !== undefined && item.shift !== event.shiftKey) return false
        return item.key.toLowerCase() === event.key.toLowerCase()
      })
      if (isWhitelisted) return

      event.preventDefault()

      let seq = ''
      if (event.ctrlKey && event.key.length === 1) {
        seq = String.fromCharCode(event.key.toLowerCase().charCodeAt(0) - 96)
      } else if (event.key === 'Enter') {
        seq = '\r'
      } else if (event.key === 'Tab') {
        seq = '\t'
      } else if (event.key === 'Backspace') {
        seq = '\x7f'
      } else if (event.key === 'Escape') {
        seq = '\x1b'
      } else if (event.key === 'ArrowUp') {
        seq = '\x1b[A'
      } else if (event.key === 'ArrowDown') {
        seq = '\x1b[B'
      } else if (event.key === 'ArrowRight') {
        seq = '\x1b[C'
      } else if (event.key === 'ArrowLeft') {
        seq = '\x1b[D'
      } else if (event.key === 'Home') {
        seq = '\x1b[H'
      } else if (event.key === 'End') {
        seq = '\x1b[F'
      } else if (event.key === 'PageUp') {
        seq = '\x1b[5~'
      } else if (event.key === 'PageDown') {
        seq = '\x1b[6~'
      } else if (event.key === 'Delete') {
        seq = '\x1b[3~'
      }

      if (seq && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(seq)
      }
    }

    window.addEventListener('keydown', onGlobalKeyDown, true)

    term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (window.innerWidth >= 768) {
        if (event.isComposing) return true
        if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) return true
        return false
      }
      if (event.ctrlKey && ['w', 't', 'n', 'l', 'r'].includes(event.key.toLowerCase())) {
        event.preventDefault()
        return true
      }
      return true
    })

    term.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(data)
      }
    })

    term.onScroll(() => {
      const buffer = (term as any).buffer?.active
      if (!buffer) return
      const scrolledUp = buffer.viewportY < buffer.baseY
      userScrolledRef.current = scrolledUp
      setIsScrolledUp(scrolledUp)
    })

    let touchStartX = 0
    let touchStartY = 0
    let touchLastY = 0
    let isPinching = false
    let pinchStartDist = 0
    let pinchStartFontSize = fontSize
    let swipeAxis: 'vertical' | 'horizontal' | null = null

    function getTouchDist(event: TouchEvent): number {
      const dx = event.touches[0].clientX - event.touches[1].clientX
      const dy = event.touches[0].clientY - event.touches[1].clientY
      return Math.sqrt(dx * dx + dy * dy)
    }

    function onTouchStart(event: TouchEvent) {
      if (event.touches.length === 2) {
        isPinching = true
        pinchStartDist = getTouchDist(event)
        pinchStartFontSize = parseInt(localStorage.getItem(FONT_SIZE_KEY) || '16', 10)
        return
      }

      isPinching = false
      touchStartX = event.touches[0].clientX
      touchStartY = event.touches[0].clientY
      touchLastY = event.touches[0].clientY
      swipeAxis = null
    }

    function onTouchMove(event: TouchEvent) {
      event.preventDefault()
      if (isPinching && event.touches.length === 2) {
        const dist = getTouchDist(event)
        const scale = dist / pinchStartDist
        const newSize = Math.round(Math.max(8, Math.min(32, pinchStartFontSize * scale)))
        if (newSize !== term.options.fontSize) {
          term.options.fontSize = newSize
          localStorage.setItem(FONT_SIZE_KEY, String(newSize))
          fitNow()
        }
        return
      }

      if (!swipeAxis) {
        const dx = Math.abs(event.touches[0].clientX - touchStartX)
        const dy = Math.abs(event.touches[0].clientY - touchStartY)
        if (dx > 8 || dy > 8) swipeAxis = dx > dy ? 'horizontal' : 'vertical'
      }

      if (swipeAxis === 'horizontal') return
      if (swipeAxis === 'vertical' && !showScrollbackRef.current) {
        const y = event.touches[0].clientY
        const deltaY = touchLastY - y
        touchLastY = y
        if (deltaY < 0) {
          if (Math.abs(deltaY) > 40) {
            triggerScrollbackRef.current()
          }
        }
      }
    }

    function onTouchEnd(event: TouchEvent) {
      if (isPinching) {
        isPinching = false
        return
      }

      const endX = event.changedTouches[0].clientX
      const endY = event.changedTouches[0].clientY
      const rect = containerEl.getBoundingClientRect()
      if (endX < rect.left || endX > rect.right || endY < rect.top || endY > rect.bottom) return

      const dx = endX - touchStartX
      const dy = endY - touchStartY
      if (swipeAxis === 'horizontal' && Math.abs(dx) > 60) {
        const wins = [...windowsRef.current].sort((a, b) => a.index - b.index)
        const pos = wins.findIndex((window) => window.index === activeWindowIndexRef.current)
        if (dx < 0 && pos < wins.length - 1) {
          attachWindowFnRef.current(wins[pos + 1].index)
        } else if (dx > 0 && pos > 0) {
          attachWindowFnRef.current(wins[pos - 1].index)
        }
        return
      }

      if (Math.abs(dy) >= TAP_THRESHOLD || Math.abs(dx) >= TAP_THRESHOLD) return

      const xtermTa = termRef.current?.textarea
      if (toolbarCollapsedRef.current === false) {
        setToolbarCollapsed(true)
        if (keyboardVisibleRef.current) {
          keyboardVisibleRef.current = false
          if (inputRef.current) {
            inputRef.current.inputMode = 'none'
            inputRef.current.blur()
          }
          if (xtermTa) {
            xtermTa.inputMode = 'none'
            xtermTa.blur()
          }
        }
        return
      }

      if (keyboardVisibleRef.current) {
        keyboardVisibleRef.current = false
        if (inputRef.current) {
          inputRef.current.inputMode = 'none'
          inputRef.current.blur()
        }
        if (xtermTa) {
          xtermTa.inputMode = 'none'
          xtermTa.blur()
        }
        return
      }

      keyboardVisibleRef.current = true
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
      if (isIOS) {
        if (xtermTa) xtermTa.inputMode = 'none'
        if (inputRef.current) {
          inputRef.current.inputMode = 'text'
          inputRef.current.focus()
        }
        return
      }

      if (xtermTa) {
        xtermTa.inputMode = 'text'
        xtermTa.focus()
      }
      if (inputRef.current) inputRef.current.inputMode = 'text'
    }

    containerEl.addEventListener('touchstart', onTouchStart, { passive: true })
    containerEl.addEventListener('touchmove', onTouchMove, { passive: false })
    containerEl.addEventListener('touchend', onTouchEnd, { passive: true })

    function onDragOver(event: DragEvent) {
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }

    function onDragEnter(event: DragEvent) {
      event.preventDefault()
      event.stopPropagation()
      containerEl.style.boxShadow = 'inset 0 0 0 3px var(--nexus-accent)'
    }

    function onDragLeave(event: DragEvent) {
      event.preventDefault()
      event.stopPropagation()
      containerEl.style.boxShadow = ''
    }

    function onDrop(event: DragEvent) {
      event.preventDefault()
      event.stopPropagation()
      containerEl.style.boxShadow = ''
      const files = event.dataTransfer?.files
      if (files && files.length > 0) {
        uploadFileRef.current(files[0])
      }
    }

    containerEl.addEventListener('dragover', onDragOver)
    containerEl.addEventListener('dragenter', onDragEnter)
    containerEl.addEventListener('dragleave', onDragLeave)
    containerEl.addEventListener('drop', onDrop)

    function onInputTouchStart(event: TouchEvent) {
      if (!keyboardVisibleRef.current) event.preventDefault()
    }

    const input = inputRef.current
    if (input) {
      input.addEventListener('touchstart', onInputTouchStart, { passive: false })
    }

    return () => {
      window.removeEventListener('keydown', onGlobalKeyDown, true)
      containerEl.removeEventListener('touchstart', onTouchStart)
      containerEl.removeEventListener('touchmove', onTouchMove)
      containerEl.removeEventListener('touchend', onTouchEnd)
      containerEl.removeEventListener('dragover', onDragOver)
      containerEl.removeEventListener('dragenter', onDragEnter)
      containerEl.removeEventListener('dragleave', onDragLeave)
      containerEl.removeEventListener('drop', onDrop)
      if (input) input.removeEventListener('touchstart', onInputTouchStart)
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
    }
  }, [activeWindowIndexRef, attachWindowFnRef, fitNow, inputRef, setToolbarCollapsed, showScrollbackRef, toolbarCollapsedRef, triggerScrollbackRef, uploadFileRef, windowsRef])

  useEffect(() => {
    if (!activeTmuxSession || !windowsLoaded || windowsRef.current.length === 0) {
      setIsConnecting(false)
      return
    }

    setIsScrolledUp(false)
    const hasSavedScroll = (scrollPositionsRef.current[activeWindowIndex] ?? 0) > 0
    userScrolledRef.current = hasSavedScroll
    hasConnectedRef.current = false

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    let intentionalClose = false
    let reconnectAttempts = 0
    let reconnectTimer: number | null = null
    const maxReconnectAttempts = 8
    const reconnectDelay = () => Math.min(1000 * Math.pow(2, reconnectAttempts), 15000)
    const loadingTimer = window.setTimeout(() => {
      if (!hasConnectedRef.current) setIsConnecting(true)
    }, 300)

    function writeTerm(data: string) {
      termRef.current?.write(data)
    }

    function createWs(isReconnect = false) {
      const session = activeTmuxSessionRef.current
      const windowIndex = activeWindowIndexRef.current
      const nextWs = new WebSocket(`${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}&window=${windowIndex}&session=${encodeURIComponent(session)}`)
      wsRef.current = nextWs

      nextWs.onopen = () => {
        if (isReconnect) {
          writeTerm('\r\n\x1b[32m[Nexus: 已重新连接]\x1b[0m\r\n')
        } else {
          window.clearTimeout(loadingTimer)
          termRef.current?.reset()
        }

        reconnectAttempts = 0
        hasConnectedRef.current = true
        setIsConnecting(false)
        fitAddonRef.current?.fit()
        const term = termRef.current
        if (!term) return

        nextWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: Math.max(term.rows - 1, 5) }))
        requestAnimationFrame(() => {
          fitAddonRef.current?.fit()
          if (wsRef.current?.readyState === WebSocket.OPEN && termRef.current) {
            wsRef.current.send(JSON.stringify({ type: 'resize', cols: termRef.current.cols, rows: termRef.current.rows }))
          }
        })
      }

      nextWs.onmessage = (event) => {
        writeTerm(event.data)
        if (!userScrolledRef.current) termRef.current?.scrollToBottom()
      }

      nextWs.onclose = (event) => {
        if (intentionalClose) return
        if (event.code === 4001) {
          writeTerm('\r\n\x1b[31m[Nexus: 认证失败，请刷新重新登录]\x1b[0m\r\n')
          return
        }
        if (reconnectAttempts >= maxReconnectAttempts) {
          writeTerm('\r\n\x1b[31m[Nexus: 重连失败，请刷新页面]\x1b[0m\r\n')
          return
        }

        reconnectAttempts += 1
        const delay = reconnectDelay()
        writeTerm(`\r\n\x1b[33m[Nexus: 连接断开，${delay / 1000}s 后重连 (${reconnectAttempts}/${maxReconnectAttempts})...]\x1b[0m\r\n`)
        reconnectTimer = window.setTimeout(() => createWs(true), delay)
      }

      nextWs.onerror = () => {
        writeTerm('\r\n\x1b[31m[Nexus: WebSocket 错误]\x1b[0m\r\n')
      }
    }

    createWs()

    return () => {
      intentionalClose = true
      window.clearTimeout(loadingTimer)
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      wsRef.current?.close()
    }
  }, [activeTmuxSession, activeWindowIndex, activeTmuxSessionRef, activeWindowIndexRef, scrollPositionsRef, token, windowsLoaded, windowsRef, wsSessionKey])

  useEffect(() => {
    if (isWidePC) {
      setVvHeight(null)
      return
    }

    const maybeViewport = window.visualViewport
    if (!maybeViewport) return
    const viewport: VisualViewport = maybeViewport

    function handleResize() {
      keyboardVisibleRef.current = viewport.height < window.innerHeight * 0.8
      setVvHeight(Math.round(viewport.height))
    }

    handleResize()
    viewport.addEventListener('resize', handleResize)
    return () => viewport.removeEventListener('resize', handleResize)
  }, [isWidePC])

  useEffect(() => {
    if (isWidePC) return

    function handleFocusin(event: FocusEvent) {
      if (keyboardVisibleRef.current) return
      const target = event.target as HTMLElement | null
      if (!target) return
      const xtermTa = termRef.current?.textarea
      if (target === inputRef.current || (xtermTa && target === xtermTa)) {
        target.blur()
      }
    }

    document.addEventListener('focusin', handleFocusin)
    return () => document.removeEventListener('focusin', handleFocusin)
  }, [inputRef, isWidePC])

  useEffect(() => {
    if (isWidePC) return

    const ta = termRef.current?.textarea
    if (!ta) return

    if (overlayOpen) {
      ta.readOnly = true
      return
    }

    const restoreTimer = window.setTimeout(() => {
      const current = termRef.current?.textarea
      if (current) current.readOnly = false
    }, 100)

    return () => window.clearTimeout(restoreTimer)
  }, [isWidePC, overlayOpen])

  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    if (isComposingRef.current) return
    const value = event.target.value
    if (!value) return
    sendToWs(value)
    event.target.value = ''
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (isComposingRef.current) return
    if (event.key === 'Enter') {
      event.preventDefault()
      sendToWs('\r')
    } else if (event.key === 'Backspace') {
      event.preventDefault()
      sendToWs('\x7f')
    } else if (event.key === 'Tab') {
      event.preventDefault()
      sendToWs('\t')
    } else if (event.key === 'Escape') {
      event.preventDefault()
      sendToWs('\x1b')
    } else if (event.key === 'Delete') {
      event.preventDefault()
      sendToWs('\x1b[3~')
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      sendToWs('\x1b[A')
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      sendToWs('\x1b[B')
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      sendToWs('\x1b[C')
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      sendToWs('\x1b[D')
    } else if (event.key === 'Home') {
      event.preventDefault()
      sendToWs('\x1b[H')
    } else if (event.key === 'End') {
      event.preventDefault()
      sendToWs('\x1b[F')
    } else if (event.key === 'PageUp') {
      event.preventDefault()
      sendToWs('\x1b[5~')
    } else if (event.key === 'PageDown') {
      event.preventDefault()
      sendToWs('\x1b[6~')
    } else if (event.ctrlKey && event.key.length === 1) {
      event.preventDefault()
      sendToWs(String.fromCharCode(event.key.toLowerCase().charCodeAt(0) - 96))
    } else if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault()
      sendToWs(event.key)
    }
  }

  function handleCompositionStart() {
    isComposingRef.current = true
  }

  function handleCompositionEnd(event: CompositionEvent<HTMLInputElement>) {
    isComposingRef.current = false
    if (event.data) sendToWs(event.data)
    event.currentTarget.value = ''
  }

  return {
    containerRef,
    fitTerminal,
    handleCompositionEnd,
    handleCompositionStart,
    handleInputChange,
    handleKeyDown,
    isConnecting,
    isScrolledUp,
    scrollToBottom,
    sendToWs,
    vvHeight,
  }
}
