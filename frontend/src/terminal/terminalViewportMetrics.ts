import type { Terminal } from '@xterm/xterm'

// Public buffer coordinates are the source of truth. xterm 6 uses a virtual
// scrollbar; the legacy viewport element's scrollTop is no longer meaningful.
export function bindTerminalViewportMetrics(term: Terminal, container: HTMLElement): () => void {
  function sync() {
    const values = {
      terminalViewportY: term.buffer.active.viewportY,
      terminalBaseY: term.buffer.active.baseY,
      terminalRows: term.rows,
    }
    for (const [key, value] of Object.entries(values)) {
      const text = String(value)
      if (container.dataset[key] !== text) container.dataset[key] = text
    }
  }
  sync()
  const subscriptions = [term.onScroll(sync), term.onWriteParsed(sync), term.onResize(sync)]
  return () => {
    for (const subscription of subscriptions) subscription.dispose()
    delete container.dataset.terminalViewportY
    delete container.dataset.terminalBaseY
    delete container.dataset.terminalRows
  }
}
