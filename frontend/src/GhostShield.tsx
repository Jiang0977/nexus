import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'

/**
 * Transparent fixed overlay that blocks all pointer/click events for `ms`
 * milliseconds after mount, then self-destructs.
 *
 * Purpose: mobile browsers fire "compatibility mouse events" (mousedown /
 * mouseup / click) ~0-300ms after touchend, at the same screen coordinates.
 * When a touch on element A opens overlay B, those ghost events land on B.
 *
 * CRITICAL: This component uses createPortal to mount at document.body,
 * ensuring it covers the ENTIRE screen even if the parent overlay is a
 * partial panel (like Toolbar editPanel which is only 55vh height).
 * Without portal, ghost clicks outside the panel area would leak through.
 */
export default function GhostShield({ ms = 350 }: { ms?: number }) {
  const [active, setActive] = useState(true)
  useEffect(() => {
    const t = setTimeout(() => setActive(false), ms)
    return () => clearTimeout(t)
  }, [ms])
  if (!active) return null
  return createPortal(
    <div
      aria-hidden
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        // Ensure it actually captures events on all browsers
        pointerEvents: 'auto',
      }}
    />,
    document.body
  )
}
