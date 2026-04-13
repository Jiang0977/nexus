export const CLAUDE_SHELL_TYPE = 'claude'
export const ZSH_SHELL_TYPE = 'bash'
export const DEFAULT_SHELL_TYPE = ZSH_SHELL_TYPE

/**
 * 历史协议里使用 "bash" 表示非 Claude 的交互 shell。
 * 当前实现实际启动的是 zsh，因此这里先只做兼容映射。
 *
 * @param {string | null | undefined} shellType
 * @returns {'claude' | 'bash'}
 */
export function normalizeShellType(shellType) {
  return shellType === CLAUDE_SHELL_TYPE ? CLAUDE_SHELL_TYPE : ZSH_SHELL_TYPE
}

/**
 * @param {string | null | undefined} shellType
 * @returns {boolean}
 */
export function usesClaudeProfile(shellType) {
  return normalizeShellType(shellType) === CLAUDE_SHELL_TYPE
}
