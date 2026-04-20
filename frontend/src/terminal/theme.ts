import type { ITheme } from '@xterm/xterm'

export const THEME_KEY = 'nexus_theme'

export type ThemeMode = 'dark' | 'light'

const DARK_THEME: ITheme = {
  background: '#0f172a',
  foreground: '#e2e8f0',
  cursor: '#94a3b8',
  cursorAccent: '#0f172a',
  selectionBackground: '#3b82f660',
  selectionForeground: '#f1f5f9',
  black: '#1a1a2e',
  brightBlack: '#4a5568',
  red: '#fc8181',
  brightRed: '#feb2b2',
  green: '#68d391',
  brightGreen: '#9ae6b4',
  yellow: '#f6e05e',
  brightYellow: '#faf089',
  blue: '#63b3ed',
  brightBlue: '#90cdf4',
  magenta: '#b794f4',
  brightMagenta: '#d6bcfa',
  cyan: '#76e4f7',
  brightCyan: '#b2f5ea',
  white: '#e2e8f0',
  brightWhite: '#f7fafc',
}

const LIGHT_THEME: ITheme = {
  background: '#ffffff',
  foreground: '#1e293b',
  cursor: '#475569',
  cursorAccent: '#f8fafc',
  selectionBackground: '#bfdbfe',
  selectionForeground: '#1e293b',
  black: '#000000',
  brightBlack: '#666666',
  red: '#cd3131',
  brightRed: '#f14c4c',
  green: '#00bc00',
  brightGreen: '#23d18b',
  yellow: '#949800',
  brightYellow: '#f5f543',
  blue: '#0451a5',
  brightBlue: '#3b8eea',
  magenta: '#bc05bc',
  brightMagenta: '#d670d6',
  cyan: '#0598bc',
  brightCyan: '#29b8db',
  white: '#cccccc',
  brightWhite: '#e5e5e5',
}

export const THEMES: Record<ThemeMode, ITheme> = {
  dark: DARK_THEME,
  light: LIGHT_THEME,
}

export function getInitialTheme(): ThemeMode {
  const saved = localStorage.getItem(THEME_KEY)
  if (saved === 'light' || saved === 'dark') return saved
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

// 主题色板 — 统一 Tailwind slate 色阶
export function applyNexusCssVars(mode: ThemeMode) {
  const isDark = mode === 'dark'
  const root = document.documentElement
  root.classList.toggle('light', !isDark)
  root.style.colorScheme = isDark ? 'dark' : 'light'
  root.style.setProperty('--nexus-bg', isDark ? '#0f172a' : '#ffffff')
  root.style.setProperty('--nexus-bg2', isDark ? '#1e293b' : '#f1f5f9')
  root.style.setProperty('--nexus-menu-bg', isDark ? '#1e293b' : '#ffffff')
  root.style.setProperty('--nexus-border', isDark ? '#334155' : '#e2e8f0')
  root.style.setProperty('--nexus-text', isDark ? '#f1f5f9' : '#0f172a')
  root.style.setProperty('--nexus-text2', isDark ? '#94a3b8' : '#64748b')
  root.style.setProperty('--nexus-muted', isDark ? '#475569' : '#94a3b8')
  root.style.setProperty('--nexus-tab-active', isDark ? '#1e293b' : '#f1f5f9')
  root.style.setProperty('--nexus-accent', '#3b82f6')
  root.style.setProperty('--nexus-success', '#22c55e')
  root.style.setProperty('--nexus-warning', '#f59e0b')
  root.style.setProperty('--nexus-error', '#ef4444')
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', isDark ? '#0f172a' : '#ffffff')
}
