export type TerminalScrollMode = 'auto' | 'application-sgr'

interface SgrWheelReportArgs {
  altKey?: boolean
  clientX: number
  clientY: number
  cols: number
  ctrlKey?: boolean
  deltaY: number
  rows: number
  screenRect: DOMRect
  shiftKey?: boolean
}

export function shouldForwardTerminalWheelToApplication(
  mode: TerminalScrollMode,
): boolean {
  return mode === 'application-sgr'
}

export function createSgrWheelReport({
  altKey = false,
  clientX,
  clientY,
  cols,
  ctrlKey = false,
  deltaY,
  rows,
  screenRect,
  shiftKey = false,
}: SgrWheelReportArgs): string | null {
  if (deltaY === 0 || cols <= 0 || rows <= 0 || screenRect.width <= 0 || screenRect.height <= 0) {
    return null
  }

  const column = Math.max(1, Math.min(cols, Math.floor(((clientX - screenRect.left) / screenRect.width) * cols) + 1))
  const row = Math.max(1, Math.min(rows, Math.floor(((clientY - screenRect.top) / screenRect.height) * rows) + 1))
  const modifiers = (shiftKey ? 4 : 0) + (altKey ? 8 : 0) + (ctrlKey ? 16 : 0)
  const button = (deltaY < 0 ? 64 : 65) + modifiers
  return `\x1b[<${button};${column};${row}M`
}
