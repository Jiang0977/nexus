import type { Terminal } from '@xterm/xterm'
import { Unicode11Addon } from '@xterm/addon-unicode11'

// This policy must match the generated native width table. Do not upgrade one
// side alone: reconnection resumes the original PTY byte stream.
export function configureTerminalUnicode(term: Terminal) {
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
}
