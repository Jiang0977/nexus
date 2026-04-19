import { useEffect } from 'react'
import type { Terminal } from '@xterm/xterm'

/**
 * When any overlay opens (active=true), set xterm textarea to readOnly.
 * This prevents the virtual keyboard from appearing when the browser
 * restores focus after the keyboard is dismissed.
 *
 * Usage: Call this hook in every overlay component (drawers, modals, panels).
 *        Pass `active` as the second argument (e.g., `useOverlayGuard(termRef, isOpen)`).
 */
export default function useOverlayGuard(termRef: React.RefObject<Terminal | null>, active: boolean) {
  useEffect(() => {
    if (!active) return
    const ta = termRef.current?.textarea
    if (ta) {
      ta.readOnly = true
    }
    return () => {
      // Delay restoring to avoid race with keyboard dismiss animation
      setTimeout(() => {
        const ta2 = termRef.current?.textarea
        if (ta2) {
          ta2.readOnly = false
        }
      }, 100)
    }
  }, [termRef, active])
}
