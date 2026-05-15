import type { Channel } from './types'

export function visibleChannelsForProject(
  channels: Channel[],
  channelsProject: string,
  currentProject: string,
): Channel[] {
  return channelsProject === currentProject.trim() ? channels : []
}
