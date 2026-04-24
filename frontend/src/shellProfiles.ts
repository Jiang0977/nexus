import {
  CLAUDE_SHELL_TYPE,
  CODEX_SHELL_TYPE,
  DEFAULT_SHELL_TYPE,
  normalizeShellType,
  usesClaudeProfile,
  usesCodexProfile,
  type ShellType,
} from './shellType'

export interface ShellProfileOption {
  id: string
  label: string
}

export interface CcSwitchProviderOption {
  provider_id: string
  kind: 'claude' | 'codex'
  name: string
  is_current: boolean
  existing_profile_id?: string | null
  target_profile_id: string
}

export interface ProjectShellDefault {
  path: string
  shell_type: ShellType
  profile: string | null
}

const LAST_SHELL_TYPE_KEY = 'nexus_last_shell_type'
const PROFILE_STORAGE_KEYS: Record<typeof CLAUDE_SHELL_TYPE | typeof CODEX_SHELL_TYPE, string> = {
  [CLAUDE_SHELL_TYPE]: 'nexus_last_profile_claude',
  [CODEX_SHELL_TYPE]: 'nexus_last_profile_codex',
}

export function getProfileApiEndpoint(shellType: ShellType | string | null | undefined): string | null {
  if (usesClaudeProfile(shellType)) return '/api/configs'
  if (usesCodexProfile(shellType)) return '/api/codex-configs'
  return null
}

export function getStoredShellType(): ShellType {
  if (typeof window === 'undefined') return DEFAULT_SHELL_TYPE
  return normalizeShellType(window.localStorage.getItem(LAST_SHELL_TYPE_KEY) || DEFAULT_SHELL_TYPE)
}

export function storeShellType(shellType: ShellType) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(LAST_SHELL_TYPE_KEY, normalizeShellType(shellType))
}

export function getStoredProfileForShell(shellType: ShellType | string | null | undefined): string {
  if (typeof window === 'undefined') return ''
  if (usesClaudeProfile(shellType)) return window.localStorage.getItem(PROFILE_STORAGE_KEYS[CLAUDE_SHELL_TYPE]) || ''
  if (usesCodexProfile(shellType)) return window.localStorage.getItem(PROFILE_STORAGE_KEYS[CODEX_SHELL_TYPE]) || ''
  return ''
}

export function storeProfileForShell(shellType: ShellType | string | null | undefined, profileId: string) {
  if (typeof window === 'undefined') return
  if (usesClaudeProfile(shellType)) {
    window.localStorage.setItem(PROFILE_STORAGE_KEYS[CLAUDE_SHELL_TYPE], profileId)
  } else if (usesCodexProfile(shellType)) {
    window.localStorage.setItem(PROFILE_STORAGE_KEYS[CODEX_SHELL_TYPE], profileId)
  }
}

export function pickProfileForShell(
  shellType: ShellType,
  profiles: ShellProfileOption[],
  preferredProfile = '',
  fallbackProfiles: string[] = [],
): string {
  if (!profiles.length) return ''
  const candidates = [
    preferredProfile,
    ...fallbackProfiles,
    getStoredProfileForShell(shellType),
  ]
  for (const candidate of candidates) {
    if (candidate && profiles.some(profile => profile.id === candidate)) {
      return candidate
    }
  }
  return profiles[0]?.id || ''
}

export async function fetchProfilesForShell(
  token: string,
  shellType: ShellType,
): Promise<ShellProfileOption[]> {
  const endpoint = getProfileApiEndpoint(shellType)
  if (!endpoint) return []
  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) {
    throw new Error(`Failed to load shell profiles: HTTP ${response.status}`)
  }
  const data = await response.json()
  return Array.isArray(data) ? data : []
}

export async function fetchCurrentCcSwitchProfileForShell(
  token: string,
  shellType: ShellType,
): Promise<string> {
  const kind = usesCodexProfile(shellType)
    ? 'codex'
    : usesClaudeProfile(shellType)
      ? 'claude'
      : null
  if (!kind) return ''

  const response = await fetch(`/api/cc-switch/providers?kind=${kind}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) {
    throw new Error(`Failed to load cc-switch providers: HTTP ${response.status}`)
  }
  const data = await response.json()
  if (!Array.isArray(data)) return ''
  const currentProvider = (data as CcSwitchProviderOption[]).find(provider => provider?.is_current)
  return currentProvider?.existing_profile_id || currentProvider?.target_profile_id || ''
}

export async function fetchProjectShellDefault(
  token: string,
  projectPath: string,
): Promise<ProjectShellDefault | null> {
  const trimmed = projectPath.trim()
  if (!trimmed) return null
  const response = await fetch(`/api/project-defaults?path=${encodeURIComponent(trimmed)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) {
    throw new Error(`Failed to load project shell defaults: HTTP ${response.status}`)
  }
  const data = await response.json()
  return data?.shell_type ? data as ProjectShellDefault : null
}
