export type ShellType = 'claude' | 'codex' | 'bash'

export const CLAUDE_SHELL_TYPE: 'claude'
export const CODEX_SHELL_TYPE: 'codex'
export const ZSH_SHELL_TYPE: 'bash'
export const DEFAULT_SHELL_TYPE: 'bash'

export function normalizeShellType(shellType: string | null | undefined): ShellType
export function usesClaudeProfile(shellType: string | null | undefined): boolean
export function usesCodexProfile(shellType: string | null | undefined): boolean
export function usesShellProfile(shellType: string | null | undefined): boolean
