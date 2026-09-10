import { useCallback, useEffect, useRef, useState } from 'react'
import type { TerminalScrollMode } from './terminalApplicationScroll'

// A user override belongs to this view and target, never to an application name.
// Reconnecting the same target preserves it; switching targets or reloading does not.
export function useTerminalScrollMode(targetKey: string) {
  const [scrollMode, setMode] = useState<TerminalScrollMode>('auto')
  const scrollModeRef = useRef<TerminalScrollMode>('auto')
  const manualModeRef = useRef<TerminalScrollMode>('auto')
  const profileRef = useRef<TerminalScrollMode | null>(null)
  const setScrollMode = useCallback((mode: TerminalScrollMode) => {
    manualModeRef.current = mode
    scrollModeRef.current = profileRef.current ?? mode
    setMode(scrollModeRef.current)
  }, [])

  const setScrollProfile = useCallback((profile: TerminalScrollMode | null) => {
    profileRef.current = profile
    scrollModeRef.current = profile ?? manualModeRef.current
    setMode(scrollModeRef.current)
  }, [])

  useEffect(() => {
    profileRef.current = null
    setScrollMode('auto')
  }, [targetKey, setScrollMode])

  return { scrollMode, scrollModeRef, setScrollMode, setScrollProfile }
}
