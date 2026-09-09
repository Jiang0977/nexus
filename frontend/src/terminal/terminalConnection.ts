export type TerminalSocket = Pick<
  WebSocket,
  'readyState' | 'binaryType' | 'onopen' | 'onmessage' | 'onclose' | 'onerror' | 'send' | 'close'
>

export interface TerminalConnectionAdapter {
  setConnecting(): void
  setLive(): void
  setError(message: string): void
  reset(): void
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
    let closed = false
    let receivedOutput = false
    let receivedState = false
    let lastResize: { cols: number; rows: number } | null = null
    adapter.fit()
    const dimensions = adapter.dimensions()
    const geometry = dimensions && validDimensions(dimensions) ? `&cols=${dimensions.cols}&rows=${dimensions.rows}` : ''
    const url = `${protocol}//${environment.location.host}/ws?token=${encodeURIComponent(token)}&window=${windowIndex}&session=${encodeURIComponent(session)}&terminalProtocol=2${geometry}`
    const nextSocket = environment.createSocket(url)
    nextSocket.binaryType = 'arraybuffer'
    socket = nextSocket
    setSocket(nextSocket)

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
        adapter.fit()
        if (socket?.readyState === environment.openReadyState) {
          lastResize = sendResize(socket, adapter.dimensions(), lastResize)
        }
      })
    }

    nextSocket.onmessage = (event) => {
      if (!isActiveSocket(nextSocket, closed)) return
      if (typeof event.data !== 'string') {
        try {
          if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > 1024) throw new Error('invalid control')
          const control = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(event.data))
          if (receivedState || receivedOutput || control?.type !== 'terminal-state'
            || control.version !== 1 || control.replayPolicy !== 'tmux-redraw') throw new Error('unsupported control')
          receivedState = true
          adapter.reset()
        } catch {
          closed = true
          stopConnecting('终端协议不兼容，请刷新页面')
          nextSocket.close(4002, 'unsupported terminal control')
        }
        return
      }
      receivedOutput = true
      const autoScroll = adapter.shouldAutoScroll()
      adapter.write(event.data, () => {
        if (!isActiveSocket(nextSocket, closed)) return
        if (autoScroll && adapter.shouldAutoScroll()) adapter.scrollToBottom()
      })
    }

    nextSocket.onclose = (event) => {
      if (closed || socket !== nextSocket) return
      closed = true
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
