import { useEffect, useMemo, useState, type MutableRefObject } from 'react'
import type { Terminal as XTerm } from '@xterm/xterm'
import { Icon } from '../icons'
import { PaneDropTarget } from './PaneDropTarget'
import { PaneHeader } from './PaneHeader'
import { paneTargetKey, type LayoutMode, type PaneState, type PaneTarget } from './splitLayoutTypes'
import { useTerminalPaneRuntime, type PaneConnectionState } from './useTerminalPaneRuntime'
import type { ThemeMode } from './theme'

export interface FocusedPaneRuntime {
  fitTerminal: () => void
  scrollToBottom: () => void
  sendToWs: (data: string) => boolean
  target: PaneTarget | null
  termRef: MutableRefObject<XTerm | null>
}

export type PaneStatus = PaneConnectionState | 'checking' | 'stale'

interface Props {
  compact?: boolean
  focused: boolean
  index: number
  onClearTarget: (paneId: string) => void
  onFocusedRuntimeReady: (paneId: string, runtime: FocusedPaneRuntime) => void
  onFocusPane: (paneId: string, runtime: FocusedPaneRuntime) => void
  onPaneStatusChange: (paneId: string, status: PaneStatus) => void
  onOpenScrollback: (target: PaneTarget, windowName?: string) => void
  onSetTarget: (paneId: string, target: PaneTarget) => void
  layoutMode: LayoutMode
  pane: PaneState
  themeMode: ThemeMode
  token: string
}

interface TargetCheck {
  status: 'empty' | 'checking' | 'valid' | 'stale'
  targetKey: string | null
  windowName?: string
}

export function TerminalPane({
  compact = false,
  focused,
  index,
  onClearTarget,
  onFocusedRuntimeReady,
  onFocusPane,
  onPaneStatusChange,
  onOpenScrollback,
  onSetTarget,
  layoutMode,
  pane,
  themeMode,
  token,
}: Props) {
  const [targetCheck, setTargetCheck] = useState<TargetCheck>(() => ({
    status: pane.target ? 'checking' : 'empty',
    targetKey: paneTargetKey(pane.target),
  }))

  useEffect(() => {
    if (!pane.target) {
      setTargetCheck({ status: 'empty', targetKey: null })
      return
    }

    let cancelled = false
    const target = pane.target
    const targetKey = paneTargetKey(target)
    setTargetCheck({ status: 'checking', targetKey })
    fetch(`/api/sessions?session=${encodeURIComponent(target.session)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (response) => {
        if (cancelled) return
        if (!response.ok) {
          setTargetCheck({ status: 'valid', targetKey })
          return
        }
        const data = await response.json() as { windows?: Array<{ index: number; name: string }> }
        if (cancelled) return
        const windowInfo = (data.windows || []).find((window) => window.index === target.windowIndex)
        if (!windowInfo) {
          setTargetCheck({ status: 'stale', targetKey })
          return
        }
        setTargetCheck({ status: 'valid', targetKey, windowName: windowInfo.name })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        console.error('[TerminalPane] Failed to validate pane target', {
          error,
          paneId: pane.id,
          target,
        })
        setTargetCheck({ status: 'valid', targetKey })
      })

    return () => {
      cancelled = true
    }
  }, [pane.id, pane.target?.session, pane.target?.windowIndex, token])

  const currentTargetKey = paneTargetKey(pane.target)
  const targetCheckMatchesCurrentTarget = targetCheck.targetKey === currentTargetKey
  const runtimeEnabled = Boolean(
    pane.target
    && targetCheckMatchesCurrentTarget
    && targetCheck.status === 'valid',
  )
  const runtime = useTerminalPaneRuntime({
    compact,
    enabled: runtimeEnabled,
    target: pane.target,
    themeMode,
    token,
  })

  const currentTargetStatus = targetCheckMatchesCurrentTarget ? targetCheck.status : 'checking'
  const paneStatus: PaneStatus = !pane.target
    ? 'empty'
    : currentTargetStatus === 'checking'
      ? 'checking'
      : currentTargetStatus === 'stale'
        ? 'stale'
        : runtime.connectionState
  const currentWindowName = targetCheckMatchesCurrentTarget ? targetCheck.windowName : undefined

  const runtimeHandle = useMemo<FocusedPaneRuntime>(() => ({
    fitTerminal: runtime.fitNow,
    scrollToBottom: runtime.scrollToBottom,
    sendToWs: runtime.sendToWs,
    target: pane.target,
    termRef: runtime.termRef,
  }), [pane.target, runtime.fitNow, runtime.scrollToBottom, runtime.sendToWs, runtime.termRef])

  useEffect(() => {
    onPaneStatusChange(pane.id, paneStatus)
  }, [onPaneStatusChange, pane.id, paneStatus])

  useEffect(() => {
    if (!focused) return
    onFocusedRuntimeReady(pane.id, runtimeHandle)
  }, [focused, onFocusedRuntimeReady, pane.id, runtime.connectionState, runtimeHandle])

  useEffect(() => {
    if (!pane.target || !targetCheckMatchesCurrentTarget || targetCheck.status !== 'valid') return
    const rafId = requestAnimationFrame(() => runtime.fitNow())
    const timerId = window.setTimeout(() => runtime.fitNow(), 120)
    return () => {
      cancelAnimationFrame(rafId)
      window.clearTimeout(timerId)
    }
  }, [layoutMode, pane.target, runtime.fitNow, targetCheckMatchesCurrentTarget, targetCheck.status])

  const focusPane = () => {
    runtime.termRef.current?.focus()
    onFocusPane(pane.id, runtimeHandle)
  }
  const focusPaneFromPointer = (target: EventTarget | null) => {
    if ((target as HTMLElement | null)?.closest('button')) return
    focusPane()
  }

  const openScrollback = () => {
    if (!pane.target) return
    onOpenScrollback(pane.target, currentWindowName)
  }

  return (
    <section
      data-testid={`terminal-pane-${pane.id}`}
      className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded border bg-nexus-bg ${
        focused ? 'border-nexus-accent shadow-[inset_0_0_0_1px_var(--nexus-accent)]' : 'border-nexus-border'
      }`}
      onClick={(event) => focusPaneFromPointer(event.target)}
      onPointerDownCapture={(event) => focusPaneFromPointer(event.target)}
    >
      <PaneHeader
        focused={focused}
        health={paneStatus}
        index={index}
        onClear={() => onClearTarget(pane.id)}
        onFit={runtime.fitNow}
        onOpenScrollback={openScrollback}
        target={pane.target}
        windowName={currentWindowName}
      />

      <PaneDropTarget
        empty={!pane.target}
        onDropTarget={(target) => {
          onSetTarget(pane.id, target)
        }}
      >
        {pane.target && targetCheckMatchesCurrentTarget && targetCheck.status === 'stale' ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-red-950/10 px-4 text-center">
            <Icon name="alert" size={28} className="text-nexus-error" />
            <div className="text-base font-medium text-nexus-error">窗口不存在</div>
            <div className="max-w-[280px] text-sm text-nexus-text-2">
              该窗口可能已关闭或会话已被清理。
            </div>
            <div className="flex items-center gap-2">
              <button
                className="rounded border border-nexus-border px-3 py-1.5 text-sm text-nexus-text hover:bg-nexus-bg2"
                type="button"
              >
                替换
              </button>
              <button
                className="rounded border border-nexus-border px-3 py-1.5 text-sm text-nexus-text hover:bg-nexus-bg2"
                onClick={() => onClearTarget(pane.id)}
                type="button"
              >
                移除
              </button>
            </div>
          </div>
        ) : pane.target ? (
          <div className="relative flex min-h-0 min-w-0 flex-1">
            <div ref={runtime.containerRef} className="nexus-split-terminal min-h-0 min-w-0 flex-1 overflow-hidden px-2 py-1" />
            {runtime.connectionState === 'loading' && (
              <div className="pointer-events-none absolute right-3 top-3 rounded border border-nexus-border bg-nexus-bg/90 px-2 py-1 text-xs text-nexus-text-2">
                连接中...
              </div>
            )}
            {runtime.connectionState === 'error' && runtime.errorMessage && (
              <div className="pointer-events-none absolute bottom-3 left-3 right-3 truncate rounded border border-red-500/40 bg-red-950/40 px-2 py-1 text-xs text-red-200">
                {runtime.errorMessage}
              </div>
            )}
            {runtime.isScrolledUp && (
              <button
                className="absolute bottom-3 right-3 rounded border border-nexus-border bg-nexus-bg/90 px-2 py-1 text-xs text-nexus-text hover:bg-nexus-bg2"
                onClick={runtime.scrollToBottom}
                type="button"
              >
                回到底部
              </button>
            )}
          </div>
        ) : null}
      </PaneDropTarget>
    </section>
  )
}
