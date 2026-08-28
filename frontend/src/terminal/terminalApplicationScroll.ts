const SYNCHRONIZED_UPDATE_MODE = '\x1b[?2026h'
const SYNCHRONIZED_UPDATE_THRESHOLD = 2
const GROK_TUI_SIGNATURE = /\bGrok\s+\d+(?:\.\d+)*\b/

export interface TerminalApplicationScrollState {
  applicationSignatureObserved: boolean
  mouseTrackingObserved: boolean
  synchronizedUpdateCount: number
}

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

export function createTerminalApplicationScrollState(): TerminalApplicationScrollState {
  return {
    applicationSignatureObserved: false,
    mouseTrackingObserved: false,
    synchronizedUpdateCount: 0,
  }
}

export function resetTerminalApplicationScrollState(state: TerminalApplicationScrollState): void {
  state.applicationSignatureObserved = false
  state.mouseTrackingObserved = false
  state.synchronizedUpdateCount = 0
}

export function observeTerminalApplicationOutput(
  state: TerminalApplicationScrollState,
  data: string,
): void {
  if (!state.mouseTrackingObserved && /\x1b\[\?(?:1000|1002|1003)[hl]/.test(data)) {
    state.mouseTrackingObserved = true
  }
  if (!state.applicationSignatureObserved && GROK_TUI_SIGNATURE.test(data)) {
    state.applicationSignatureObserved = true
  }

  if (state.synchronizedUpdateCount >= SYNCHRONIZED_UPDATE_THRESHOLD) return
  let searchFrom = 0
  while (state.synchronizedUpdateCount < SYNCHRONIZED_UPDATE_THRESHOLD) {
    const next = data.indexOf(SYNCHRONIZED_UPDATE_MODE, searchFrom)
    if (next < 0) return
    state.synchronizedUpdateCount += 1
    searchFrom = next + SYNCHRONIZED_UPDATE_MODE.length
  }
}

export function shouldForwardTerminalWheelToApplication(
  state: TerminalApplicationScrollState,
): boolean {
  return !state.mouseTrackingObserved
    && (
      state.applicationSignatureObserved
      || state.synchronizedUpdateCount >= SYNCHRONIZED_UPDATE_THRESHOLD
    )
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
