import type { Terminal } from '@xterm/xterm'

// Browser clipboard writes only. Never answer OSC 52 '?' queries, even when
// the browser has clipboard-read permission for ordinary user-initiated paste.
export const MAX_OSC52_BYTES = 128 * 1024
export function decodeOsc52(data: string): string | null {
  if (data.length > Math.ceil(MAX_OSC52_BYTES / 3) * 4 + 17) return null
  const separator = data.indexOf(';')
  if (separator < 0) return null
  const selection = data.slice(0, separator)
  const encoded = data.slice(separator + 1)
  // Map the clipboard/default selection only, not X11 primary or cut buffers.
  if (!/^[cpqs0-7]{0,16}$/.test(selection) || (selection && !/[cs]/.test(selection))) return null
  if (!encoded || encoded === '?' || encoded.length > Math.ceil(MAX_OSC52_BYTES / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return null
  try {
    const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0))
    if (bytes.length > MAX_OSC52_BYTES) return null
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch { return null }
}

export function bindTerminalOsc52(term: Terminal, container: HTMLElement) {
  let disposed = false
  let generation = 0
  let request = 0
  let gestureUntil = 0
  let writing = false
  let notice: HTMLDivElement | null = null
  let timer: ReturnType<typeof setTimeout> | undefined

  function clearNotice() {
    clearTimeout(timer)
    notice?.remove()
    notice = null
  }

  function show(message: string, retry?: () => void) {
    clearNotice()
    notice = document.createElement('div')
    notice.className = 'absolute left-2 right-2 top-2 z-50 flex flex-wrap items-center gap-2 rounded border border-nexus-border bg-nexus-bg p-2 text-xs text-nexus-text shadow-lg'
    notice.dataset.terminalClipboard = 'true'
    notice.setAttribute('role', 'status')
    // No HTML or clipboard payload enters this notification.
    const label = document.createElement('span')
    label.textContent = message
    notice.append(label)
    notice.addEventListener('pointerdown', event => event.stopPropagation())
    notice.addEventListener('click', event => event.stopPropagation())
    if (retry) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = '点击复制'
      button.className = 'rounded border border-nexus-border px-2 py-1 text-nexus-accent'
      button.addEventListener('click', retry)
      notice.append(button)
    }
    const dismiss = document.createElement('button')
    dismiss.type = 'button'
    dismiss.textContent = '关闭'
    dismiss.addEventListener('click', clearNotice)
    notice.append(dismiss)
    container.append(notice)
    timer = setTimeout(clearNotice, retry ? 30000 : 2000)
  }

  function onGesture(event: Event) {
    if (event.isTrusted && !notice?.contains(event.target as Node)) gestureUntil = Date.now() + 5000
  }
  for (const type of ['pointerdown', 'pointerup', 'keydown']) container.addEventListener(type, onGesture, true)

  const handler = term.parser.registerOscHandler(52, data => {
    const text = decodeOsc52(data)
    if (disposed || text === null) return true
    const id = ++request, epoch = generation
    const current = () => !disposed && epoch === generation && id === request
    const write = () => {
      if (!current() || writing) return
      writing = true
      // Call from the click handler synchronously to retain user activation.
      let result: Promise<void>
      try { result = navigator.clipboard.writeText(text) }
      catch { result = Promise.reject(new Error('clipboard unavailable')) }
      void result.then(() => {
        if (current()) show('已复制到本机剪贴板')
      }, () => {
        if (current()) show('浏览器未允许自动复制，请点击复制或允许剪贴板权限', write)
      }).finally(() => { writing = false })
    }
    if (!writing && gestureUntil >= Date.now() && document.hasFocus()
      && document.visibilityState === 'visible' && container.contains(document.activeElement)) {
      gestureUntil = 0 // One automatic clipboard write per local interaction.
      write()
    } else {
      show('终端应用请求复制文本', write)
    }
    // Clipboard permissions must not stall xterm output or emit PTY responses.
    return true
  })

  function reset() {
    generation++
    gestureUntil = 0
    clearNotice()
  }
  return {
    reset,
    dispose() {
      disposed = true
      reset()
      handler.dispose()
      for (const type of ['pointerdown', 'pointerup', 'keydown']) container.removeEventListener(type, onGesture, true)
    },
  }
}
