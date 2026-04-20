import { useState, useEffect, useRef, useCallback, type CSSProperties, type ReactNode } from 'react'

const DRAG_THRESHOLD = 8
const SNAP_MARGIN = 12

interface Pos {
  x: number
  y: number
}

interface Props {
  storageKey: string
  onClick: (trigger?: HTMLElement | null) => void
  children: ReactNode
  badge?: ReactNode
  title?: string
  ariaLabel?: string
  size?: number
  topInset?: number
  bottomInset?: number
  zIndex?: number
  defaultSide?: 'left' | 'right'
  defaultBottomOffset?: number
  style?: CSSProperties
}

function snapToEdge(x: number, size: number): number {
  return (x + size / 2) < window.innerWidth / 2 ? SNAP_MARGIN : window.innerWidth - size - SNAP_MARGIN
}

function clampPos(x: number, y: number, size: number, topInset: number, bottomInset: number): Pos {
  return {
    x: Math.max(0, Math.min(x, window.innerWidth - size)),
    y: Math.max(topInset + 8, Math.min(y, window.innerHeight - size - bottomInset - 8)),
  }
}

function defaultPos(size: number, bottomInset: number, side: 'left' | 'right', bottomOffset: number): Pos {
  return {
    x: side === 'left' ? SNAP_MARGIN : window.innerWidth - size - SNAP_MARGIN,
    y: window.innerHeight - size - bottomInset - bottomOffset,
  }
}

export default function DraggableFab({
  storageKey,
  onClick,
  children,
  badge,
  title,
  ariaLabel,
  size = 52,
  topInset = 0,
  bottomInset = 0,
  zIndex = 350,
  defaultSide = 'right',
  defaultBottomOffset = 24,
  style,
}: Props) {
  const [pos, setPos] = useState<Pos>(() => {
    try {
      const saved = localStorage.getItem(storageKey)
      if (saved) {
        const parsed = JSON.parse(saved) as Pos
        return clampPos(parsed.x, parsed.y, size, topInset, bottomInset)
      }
    } catch {}
    return clampPos(
      defaultPos(size, bottomInset, defaultSide, defaultBottomOffset).x,
      defaultPos(size, bottomInset, defaultSide, defaultBottomOffset).y,
      size,
      topInset,
      bottomInset,
    )
  })
  const [keyboardHeight, setKeyboardHeight] = useState(0)
  const [transition, setTransition] = useState('')

  const isDragging = useRef(false)
  const startPointer = useRef<Pos>({ x: 0, y: 0 })
  const startPos = useRef<Pos>({ x: 0, y: 0 })
  const moved = useRef(false)
  const mounted = useRef(false)
  const posRef = useRef(pos)
  posRef.current = pos

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    localStorage.setItem(storageKey, JSON.stringify(pos))
  }, [pos, storageKey])

  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const viewport = vv
    function update() {
      const kbH = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
      setKeyboardHeight(kbH)
    }
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    update()
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
    }
  }, [])

  const prevKeyboardHeight = useRef(keyboardHeight)
  useEffect(() => {
    if (prevKeyboardHeight.current === keyboardHeight) return
    prevKeyboardHeight.current = keyboardHeight
    setTransition('top 0.22s ease, left 0.22s ease')
    const timeoutId = setTimeout(() => setTransition(''), 260)
    return () => clearTimeout(timeoutId)
  }, [keyboardHeight])

  useEffect(() => {
    setPos(current => {
      const clamped = clampPos(current.x, current.y, size, topInset, bottomInset)
      return { x: snapToEdge(clamped.x, size), y: clamped.y }
    })
  }, [size, topInset, bottomInset])

  useEffect(() => {
    function onResize() {
      setPos(current => {
        const clamped = clampPos(current.x, current.y, size, topInset, bottomInset)
        return { x: snapToEdge(clamped.x, size), y: clamped.y }
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [size, topInset, bottomInset])

  const effectiveBottomInset = bottomInset + keyboardHeight
  const renderedPos = clampPos(pos.x, pos.y, size, topInset, effectiveBottomInset)

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    isDragging.current = true
    moved.current = false
    startPointer.current = { x: e.clientX, y: e.clientY }
    startPos.current = posRef.current
    setTransition('')
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging.current) return
    const dx = e.clientX - startPointer.current.x
    const dy = e.clientY - startPointer.current.y
    if (!moved.current && Math.hypot(dx, dy) >= DRAG_THRESHOLD) moved.current = true
    if (!moved.current) return
    setPos(clampPos(startPos.current.x + dx, startPos.current.y + dy, size, topInset, effectiveBottomInset))
  }, [size, topInset, effectiveBottomInset])

  const finishDrag = useCallback((clientX: number, clientY: number) => {
    const dx = clientX - startPointer.current.x
    const dy = clientY - startPointer.current.y
    const raw = clampPos(startPos.current.x + dx, startPos.current.y + dy, size, topInset, effectiveBottomInset)
    const snapped: Pos = { x: snapToEdge(raw.x, size), y: raw.y }
    setTransition('left 0.28s cubic-bezier(0.34,1.56,0.64,1)')
    setPos(snapped)
    localStorage.setItem(storageKey, JSON.stringify(snapped))
  }, [effectiveBottomInset, size, storageKey, topInset])

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging.current) return
    e.preventDefault()
    isDragging.current = false
    if (!moved.current) {
      onClick(e.currentTarget)
      return
    }
    finishDrag(e.clientX, e.clientY)
  }, [finishDrag, onClick])

  const onPointerCancel = useCallback(() => {
    isDragging.current = false
    moved.current = false
  }, [])

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    onClick(e.currentTarget)
  }, [onClick])

  return (
    <div
      role="button"
      tabIndex={0}
      title={title}
      aria-label={ariaLabel ?? title}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      style={{
        position: 'fixed',
        left: renderedPos.x,
        top: renderedPos.y,
        width: size,
        height: size,
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'grab',
        zIndex,
        userSelect: 'none',
        touchAction: 'none',
        transition,
        ...style,
      }}
    >
      {children}
      {badge}
    </div>
  )
}
