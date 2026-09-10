import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react'
import type { ChangeEvent, CompositionEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { THEMES, getInitialTheme } from './theme'
import type { TmuxWindow } from './useTerminalSessions'
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
const TAP_THRESHOLD = 8
const CHANNEL_SWIPE_THRESHOLD = 60
const SWIPE_DIRECTION_LOCK_THRESHOLD = 18
const SWIPE_DIRECTION_GAP = 12
const APPLICATION_TOUCH_WHEEL_STEP_PX = 32

interface UseTerminalRuntimeArgs {
  activeTmuxSession: string
  activeTmuxSessionRef: MutableRefObject<string>
  activeWindowIndex: number
  activeWindowIndexRef: MutableRefObject<number>
  attachWindowFnRef: MutableRefObject<(index: number) => void>
  enabled?: boolean
  inputRef: RefObject<HTMLInputElement | null>
  isWidePC: boolean
  overlayOpen: boolean
  scrollPositionsRef: MutableRefObject<Record<number, number>>
  setToolbarCollapsed: Dispatch<SetStateAction<boolean | undefined>>
  termRef: MutableRefObject<XTerm | null>
  token: string
  toolbarCollapsedRef: MutableRefObject<boolean | undefined>
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
  enabled = true,
  inputRef,
  isWidePC,
  overlayOpen,
  scrollPositionsRef,
  setToolbarCollapsed,
  termRef,
  token,
  toolbarCollapsedRef,
  uploadFileRef,
  windowsLoaded,
  windowsRef,
  wsSessionKey,
}: UseTerminalRuntimeArgs) {
  const containerRef = useRef<HTMLDivElement>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<TerminalSocket | null>(null)
  const clipboardRef = useRef<ReturnType<typeof bindTerminalOsc52> | null>(null)
  const userScrolledRef = useRef(false)
  const lastContainerSizeRef = useRef({ w: 0, h: 0 })
  const keyboardVisibleRef = useRef(false)
  const isComposingRef = useRef(false)
  const overlayOpenRef = useRef(overlayOpen)
  const { scrollMode, scrollModeRef, setScrollMode, setScrollProfile } = useTerminalScrollMode(JSON.stringify([enabled, activeTmuxSession, activeWindowIndex]))
  const [isConnecting, setIsConnecting] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [isScrolledUp, setIsScrolledUp] = useState(false)
  const [vvHeight, setVvHeight] = useState<number | null>(null)

  useEffect(() => {
    overlayOpenRef.current = overlayOpen
  }, [overlayOpen])

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
    if (!container || !enabled) return

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
  }, [enabled, fitNow])

  useEffect(() => {
    if (!enabled) return

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
      screenReaderMode: false,
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)
    configureTerminalUnicode(term)
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
    const clipboard = bindTerminalOsc52(term, containerEl)
    clipboardRef.current = clipboard
    const disposeViewportMetrics = bindTerminalViewportMetrics(term, containerEl)
    // Own terminal gestures; virtual xterm scrolling is not a browser pan.
    // Pinch zoom and horizontal channel swipes are handled below as well.
    containerEl.style.touchAction = 'none'
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
      viewport.style.touchAction = 'none'
      viewport.style.overscrollBehavior = 'contain'
      viewport.style.setProperty('-webkit-overflow-scrolling', 'touch')
    }

    const screen = containerEl.querySelector('.xterm-screen') as HTMLElement | null
    if (screen) {
      screen.style.userSelect = 'text'
      screen.style.pointerEvents = 'none'
    }

    const disposeTerminalInput = bindTerminalInput(term, () => wsRef.current)

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
          navigator.clipboard.writeText(getTerminalSelectionText(term)).catch((error: unknown) => {
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

    function syncScrolledStateFromBuffer() {
      const buffer = term.buffer.active
      if (!buffer) return
      const scrolledUp = buffer.viewportY < buffer.baseY
      userScrolledRef.current = scrolledUp
      setIsScrolledUp(scrolledUp)
    }

    const scrollSubscription = term.onScroll(syncScrolledStateFromBuffer)

    let touchStartX = 0
    let touchStartY = 0
    let touchLastY = 0
    let touchScrollRemainder = 0
    let applicationTouchWheelRemainder = 0
    let touchScrollLineHeight = 0
    let isPinching = false
    let pinchStartDist = 0
    let pinchStartFontSize = fontSize
    let swipeAxis: 'vertical' | 'horizontal' | null = null
    let channelSwipeTriggered = false

    function switchChannelBySwipe(deltaX: number) {
      const wins = [...windowsRef.current].sort((a, b) => a.index - b.index)
      const pos = wins.findIndex((window) => window.index === activeWindowIndexRef.current)
      if (pos < 0) return false

      if (deltaX < 0 && pos < wins.length - 1) {
        attachWindowFnRef.current(wins[pos + 1].index)
        return true
      }

      if (deltaX > 0 && pos > 0) {
        attachWindowFnRef.current(wins[pos - 1].index)
        return true
      }

      return false
    }

    function resolveSwipeAxis(totalDeltaX: number, totalDeltaY: number): 'vertical' | 'horizontal' | null {
      const absX = Math.abs(totalDeltaX)
      const absY = Math.abs(totalDeltaY)

      if (absX < SWIPE_DIRECTION_LOCK_THRESHOLD && absY < SWIPE_DIRECTION_LOCK_THRESHOLD) {
        return null
      }

      if (absX - absY >= SWIPE_DIRECTION_GAP) return 'horizontal'
      if (absY - absX >= SWIPE_DIRECTION_GAP) return 'vertical'
      return null
    }

    function getTouchDist(event: TouchEvent): number {
      const dx = event.touches[0].clientX - event.touches[1].clientX
      const dy = event.touches[0].clientY - event.touches[1].clientY
      return Math.sqrt(dx * dx + dy * dy)
    }

    function getTouchScrollLineHeight(): number {
      if (touchScrollLineHeight > 0) return touchScrollLineHeight
      const screenEl = containerEl.querySelector('.xterm-screen') as HTMLElement | null
      if (screenEl && term.rows > 0) {
        const rowHeight = screenEl.clientHeight / term.rows
        if (Number.isFinite(rowHeight) && rowHeight > 0) {
          touchScrollLineHeight = rowHeight
          return touchScrollLineHeight
        }
      }
      touchScrollLineHeight = Math.max(8, Number(term.options.fontSize) || fontSize)
      return touchScrollLineHeight
    }

    function scrollTerminalByTouch(deltaY: number) {
      touchScrollRemainder += deltaY
      const lineHeight = getTouchScrollLineHeight()
      const lines = Math.trunc(touchScrollRemainder / lineHeight)
      if (lines === 0) return
      touchScrollRemainder -= lines * lineHeight
      term.scrollLines(-lines)
    }

    function beginNewTouchGesture() {
      touchScrollRemainder = 0
      applicationTouchWheelRemainder = 0
      touchScrollLineHeight = 0
    }

    function onTouchStart(event: TouchEvent) {
      if (event.touches.length === 2) {
        beginNewTouchGesture()
        isPinching = true
        pinchStartDist = getTouchDist(event)
        pinchStartFontSize = parseInt(localStorage.getItem(FONT_SIZE_KEY) || '16', 10)
        containerEl.addEventListener('touchmove', onPinchTouchMove, { passive: false })
        return
      }

      isPinching = false
      beginNewTouchGesture()
      touchStartX = event.touches[0].clientX
      touchStartY = event.touches[0].clientY
      touchLastY = touchStartY
      swipeAxis = null
      channelSwipeTriggered = false
    }

    function onPinchTouchMove(event: TouchEvent) {
      if (!isPinching || event.touches.length !== 2) return
      event.preventDefault()
      const dist = getTouchDist(event)
      const scale = dist / pinchStartDist
      const newSize = Math.round(Math.max(8, Math.min(32, pinchStartFontSize * scale)))
      if (newSize !== term.options.fontSize) {
        term.options.fontSize = newSize
        localStorage.setItem(FONT_SIZE_KEY, String(newSize))
        fitNow()
      }
    }

    function finishPinch() {
      if (!isPinching) return
      isPinching = false
      containerEl.removeEventListener('touchmove', onPinchTouchMove)
    }

    function handleSingleTouchMove(event: TouchEvent) {
      if (isPinching || event.touches.length !== 1) {
        return
      }

      const currentY = event.touches[0].clientY
      const totalDeltaX = event.touches[0].clientX - touchStartX
      const totalDeltaY = currentY - touchStartY
      if (!swipeAxis) swipeAxis = resolveSwipeAxis(totalDeltaX, totalDeltaY)

      if (swipeAxis === 'horizontal') {
        if (!channelSwipeTriggered) {
          if (Math.abs(totalDeltaX) >= CHANNEL_SWIPE_THRESHOLD) {
            channelSwipeTriggered = switchChannelBySwipe(totalDeltaX)
          }
        }
        return
      }

      if (swipeAxis === 'vertical') {
        event.preventDefault()
        event.stopPropagation()
        const standardMouseWheel = ['vt200', 'drag', 'any'].includes(term.modes.mouseTrackingMode)
        if (standardMouseWheel || (term.modes.mouseTrackingMode === 'none' && shouldForwardTerminalWheelToApplication(scrollModeRef.current))) {
          const deltaY = currentY - touchLastY
          applicationTouchWheelRemainder += deltaY
          const reports = Math.min(3, Math.floor(Math.abs(applicationTouchWheelRemainder) / APPLICATION_TOUCH_WHEEL_STEP_PX))
          if (reports > 0) {
            const reportDeltaY = applicationTouchWheelRemainder > 0 ? -1 : 1
            for (let index = 0; index < reports; index += 1) {
              if (standardMouseWheel) {
                // Let xterm encode the negotiated mouse protocol (including
                // legacy binary reports); never assume tracking means SGR.
                const rect = (screen ?? containerEl).getBoundingClientRect()
                ;(screen ?? viewport ?? containerEl).dispatchEvent(new WheelEvent('wheel', {
                  bubbles: true,
                  cancelable: true,
                  deltaMode: WheelEvent.DOM_DELTA_LINE,
                  deltaY: reportDeltaY,
                  clientX: Math.max(rect.left, Math.min(rect.right - 1, event.touches[0].clientX)),
                  clientY: Math.max(rect.top, Math.min(rect.bottom - 1, currentY)),
                }))
              } else {
                sendApplicationWheelReport(
                  event.touches[0].clientX,
                  currentY,
                  reportDeltaY,
                )
              }
            }
            applicationTouchWheelRemainder -= Math.sign(applicationTouchWheelRemainder)
              * reports
              * APPLICATION_TOUCH_WHEEL_STEP_PX
          }
          touchLastY = currentY
          return
        }
        scrollTerminalByTouch(currentY - touchLastY)
        touchLastY = currentY
        return
      }
    }

    function onTouchMove(event: TouchEvent) {
      handleSingleTouchMove(event)
    }

    function onViewportTouchMove(event: TouchEvent) {
      if (event.touches.length === 1) {
        event.stopPropagation()
        handleSingleTouchMove(event)
      }
    }

    function onTouchEnd(event: TouchEvent) {
      if (isPinching) {
        finishPinch()
        return
      }

      const endX = event.changedTouches[0].clientX
      const endY = event.changedTouches[0].clientY
      const dx = endX - touchStartX
      const dy = endY - touchStartY
      const finalSwipeAxis = swipeAxis ?? resolveSwipeAxis(dx, dy)
      if (finalSwipeAxis === 'horizontal' && channelSwipeTriggered) {
        return
      }

      if (finalSwipeAxis === 'horizontal' && Math.abs(dx) >= CHANNEL_SWIPE_THRESHOLD) {
        switchChannelBySwipe(dx)
        return
      }

      if (Math.abs(dy) >= TAP_THRESHOLD || Math.abs(dx) >= TAP_THRESHOLD) return

      const rect = containerEl.getBoundingClientRect()
      if (endX < rect.left || endX > rect.right || endY < rect.top || endY > rect.bottom) return

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

    function sendApplicationWheelReport(
      clientX: number,
      clientY: number,
      deltaY: number,
      modifiers: { altKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = {},
    ): boolean {
      const socket = wsRef.current
      const target = screen ?? viewport ?? containerEl
      if (socket?.readyState !== WebSocket.OPEN) return false
      const report = createSgrWheelReport({
        ...modifiers,
        clientX,
        clientY,
        cols: term.cols,
        deltaY,
        rows: term.rows,
        screenRect: target.getBoundingClientRect(),
      })
      if (!report) return false
      socket.send(report)
      return true
    }

    function onWheel(event: WheelEvent) {
      if (event.ctrlKey || term.modes.mouseTrackingMode !== 'none'
        || !shouldForwardTerminalWheelToApplication(scrollModeRef.current)) return
      if (!sendApplicationWheelReport(event.clientX, event.clientY, event.deltaY, event)) return
      event.preventDefault()
      event.stopPropagation()
    }

    containerEl.addEventListener('touchstart', onTouchStart, { passive: true })
    containerEl.addEventListener('touchmove', onTouchMove, { passive: false })
    containerEl.addEventListener('touchend', onTouchEnd, { passive: true })
    containerEl.addEventListener('touchcancel', finishPinch, { passive: true })
    viewport?.addEventListener('touchmove', onViewportTouchMove, { passive: false })
    containerEl.addEventListener('wheel', onWheel, { capture: true, passive: false })

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

    function onContextMenu(event: MouseEvent) {
      prepareTerminalSelectionForNativeCopy(term, containerEl, event)
    }

    function onCopy(event: ClipboardEvent) {
      writeTerminalSelectionToClipboardEvent(term, event)
    }

    containerEl.addEventListener('contextmenu', onContextMenu)
    containerEl.addEventListener('copy', onCopy)

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
      containerEl.removeEventListener('touchmove', onPinchTouchMove)
      containerEl.removeEventListener('touchend', onTouchEnd)
      containerEl.removeEventListener('touchcancel', finishPinch)
      viewport?.removeEventListener('touchmove', onViewportTouchMove)
      containerEl.removeEventListener('wheel', onWheel, true)
      containerEl.removeEventListener('dragover', onDragOver)
      containerEl.removeEventListener('dragenter', onDragEnter)
      containerEl.removeEventListener('dragleave', onDragLeave)
      containerEl.removeEventListener('drop', onDrop)
      containerEl.removeEventListener('contextmenu', onContextMenu)
      containerEl.removeEventListener('copy', onCopy)
      if (input) input.removeEventListener('touchstart', onInputTouchStart)
      disposeTerminalInput()
      disposeViewportMetrics()
      scrollSubscription.dispose()
      clipboard.dispose()
      clipboardRef.current = null
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
    }
  }, [activeWindowIndexRef, attachWindowFnRef, enabled, fitNow, inputRef, setToolbarCollapsed, toolbarCollapsedRef, uploadFileRef, windowsRef])

  useEffect(() => {
    if (!enabled) {
      setConnectionError(null)
      setIsConnecting(false)
      wsRef.current?.close()
      wsRef.current = null
      return
    }

    if (!activeTmuxSession || !windowsLoaded || windowsRef.current.length === 0) {
      setConnectionError(null)
      setIsConnecting(false)
      return
    }

    setConnectionError(null)
    setIsScrolledUp(false)
    const hasSavedScroll = (scrollPositionsRef.current[activeWindowIndex] ?? 0) > 0
    userScrolledRef.current = hasSavedScroll

    const connection = connectTerminal({
      adapter: {
        setConnecting: () => {
          setConnectionError(null)
          setIsConnecting(true)
        },
        setLive: () => {
          setConnectionError(null)
          setIsConnecting(false)
        },
        setError: (message: string) => {
          setConnectionError(message)
          setIsConnecting(false)
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
        shouldAutoScroll: () => !userScrolledRef.current,
        scrollToBottom: () => termRef.current?.scrollToBottom(),
      },
      loadingDelayMs: 300,
      session: activeTmuxSessionRef.current,
      setSocket: (socket) => {
        clipboardRef.current?.reset()
        wsRef.current = socket
      },
      showLoadingImmediately: false,
      showLoadingOnReconnect: false,
      token,
      windowIndex: activeWindowIndexRef.current,
    })

    return () => {
      connection.dispose()
    }
  }, [activeTmuxSession, activeWindowIndex, activeTmuxSessionRef, activeWindowIndexRef, enabled, scrollPositionsRef, token, windowsLoaded, windowsRef, wsSessionKey])

  useEffect(() => {
    if (!enabled) {
      setVvHeight(null)
      return
    }

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
  }, [enabled, isWidePC])

  useEffect(() => {
    if (!enabled) return
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
  }, [enabled, inputRef, isWidePC])

  useEffect(() => {
    if (!enabled) return
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
  }, [enabled, isWidePC, overlayOpen])

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
    connectionError,
    isConnecting,
    isScrolledUp,
    scrollMode,
    setScrollMode,
    scrollToBottom,
    sendToWs,
    vvHeight,
  }
}
