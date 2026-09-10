export type TerminalSocket = Pick<
  WebSocket,
  'readyState' | 'binaryType' | 'onopen' | 'onmessage' | 'onclose' | 'onerror' | 'send' | 'close'
>

export interface TerminalConnectionAdapter {
  setConnecting(): void
  setLive(): void
  setError(message: string): void
  reset(): void
  restoreDimensions(cols: number, rows: number): void
  setScrollProfile(profile: 'auto' | 'application-sgr' | null): void
  fit(): void
  dimensions(): { cols: number; rows: number } | null
  write(data: string, callback?: () => void): void
  shouldAutoScroll(): boolean
  scrollToBottom(): void
}

export interface TerminalConnectionEnvironment {
  createSocket(url: string): TerminalSocket
  clearTimer(timer: number): void
  setTimer(callback: () => void, delayMs: number): number
  requestFrame(callback: () => void): void
  location: { protocol: string; host: string }
  openReadyState: number
}

interface TerminalConnectionOptions {
  adapter: TerminalConnectionAdapter
  environment?: TerminalConnectionEnvironment
  loadingDelayMs: number
  session: string
  setSocket(socket: TerminalSocket | null): void
  showLoadingImmediately: boolean
  showLoadingOnReconnect: boolean
  token: string
  windowIndex: number
}

export interface TerminalConnection {
  dispose(): void
}

const MAX_RECONNECT_ATTEMPTS = 8

function validDimensions(dimensions: { cols: number; rows: number } | null) {
  return dimensions !== null
    && Number.isInteger(dimensions.cols) && Number.isInteger(dimensions.rows)
    && dimensions.cols >= 1 && dimensions.cols <= 65535
    && dimensions.rows >= 1 && dimensions.rows <= 65535
}

function browserEnvironment(): TerminalConnectionEnvironment {
  return {
    createSocket: (url) => new WebSocket(url),
    clearTimer: (timer) => window.clearTimeout(timer),
    setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
    requestFrame: (callback) => requestAnimationFrame(callback),
    location,
    openReadyState: WebSocket.OPEN,
  }
}

export function connectTerminal({
  adapter,
  environment = browserEnvironment(),
  loadingDelayMs,
  session,
  setSocket,
  showLoadingImmediately,
  showLoadingOnReconnect,
  token,
  windowIndex,
}: TerminalConnectionOptions): TerminalConnection {
  const protocol = environment.location.protocol === 'https:' ? 'wss:' : 'ws:'
  let intentionalClose = false
  let hasOpenedCurrentConnection = false
  let reconnectAttempts = 0
  let reconnectTimer: number | null = null
  let socket: TerminalSocket | null = null
  const loadingTimer = environment.setTimer(() => {
    if (!intentionalClose && !hasOpenedCurrentConnection) adapter.setConnecting()
  }, loadingDelayMs)

  if (showLoadingImmediately) adapter.setConnecting()

  function stopConnecting(message: string) {
    environment.clearTimer(loadingTimer)
    if (reconnectTimer !== null) {
      environment.clearTimer(reconnectTimer)
      reconnectTimer = null
    }
    hasOpenedCurrentConnection = true
    adapter.setError(message)
  }

  function sendResize(
    target: TerminalSocket,
    dimensions: { cols: number; rows: number } | null,
    lastResize: { cols: number; rows: number } | null,
  ) {
    if (!dimensions || !validDimensions(dimensions)) return lastResize
    if (lastResize && lastResize.cols === dimensions.cols && lastResize.rows === dimensions.rows) return lastResize
    try {
      target.send(JSON.stringify({
        type: 'resize',
        cols: dimensions.cols,
        rows: dimensions.rows,
      }))
      return { cols: dimensions.cols, rows: dimensions.rows }
    } catch {
      return lastResize
    }
  }

  function isActiveSocket(target: TerminalSocket, closed: boolean) {
    return !intentionalClose && socket === target && !closed
  }

  function createSocket() {
    adapter.setScrollProfile(null)
    let closed = false
    let receivedOutput = false
    let receivedState = false
    let nativeMode = false
    let pendingNative: { cols: number; rows: number } | null = null
    const nativeWrites: { data: string; geometry: { cols: number; rows: number } | null }[] = []
    let writingNative = false
    let queuedChars = 0
    let renderOverflow = false
    let lastResize: { cols: number; rows: number } | null = null
    adapter.fit()
    const dimensions = adapter.dimensions()
    const geometry = dimensions && validDimensions(dimensions) ? `&cols=${dimensions.cols}&rows=${dimensions.rows}` : ''
    const url = `${protocol}//${environment.location.host}/ws?token=${encodeURIComponent(token)}&window=${windowIndex}&session=${encodeURIComponent(session)}&terminalProtocol=2${geometry}`
    const nextSocket = environment.createSocket(url)
    nextSocket.binaryType = 'arraybuffer'
    socket = nextSocket
    setSocket(nextSocket)

    function drainNativeWrites() {
      if (writingNative || renderOverflow || !isActiveSocket(nextSocket, closed)) return
      const next = nativeWrites.shift()
      if (!next) return
      writingNative = true
      if (next.geometry) adapter.restoreDimensions(next.geometry.cols, next.geometry.rows)
      const autoScroll = adapter.shouldAutoScroll()
      adapter.write(next.data, () => {
        queuedChars -= next.data.length
        writingNative = false
        if (!isActiveSocket(nextSocket, closed)) return
        if (autoScroll && adapter.shouldAutoScroll()) adapter.scrollToBottom()
        drainNativeWrites()
      })
    }

    nextSocket.onopen = () => {
      if (!isActiveSocket(nextSocket, closed) || nextSocket.readyState !== environment.openReadyState) return
      if (!hasOpenedCurrentConnection) environment.clearTimer(loadingTimer)
      else if (reconnectTimer !== null) {
        environment.clearTimer(reconnectTimer)
        reconnectTimer = null
      }
      if (!hasOpenedCurrentConnection) adapter.reset()
      reconnectAttempts = 0
      hasOpenedCurrentConnection = true
      adapter.setLive()
      adapter.fit()
      lastResize = sendResize(nextSocket, adapter.dimensions(), lastResize)
      environment.requestFrame(() => {
        if (!isActiveSocket(nextSocket, closed)) return
        // A shared native PTY may be smaller than this view. Its checkpoint
        // already supplied authoritative dimensions; don't undo them here.
        if (nativeMode) return
        adapter.fit()
        if (socket?.readyState === environment.openReadyState) {
          lastResize = sendResize(socket, adapter.dimensions(), lastResize)
        }
      })
    }

    nextSocket.onmessage = (event) => {
      if (renderOverflow || !isActiveSocket(nextSocket, closed)) return
      if (typeof event.data !== 'string') {
        try {
          if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > 1024) throw new Error('invalid control')
          const control = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(event.data))
          const scrollProfile = control?.scrollProfile ?? null
          if (scrollProfile !== null && scrollProfile !== 'auto' && scrollProfile !== 'application-sgr') throw new Error('invalid scroll profile')
          if (control?.type === 'native-state') {
            if (control.version !== 1 || control.replayPolicy !== 'native-snapshot'
              || control.unicodeVersion !== '11'
              || !validDimensions(control) || control.cols > 500 || control.rows > 200
              || pendingNative || (receivedState && !nativeMode) || (receivedOutput && !nativeMode)) throw new Error('invalid native state')
            nativeMode = true
            receivedState = true
            pendingNative = { cols: control.cols, rows: control.rows }
            adapter.setScrollProfile(scrollProfile)
            return
          }
          if (receivedState || receivedOutput || control?.type !== 'terminal-state'
            || control.version !== 1 || control.replayPolicy !== 'tmux-redraw') throw new Error('unsupported control')
          receivedState = true
          adapter.setScrollProfile(scrollProfile)
          adapter.reset()
        } catch {
          closed = true
          stopConnecting('终端协议不兼容，请刷新页面')
          nextSocket.close(4002, 'unsupported terminal control')
        }
        return
      }
      receivedOutput = true
      if (nativeMode) {
        queuedChars += event.data.length
        if (queuedChars > 32 * 1024 * 1024) {
          renderOverflow = true
          nativeWrites.length = 0
          nextSocket.close(1013, 'terminal render queue full')
          return
        }
        nativeWrites.push({ data: event.data, geometry: pendingNative })
        pendingNative = null
        drainNativeWrites()
        return
      }
      const autoScroll = adapter.shouldAutoScroll()
      adapter.write(event.data, () => {
        if (!isActiveSocket(nextSocket, closed)) return
        if (autoScroll && adapter.shouldAutoScroll()) adapter.scrollToBottom()
      })
    }

    nextSocket.onclose = (event) => {
      if (closed || socket !== nextSocket) return
      closed = true
      nativeWrites.length = 0
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
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        stopConnecting('重连失败，请刷新页面')
        return
      }

      reconnectAttempts += 1
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 15000)
      if (showLoadingOnReconnect) adapter.setConnecting()
      reconnectTimer = environment.setTimer(() => {
        if (intentionalClose || socket !== nextSocket) return
        reconnectTimer = null
        createSocket()
      }, delay)
    }

    nextSocket.onerror = () => {
      if (!isActiveSocket(nextSocket, closed)) return
      adapter.setError('WebSocket 错误，请等待重连')
    }
  }

  createSocket()

  return {
    dispose() {
      intentionalClose = true
      environment.clearTimer(loadingTimer)
      if (reconnectTimer !== null) environment.clearTimer(reconnectTimer)
      socket?.close()
      socket = null
      setSocket(null)
    },
  }
}
