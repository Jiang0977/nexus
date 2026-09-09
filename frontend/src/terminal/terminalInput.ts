import type { Terminal as XTerm } from '@xterm/xterm'
import type { TerminalSocket } from './terminalConnection'

export function terminalBinaryToBytes(data: string): Uint8Array {
  const bytes = new Uint8Array(data.length)
  for (let index = 0; index < data.length; index += 1) {
    bytes[index] = data.charCodeAt(index) & 0xff
  }
  return bytes
}

export function bindTerminalInput(
  term: XTerm,
  getSocket: () => TerminalSocket | null,
): () => void {
  const sendText = (data: string) => {
    const socket = getSocket()
    if (socket?.readyState === WebSocket.OPEN) socket.send(data)
  }

  const sendBinary = (data: string) => {
    const socket = getSocket()
    if (socket?.readyState === WebSocket.OPEN) socket.send(terminalBinaryToBytes(data))
  }

  const dataDisposable = term.onData(sendText)
  const binaryDisposable = term.onBinary(sendBinary)

  return () => {
    dataDisposable.dispose()
    binaryDisposable.dispose()
  }
}
