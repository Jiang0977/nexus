import { useCallback, useEffect, useRef, useState } from 'react'
import type { TerminalScrollMode } from './terminalApplicationScroll'

// A user override belongs to this view and target, never to an application name.
// Reconnecting the same target preserves it; switching targets or reloading does not.
export function useTerminalScrollMode(targetKey: string) {
  const [scrollMode, setMode] = useState<TerminalScrollMode>('auto')
  const scrollModeRef = useRef<TerminalScrollMode>('auto')
  const setScrollMode = useCallback((mode: TerminalScrollMode) => {
    scrollModeRef.current = mode
    setMode(mode)
  }, [])

  useEffect(() => {
    setScrollMode('auto')
  }, [targetKey, setScrollMode])

  return { scrollMode, scrollModeRef, setScrollMode }
}
