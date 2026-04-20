export interface Channel {
  index: number
  name: string
  active: boolean
  cwd: string
}

export interface Project {
  name: string
  path: string
  active: boolean
  channelCount: number
}

export type SessionManagerSidebarDetailView = 'channels' | 'codex'
