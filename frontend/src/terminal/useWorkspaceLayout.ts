import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchActiveWorkspaceLayout, saveActiveWorkspaceLayout } from './splitLayoutApi'
import {
  createDefaultWorkspaceLayout,
  normalizeWorkspaceLayout,
  type LayoutMode,
  type PaneTarget,
  type WorkspaceLayout,
} from './splitLayoutTypes'

type SaveState = 'loading' | 'saving' | 'saved' | 'unsaved'

function withTimestamp(layout: WorkspaceLayout): WorkspaceLayout {
  return { ...layout, updatedAt: new Date().toISOString() }
}

export function useWorkspaceLayout(token: string) {
  const [layout, setLayout] = useState<WorkspaceLayout>(() => createDefaultWorkspaceLayout())
  const [saveState, setSaveState] = useState<SaveState>('loading')
  const [error, setError] = useState<string | null>(null)
  const latestSaveRef = useRef(0)
  const loadedRef = useRef(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    loadedRef.current = false
    setSaveState('loading')
    setError(null)

    fetchActiveWorkspaceLayout(token)
      .then((remoteLayout) => {
        if (cancelled || !mountedRef.current) return
        setLayout(normalizeWorkspaceLayout(remoteLayout))
        loadedRef.current = true
        setSaveState('saved')
      })
      .catch((loadError: unknown) => {
        if (cancelled || !mountedRef.current) return
        console.error('[useWorkspaceLayout] Failed to load active workspace layout', loadError)
        setLayout(createDefaultWorkspaceLayout())
        loadedRef.current = true
        setSaveState('unsaved')
        setError('load_failed')
      })

    return () => {
      cancelled = true
    }
  }, [token])

  const persistLayout = useCallback((nextLayout: WorkspaceLayout) => {
    const saveId = latestSaveRef.current + 1
    latestSaveRef.current = saveId
    setSaveState('saving')
    setError(null)

    saveActiveWorkspaceLayout(token, nextLayout)
      .then((savedLayout) => {
        if (!mountedRef.current || latestSaveRef.current !== saveId) return
        setLayout(normalizeWorkspaceLayout(savedLayout))
        setSaveState('saved')
      })
      .catch((saveError: unknown) => {
        if (!mountedRef.current || latestSaveRef.current !== saveId) return
        console.error('[useWorkspaceLayout] Failed to save active workspace layout', saveError)
        setSaveState('unsaved')
        setError('save_failed')
      })
  }, [token])

  const updateLayout = useCallback((updater: (current: WorkspaceLayout) => WorkspaceLayout) => {
    setLayout((current) => {
      const nextLayout = withTimestamp(normalizeWorkspaceLayout(updater(normalizeWorkspaceLayout(current))))
      persistLayout(nextLayout)
      return nextLayout
    })
  }, [persistLayout])

  const setMode = useCallback((mode: LayoutMode) => {
    updateLayout((current) => normalizeWorkspaceLayout(current, mode))
  }, [updateLayout])

  const focusPane = useCallback((paneId: string) => {
    setLayout((current) => {
      if (current.focusedPaneId === paneId) return current
      const nextLayout = withTimestamp(normalizeWorkspaceLayout({ ...current, focusedPaneId: paneId }))
      if (loadedRef.current) {
        persistLayout(nextLayout)
      }
      return nextLayout
    })
  }, [persistLayout])

  const setPaneTarget = useCallback((paneId: string, target: PaneTarget | null) => {
    updateLayout((current) => {
      const normalized = normalizeWorkspaceLayout(current)
      const panes = normalized.panes.map((pane) => pane.id === paneId ? { ...pane, target } : pane)
      if (!panes.some((pane) => pane.id === paneId)) {
        panes.push({ id: paneId, target })
      }
      return {
        ...normalized,
        focusedPaneId: paneId,
        panes,
      }
    })
  }, [updateLayout])

  return {
    error,
    focusPane,
    layout,
    saveState,
    setMode,
    setPaneTarget,
  }
}
