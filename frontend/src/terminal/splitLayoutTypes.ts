export type LayoutMode = 'single' | 'vertical' | 'horizontal' | 'grid-2x2' | 'grid-3x3'

export interface PaneTarget {
  session: string
  windowIndex: number
}

export interface PaneState {
  id: string
  target: PaneTarget | null
}

export interface WorkspaceLayout {
  version: 1
  mode: LayoutMode
  focusedPaneId: string
  panes: PaneState[]
  updatedAt: string
}

export interface SidebarChannelDragPayload {
  type: 'nexus-channel'
  session: string
  windowIndex: number
  name?: string
}

export const LAYOUT_MODES: LayoutMode[] = ['single', 'vertical', 'horizontal', 'grid-2x2', 'grid-3x3']
export const CHANNEL_DRAG_MIME = 'application/x-nexus-channel'

export const PANE_COUNT_BY_MODE: Record<LayoutMode, number> = {
  single: 1,
  vertical: 2,
  horizontal: 2,
  'grid-2x2': 4,
  'grid-3x3': 9,
}

export function createDefaultWorkspaceLayout(): WorkspaceLayout {
  return {
    version: 1,
    mode: 'single',
    focusedPaneId: 'pane-1',
    panes: [{ id: 'pane-1', target: null }],
    updatedAt: new Date().toISOString(),
  }
}

export function normalizeWorkspaceLayout(layout: WorkspaceLayout, mode: LayoutMode = layout.mode): WorkspaceLayout {
  const requiredPaneCount = PANE_COUNT_BY_MODE[mode]
  const paneMap = new Map(layout.panes.map((pane) => [pane.id, pane]))
  const panes = [...layout.panes]

  for (let index = 1; index <= requiredPaneCount; index += 1) {
    const id = `pane-${index}`
    if (!paneMap.has(id)) {
      panes.push({ id, target: null })
    }
  }

  const visiblePaneIds = new Set(Array.from({ length: requiredPaneCount }, (_, index) => `pane-${index + 1}`))
  const focusedPaneId = visiblePaneIds.has(layout.focusedPaneId) ? layout.focusedPaneId : 'pane-1'

  return {
    ...layout,
    mode,
    focusedPaneId,
    panes,
  }
}

export function visiblePanesForLayout(layout: WorkspaceLayout): PaneState[] {
  const normalized = normalizeWorkspaceLayout(layout)
  const count = PANE_COUNT_BY_MODE[normalized.mode]
  return Array.from({ length: count }, (_, index) => {
    const id = `pane-${index + 1}`
    return normalized.panes.find((pane) => pane.id === id) ?? { id, target: null }
  })
}

export function channelTargetKey(session: string, windowIndex: number): string {
  return `${session}:${windowIndex}`
}

export function paneTargetKey(target: PaneTarget | null | undefined): string | null {
  if (!target) return null
  return channelTargetKey(target.session, target.windowIndex)
}

export function parseChannelDragPayload(dataTransfer: DataTransfer | null): SidebarChannelDragPayload | null {
  if (!dataTransfer) return null

  const raw = dataTransfer.getData(CHANNEL_DRAG_MIME) || dataTransfer.getData('text/plain')
  if (!raw) return null

  try {
    const payload = JSON.parse(raw) as Partial<SidebarChannelDragPayload>
    const windowIndex = payload.windowIndex
    if (payload.type !== 'nexus-channel') return null
    if (typeof payload.session !== 'string' || payload.session.trim() === '') return null
    if (typeof windowIndex !== 'number' || !Number.isInteger(windowIndex) || windowIndex < 0) return null
    return {
      type: 'nexus-channel',
      session: payload.session.trim(),
      windowIndex,
      name: typeof payload.name === 'string' ? payload.name : undefined,
    }
  } catch {
    return null
  }
}

export function hasChannelDragPayload(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  return Array.from(dataTransfer.types).includes(CHANNEL_DRAG_MIME)
}
