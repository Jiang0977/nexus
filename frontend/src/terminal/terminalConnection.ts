export type TerminalSocket = Pick<
  WebSocket,
  'readyState' | 'onopen' | 'onmessage' | 'onclose' | 'onerror' | 'send' | 'close'
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
    if (!hasOpenedCurrentConnection) adapter.setConnecting()
  }, loadingDelayMs)

  if (showLoadingImmediately) adapter.setConnecting()

  function stopConnecting(message: string) {
    environment.clearTimer(loadingTimer)
    hasOpenedCurrentConnection = true
    adapter.setError(message)
    adapter.write(`\r\n\x1b[31m[Nexus: ${message}]\x1b[0m\r\n`)
  }

  function sendResize(target: TerminalSocket, rowsOffset: number) {
    const dimensions = adapter.dimensions()
    if (!dimensions) return
    target.send(JSON.stringify({
      type: 'resize',
      cols: dimensions.cols,
      rows: Math.max(dimensions.rows - rowsOffset, 5),
    }))
  }

  function createSocket(isReconnect = false) {
    const url = `${protocol}//${environment.location.host}/ws?token=${encodeURIComponent(token)}&window=${windowIndex}&session=${encodeURIComponent(session)}`
    const nextSocket = environment.createSocket(url)
    socket = nextSocket
    setSocket(nextSocket)

    nextSocket.onopen = () => {
      if (isReconnect) {
        adapter.write('\r\n\x1b[32m[Nexus: 已重新连接]\x1b[0m\r\n')
      } else {
        environment.clearTimer(loadingTimer)
        adapter.reset()
      }

      reconnectAttempts = 0
      hasOpenedCurrentConnection = true
      adapter.setLive()
      adapter.fit()
      sendResize(nextSocket, 1)
      environment.requestFrame(() => {
        adapter.fit()
        if (socket?.readyState === environment.openReadyState) {
          sendResize(socket, 0)
        }
      })
    }

    nextSocket.onmessage = (event) => {
      const autoScroll = adapter.shouldAutoScroll()
      adapter.write(event.data, () => {
        if (autoScroll && adapter.shouldAutoScroll()) adapter.scrollToBottom()
      })
    }

    nextSocket.onclose = (event) => {
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
      adapter.write(`\r\n\x1b[33m[Nexus: 连接断开，${delay / 1000}s 后重连 (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...]\x1b[0m\r\n`)
      reconnectTimer = environment.setTimer(() => createSocket(true), delay)
    }

    nextSocket.onerror = () => {
      adapter.write('\r\n\x1b[31m[Nexus: WebSocket 错误]\x1b[0m\r\n')
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
