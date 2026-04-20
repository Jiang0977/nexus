export type ShellType = 'claude' | 'codex' | 'bash'

export const CLAUDE_SHELL_TYPE = 'claude' as const
export const CODEX_SHELL_TYPE = 'codex' as const
export const ZSH_SHELL_TYPE = 'bash' as const
export const DEFAULT_SHELL_TYPE = ZSH_SHELL_TYPE

/**
 * 历史协议里使用 "bash" 表示非 Claude 的交互 shell。
 * 当前实现实际启动的是 zsh，因此这里先只做兼容映射。
 */
export function normalizeShellType(shellType: string | null | undefined): ShellType {
  if (shellType === CLAUDE_SHELL_TYPE || shellType === CODEX_SHELL_TYPE) return shellType
  return ZSH_SHELL_TYPE
}

export function usesClaudeProfile(shellType: string | null | undefined): boolean {
  return normalizeShellType(shellType) === CLAUDE_SHELL_TYPE
}

export function usesCodexProfile(shellType: string | null | undefined): boolean {
  return normalizeShellType(shellType) === CODEX_SHELL_TYPE
}

export function usesShellProfile(shellType: string | null | undefined): boolean {
  const normalized = normalizeShellType(shellType)
  return normalized === CLAUDE_SHELL_TYPE || normalized === CODEX_SHELL_TYPE
}
