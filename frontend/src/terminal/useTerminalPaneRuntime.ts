import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { THEMES, type ThemeMode } from './theme'
import type { PaneTarget } from './splitLayoutTypes'
import {
  getTerminalSelectionText,
  prepareTerminalSelectionForNativeCopy,
  writeTerminalSelectionToClipboardEvent,
} from './terminalClipboard'
import { connectTerminal, type TerminalSocket } from './terminalConnection'
import { bindTerminalInput } from './terminalInput'
import { bindTerminalViewportMetrics } from './terminalViewportMetrics'
import { useTerminalScrollMode } from './useTerminalScrollMode'
import { configureTerminalUnicode } from './terminalUnicode'
import { bindTerminalOsc52 } from './terminalOsc52'
import {
  createSgrWheelReport,
  shouldForwardTerminalWheelToApplication,
} from './terminalApplicationScroll'

const FONT_SIZE_KEY = 'nexus_font_size'
const USER_SCROLL_HOLD_MS = 1200

export type PaneConnectionState = 'empty' | 'loading' | 'live' | 'error'

interface UseTerminalPaneRuntimeArgs {
  compact?: boolean
  enabled: boolean
  target: PaneTarget | null
  themeMode: ThemeMode
  token: string
}

export function useTerminalPaneRuntime({
  compact = false,
  enabled,
  target,
  themeMode,
  token,
}: UseTerminalPaneRuntimeArgs) {
  const containerRef = useRef<HTMLDivElement>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const termRef = useRef<XTerm | null>(null)
  const wsRef = useRef<TerminalSocket | null>(null)
  const clipboardRef = useRef<ReturnType<typeof bindTerminalOsc52> | null>(null)
  const userScrolledRef = useRef(false)
  const userScrollHoldUntilRef = useRef(0)
  const lastContainerSizeRef = useRef({ w: 0, h: 0 })
  const { scrollMode, scrollModeRef, setScrollMode, setScrollProfile } = useTerminalScrollMode(JSON.stringify([enabled, target?.session, target?.windowIndex]))
  const [connectionState, setConnectionState] = useState<PaneConnectionState>(target ? 'loading' : 'empty')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isScrolledUp, setIsScrolledUp] = useState(false)

  const updateScrolledState = useCallback((scrolledUp: boolean) => {
    userScrolledRef.current = scrolledUp
    setIsScrolledUp(scrolledUp)
  }, [])

  const markUserScrolled = useCallback(() => {
    userScrollHoldUntilRef.current = Date.now() + USER_SCROLL_HOLD_MS
    updateScrolledState(true)
  }, [updateScrolledState])

  const shouldAutoScroll = useCallback(() => {
    return !userScrolledRef.current && Date.now() >= userScrollHoldUntilRef.current
  }, [])

  const sendToWs = useCallback((data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data)
      return true
    }
    return false
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
      userScrollHoldUntilRef.current = 0
      updateScrolledState(false)
      term.scrollToBottom()
    }
  }, [updateScrolledState])

  const scrollToBottom = useCallback(() => {
    termRef.current?.scrollToBottom()
    userScrollHoldUntilRef.current = 0
    updateScrolledState(false)
  }, [updateScrolledState])

  useEffect(() => {
    const term = termRef.current
    if (term) term.options.theme = THEMES[themeMode]
  }, [themeMode])

  useEffect(() => {
    const container = containerRef.current
    if (!container || !enabled || !target) return

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
      }, 100)
    }

    const resizeObserver = new ResizeObserver(doResize)
    resizeObserver.observe(container)
    if (container.parentElement) {
      resizeObserver.observe(container.parentElement)
    }
    window.setTimeout(doResize, 100)

    return () => {
      resizeObserver.disconnect()
      if (rafId) cancelAnimationFrame(rafId)
      if (debounceTimer) window.clearTimeout(debounceTimer)
    }
  }, [enabled, fitNow, target])

  useEffect(() => {
    if (!enabled || !target) {
      setConnectionState('empty')
      setErrorMessage(null)
      return
    }

    const container = containerRef.current
    if (!container) return
    const containerEl: HTMLDivElement = container

    const storedFontSize = parseInt(localStorage.getItem(FONT_SIZE_KEY) || '16', 10)
    const fontSize = compact ? Math.min(storedFontSize, 12) : Math.min(storedFontSize, 15)
    const term = new XTerm({
      theme: THEMES[themeMode],
      fontSize,
      fontFamily: 'Menlo, Monaco, "Cascadia Code", "Fira Code", monospace',
      scrollback: 10000,
      cursorBlink: true,
      cursorInactiveStyle: 'block',
      allowProposedApi: true,
      screenReaderMode: false,
    })
    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)
    configureTerminalUnicode(term)
    termRef.current = term
    fitAddonRef.current = fitAddon
    term.open(container)
    const clipboard = bindTerminalOsc52(term, container)
    clipboardRef.current = clipboard
    const disposeViewportMetrics = bindTerminalViewportMetrics(term, container)

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null
    if (viewport) {
      viewport.style.pointerEvents = 'auto'
      viewport.style.userSelect = 'text'
    }
    const screen = container.querySelector('.xterm-screen') as HTMLElement | null
    if (screen) screen.style.userSelect = 'text'

    term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type !== 'keydown') return true
      if (['PageUp', 'Home'].includes(event.key)) {
        markUserScrolled()
      }
      const clipboardMod = event.ctrlKey || event.metaKey
      const clipboardKey = event.key.toLowerCase()
      const noOtherMod = !event.shiftKey && !event.altKey
      if (clipboardMod && clipboardKey === 'c' && noOtherMod && term.hasSelection()) {
        event.preventDefault()
        navigator.clipboard.writeText(getTerminalSelectionText(term)).catch((error: unknown) => {
          console.error('[TerminalPane] Failed to copy selected terminal text', error)
        })
        return false
      }
      return true
    })

    const disposeTerminalInput = bindTerminalInput(term, () => wsRef.current)
    term.onScroll(() => {
      const buffer = (term as any).buffer?.active
      if (!buffer) return
      const scrolledUp = buffer.viewportY < buffer.baseY
      if (!scrolledUp && Date.now() < userScrollHoldUntilRef.current) return
      if (!scrolledUp) userScrollHoldUntilRef.current = 0
      updateScrolledState(scrolledUp)
    })

    function onWheel(event: WheelEvent) {
      if (!event.ctrlKey && term.modes.mouseTrackingMode === 'none'
        && shouldForwardTerminalWheelToApplication(scrollModeRef.current)) {
        const target = screen ?? viewport ?? containerEl
        const report = createSgrWheelReport({
          altKey: event.altKey || event.metaKey,
          clientX: event.clientX,
          clientY: event.clientY,
          cols: term.cols,
          ctrlKey: event.ctrlKey,
          deltaY: event.deltaY,
          rows: term.rows,
          screenRect: target.getBoundingClientRect(),
          shiftKey: event.shiftKey,
        })
        if (report && wsRef.current?.readyState === WebSocket.OPEN) {
          event.preventDefault()
          event.stopPropagation()
          wsRef.current.send(report)
          return
        }
      }
      if (event.deltaY < 0) {
        markUserScrolled()
      }
    }

    function onContextMenu(event: MouseEvent) {
      prepareTerminalSelectionForNativeCopy(term, containerEl, event)
    }

    function onCopy(event: ClipboardEvent) {
      writeTerminalSelectionToClipboardEvent(term, event)
    }

    containerEl.addEventListener('wheel', onWheel, { capture: true, passive: false })
    containerEl.addEventListener('contextmenu', onContextMenu)
    containerEl.addEventListener('copy', onCopy)

    requestAnimationFrame(() => fitAddon.fit())

    return () => {
      containerEl.removeEventListener('wheel', onWheel, true)
      containerEl.removeEventListener('contextmenu', onContextMenu)
      containerEl.removeEventListener('copy', onCopy)
      disposeTerminalInput()
      disposeViewportMetrics()
      clipboard.dispose()
      clipboardRef.current = null
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
      userScrolledRef.current = false
      userScrollHoldUntilRef.current = 0
      updateScrolledState(false)
    }
  }, [compact, enabled, markUserScrolled, sendToWs, target?.session, target?.windowIndex, themeMode, updateScrolledState])

  useEffect(() => {
    if (!enabled || !target) {
      wsRef.current?.close()
      wsRef.current = null
      setConnectionState('empty')
      setErrorMessage(null)
      return
    }

    const session = target.session
    const windowIndex = target.windowIndex
    setErrorMessage(null)
    const connection = connectTerminal({
      adapter: {
        setConnecting: () => setConnectionState('loading'),
        setLive: () => {
          setConnectionState('live')
          setErrorMessage(null)
        },
        setError: (message) => {
          setConnectionState('error')
          setErrorMessage(message)
        },
        reset: () => {
          // Queue reset behind already pending writes and before the new redraw.
          termRef.current?.write('\x1bc')
        },
        restoreDimensions: (cols, rows) => termRef.current?.resize(cols, rows),
        setScrollProfile,
        fit: () => fitAddonRef.current?.fit(),
        dimensions: () => {
          const term = termRef.current
          return term ? { cols: term.cols, rows: term.rows } : null
        },
        write: (data, callback) => {
          termRef.current?.write(data, callback)
        },
        shouldAutoScroll,
        scrollToBottom: () => termRef.current?.scrollToBottom(),
      },
      loadingDelayMs: 250,
      session,
      setSocket: (socket) => {
        clipboardRef.current?.reset()
        wsRef.current = socket
      },
      showLoadingImmediately: true,
      showLoadingOnReconnect: true,
      token,
      windowIndex,
    })

    return () => {
      connection.dispose()
    }
  }, [enabled, shouldAutoScroll, target?.session, target?.windowIndex, token])

  return {
    connectionState,
    containerRef,
    errorMessage,
    fitNow,
    isScrolledUp,
    scrollMode,
    setScrollMode,
    scrollToBottom,
    sendToWs,
    termRef,
  }
}
