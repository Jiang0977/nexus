export interface KeyDef {
  id: string
  label: string
  seq: string
  desc: string
  action?: 'scrollToBottom' | 'pasteClipboard' | 'copyTerminal' | 'fit'
  category: 'nav' | 'edit' | 'control' | 'input' | 'ui'
}

export interface ToolbarConfig {
  pinned: string[]
  expanded: string[]
}

export type ToolbarTranslate = (key: string) => string

// Unified label conventions:
// - Ctrl+X for control-key terminal input
// - Alt+X for alt/meta terminal input
// - Shift+Tab for reverse tab
// - Single symbols for arrows (↑↓←→), Enter (↵), Tab (⇥), Backspace (⌫)
// - Local UI actions use function text instead of pretending to send a key

export const ALL_KEYS: KeyDef[] = [
  // === Navigation (nav) ===
  { id: 'up',         label: '↑',     seq: '\x1b[A',   desc: 'toolbarKeys.prevHistory', category: 'nav' },
  { id: 'down',       label: '↓',     seq: '\x1b[B',   desc: 'toolbarKeys.nextHistory', category: 'nav' },
  { id: 'left',       label: '←',     seq: '\x1b[D',   desc: 'toolbarKeys.cursorLeft', category: 'nav' },
  { id: 'right',      label: '→',     seq: '\x1b[C',   desc: 'toolbarKeys.cursorRight', category: 'nav' },
  { id: 'ctrl-a',     label: 'Ctrl+A', seq: '\x01',     desc: 'toolbarKeys.lineStart', category: 'nav' },
  { id: 'ctrl-e',     label: 'Ctrl+E', seq: '\x05',     desc: 'toolbarKeys.lineEnd', category: 'nav' },
  { id: 'alt-b',      label: 'Alt+B', seq: '\x1bb',    desc: 'toolbarKeys.wordBack', category: 'nav' },
  { id: 'alt-f',      label: 'Alt+F', seq: '\x1bf',    desc: 'toolbarKeys.wordForward', category: 'nav' },

  // === Editing (edit) ===
  { id: 'backspace',  label: '⌫',    seq: '\x7f',     desc: 'toolbarKeys.backspace', category: 'edit' },
  { id: 'tab',        label: '⇥',     seq: '\t',       desc: 'toolbarKeys.acceptSuggestion', category: 'edit' },
  { id: 'ctrl-u',     label: 'Ctrl+U', seq: '\x15',     desc: 'toolbarKeys.deleteLine', category: 'edit' },
  { id: 'ctrl-k',     label: 'Ctrl+K', seq: '\x0b',     desc: 'toolbarKeys.deleteToEnd', category: 'edit' },
  { id: 'ctrl-y',     label: 'Ctrl+Y', seq: '\x19',     desc: 'toolbarKeys.yank', category: 'edit' },
  { id: 'ctrl-d',     label: 'Ctrl+D', seq: '\x04',     desc: 'toolbarKeys.exitEof', category: 'edit' },
  { id: 'ctrl-j',     label: 'Ctrl+J', seq: '\x0a',     desc: 'toolbarKeys.newline', category: 'edit' },
  { id: 'ctrl-z',     label: 'Ctrl+Z', seq: '\x1a',     desc: 'toolbarKeys.suspend', category: 'edit' },

  // === Control (control) ===
  { id: 'esc',        label: 'Esc',   seq: '\x1b',     desc: 'toolbarKeys.escapeVim', category: 'control' },
  { id: 'ctrl-c',     label: 'Ctrl+C', seq: '\x03',     desc: 'toolbarKeys.cancelInput', category: 'control' },
  { id: 'enter',      label: '↵',     seq: '\r',       desc: 'toolbarKeys.submit', category: 'control' },
  { id: 'ctrl-l',     label: 'Ctrl+L', seq: '\x0c',     desc: 'toolbarKeys.clearScreen', category: 'control' },
  { id: 'ctrl-r',     label: 'Ctrl+R', seq: '\x12',     desc: 'toolbarKeys.historySearch', category: 'control' },
  { id: 'ctrl-o',     label: 'Ctrl+O', seq: '\x0f',     desc: 'toolbarKeys.toggleVerbose', category: 'control' },
  { id: 'ctrl-t',     label: 'Ctrl+T', seq: '\x14',     desc: 'toolbarKeys.taskListToggle', category: 'control' },
  { id: 'ctrl-b',     label: 'Ctrl+B', seq: '\x02',     desc: 'toolbarKeys.backgroundTask', category: 'control' },
  { id: 'ctrl-g',     label: 'Ctrl+G', seq: '\x07',     desc: 'toolbarKeys.openInEditor', category: 'control' },
  { id: 'ctrl-f',     label: 'Ctrl+F', seq: '\x06',     desc: 'toolbarKeys.killAgents', category: 'control' },

  // === Input (input) ===
  { id: 'slash',      label: '/',     seq: '/',        desc: 'toolbarKeys.slashCommand', category: 'input' },
  { id: 'bang',       label: '!',     seq: '!',        desc: 'toolbarKeys.bashMode', category: 'input' },
  { id: 'at',         label: '@',     seq: '@',        desc: 'toolbarKeys.filePathComplete', category: 'input' },
  { id: 'backslash',  label: '\\',    seq: '\\',       desc: 'toolbarKeys.backslash', category: 'input' },
  { id: 'ctrl-v',     label: 'Ctrl+V', seq: '',         desc: 'toolbarKeys.pasteClipboard', action: 'pasteClipboard', category: 'input' },
  { id: 'shift-tab',  label: 'Shift+Tab', seq: '\x1b[Z',   desc: 'toolbarKeys.togglePermission', category: 'input' },

  // === UI Actions (ui) ===
  { id: 'scroll-btm', label: '↓↓',   seq: '',         desc: 'toolbarKeys.scrollBottom', action: 'scrollToBottom', category: 'ui' },
  { id: 'copy-term',  label: 'Cp',    seq: '',         desc: 'toolbarKeys.copyTerminal', action: 'copyTerminal', category: 'ui' },
  { id: 'fit',        label: 'Fit',   seq: '',         desc: 'toolbarKeys.fitTerminal', action: 'fit', category: 'ui' },
]

export function isToolbarLocalAction(key: KeyDef): boolean {
  return Boolean(key.action)
}

export function isToolbarTerminalInput(key: KeyDef): boolean {
  return !isToolbarLocalAction(key)
}

export function getToolbarButtonText(key: KeyDef, t: ToolbarTranslate): string {
  if (isToolbarLocalAction(key)) return t(key.desc)
  return `${key.label} · ${t(key.desc)}`
}

// Reorganized factory defaults by priority and category grouping
export const FACTORY_PINNED = [
  // Control
  'esc', 
  // Navigation
   'ctrl-a', 'left', 'up', 'down', 'right', 'ctrl-e',
  'backspace', 
  // Input — \ / adjacent
  'backslash', 'slash',
  // Clipboard
  'ctrl-c', 'ctrl-v',  'enter', 
]

export const FACTORY_EXPANDED = [
  // Navigation group
  'alt-b', 'alt-f',  
  // Editing group
  'ctrl-d', 'ctrl-u', 'ctrl-j', 'ctrl-k', 'ctrl-l', 'ctrl-y', 'ctrl-z', 
  // Control group
  'ctrl-r', 'ctrl-b', 'ctrl-o', 'ctrl-t', 'ctrl-f', 'ctrl-g',
  // Input group
  'tab', 'shift-tab', 'bang', 'at',
  // UI Actions
  'scroll-btm', 'copy-term', 'fit',
]

export const FACTORY_CONFIG: ToolbarConfig = {
  pinned: FACTORY_PINNED,
  expanded: FACTORY_EXPANDED,
}
