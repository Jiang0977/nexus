import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { THEMES, type ThemeMode } from './theme'
import type { PaneTarget } from './splitLayoutTypes'

const FONT_SIZE_KEY = 'nexus_font_size'

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
  const wsRef = useRef<WebSocket | null>(null)
  const userScrolledRef = useRef(false)
  const lastContainerSizeRef = useRef({ w: 0, h: 0 })
  const [connectionState, setConnectionState] = useState<PaneConnectionState>(target ? 'loading' : 'empty')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isScrolledUp, setIsScrolledUp] = useState(false)

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
      screenReaderMode: true,
    })
    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)
    termRef.current = term
    fitAddonRef.current = fitAddon
    term.open(container)

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null
    if (viewport) {
      viewport.style.pointerEvents = 'auto'
      viewport.style.userSelect = 'text'
    }
    const screen = container.querySelector('.xterm-screen') as HTMLElement | null
    if (screen) screen.style.userSelect = 'text'

    term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type !== 'keydown') return true
      const clipboardMod = event.ctrlKey || event.metaKey
      const clipboardKey = event.key.toLowerCase()
      const noOtherMod = !event.shiftKey && !event.altKey
      if (clipboardMod && clipboardKey === 'c' && noOtherMod && term.hasSelection()) {
        event.preventDefault()
        navigator.clipboard.writeText(term.getSelection()).catch((error: unknown) => {
          console.error('[TerminalPane] Failed to copy selected terminal text', error)
        })
        return false
      }
      return true
    })

    term.onData((data) => sendToWs(data))
    term.onScroll(() => {
      const buffer = (term as any).buffer?.active
      if (!buffer) return
      const scrolledUp = buffer.viewportY < buffer.baseY
      userScrolledRef.current = scrolledUp
      setIsScrolledUp(scrolledUp)
    })

    requestAnimationFrame(() => fitAddon.fit())

    return () => {
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
      userScrolledRef.current = false
      setIsScrolledUp(false)
    }
  }, [compact, enabled, sendToWs, target?.session, target?.windowIndex, themeMode])

  useEffect(() => {
    if (!enabled || !target) {
      wsRef.current?.close()
      wsRef.current = null
      setConnectionState('empty')
      setErrorMessage(null)
      return
    }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const session = target.session
    const windowIndex = target.windowIndex
    let intentionalClose = false
    let hasOpenedCurrentConnection = false
    let reconnectAttempts = 0
    let reconnectTimer: number | null = null
    const maxReconnectAttempts = 8
    const reconnectDelay = () => Math.min(1000 * Math.pow(2, reconnectAttempts), 15000)
    const loadingTimer = window.setTimeout(() => {
      if (!hasOpenedCurrentConnection) setConnectionState('loading')
    }, 250)

    function writeTerm(data: string) {
      termRef.current?.write(data)
    }

    function stopConnecting(message: string) {
      window.clearTimeout(loadingTimer)
      hasOpenedCurrentConnection = true
      setConnectionState('error')
      setErrorMessage(message)
      writeTerm(`\r\n\x1b[31m[Nexus: ${message}]\x1b[0m\r\n`)
    }

    function createWs(isReconnect = false) {
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
        hasOpenedCurrentConnection = true
        setConnectionState('live')
        setErrorMessage(null)
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
          stopConnecting('认证失败，请刷新重新登录')
          return
        }
        if (event.code >= 4000 && event.code < 5000) {
          const reason = event.reason.trim()
          stopConnecting(reason ? `连接失败：${reason}` : '连接失败，请刷新页面')
          return
        }
        if (!hasOpenedCurrentConnection && reconnectAttempts >= 1) {
          const reason = event.reason.trim()
          stopConnecting(reason ? `连接失败：${reason}` : '连接失败，请重试')
          return
        }
        if (reconnectAttempts >= maxReconnectAttempts) {
          stopConnecting('重连失败，请刷新页面')
          return
        }

        reconnectAttempts += 1
        const delay = reconnectDelay()
        setConnectionState('loading')
        writeTerm(`\r\n\x1b[33m[Nexus: 连接断开，${delay / 1000}s 后重连 (${reconnectAttempts}/${maxReconnectAttempts})...]\x1b[0m\r\n`)
        reconnectTimer = window.setTimeout(() => createWs(true), delay)
      }

      nextWs.onerror = () => {
        writeTerm('\r\n\x1b[31m[Nexus: WebSocket 错误]\x1b[0m\r\n')
      }
    }

    setConnectionState('loading')
    setErrorMessage(null)
    createWs()

    return () => {
      intentionalClose = true
      window.clearTimeout(loadingTimer)
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [enabled, target?.session, target?.windowIndex, token])

  return {
    connectionState,
    containerRef,
    errorMessage,
    fitNow,
    isScrolledUp,
    scrollToBottom,
    sendToWs,
    termRef,
  }
}
