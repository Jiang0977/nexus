export type ShellType = 'claude' | 'bash'

export const CLAUDE_SHELL_TYPE: 'claude'
export const ZSH_SHELL_TYPE: 'bash'
export const DEFAULT_SHELL_TYPE: 'bash'

export function normalizeShellType(shellType: string | null | undefined): ShellType
export function usesClaudeProfile(shellType: string | null | undefined): boolean
