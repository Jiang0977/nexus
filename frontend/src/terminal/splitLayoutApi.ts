import type { WorkspaceLayout } from './splitLayoutTypes'

export async function fetchActiveWorkspaceLayout(token: string): Promise<WorkspaceLayout> {
  const response = await fetch('/api/workspace-layouts/active', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return await response.json() as WorkspaceLayout
}

export async function saveActiveWorkspaceLayout(token: string, layout: WorkspaceLayout): Promise<WorkspaceLayout> {
  const response = await fetch('/api/workspace-layouts/active', {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(layout),
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return await response.json() as WorkspaceLayout
}
