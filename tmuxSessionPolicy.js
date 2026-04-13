export function resolvePassiveAttachTarget({ sessionExists, existingWindows = [], requestedWindowIndex }) {
  if (!sessionExists) return { ok: false, reason: 'session_missing' }

  const windows = existingWindows
    .map((index) => Number(index))
    .filter((index) => Number.isInteger(index) && index >= 0)

  if (windows.length === 0) return { ok: false, reason: 'window_missing' }
  if (windows.includes(requestedWindowIndex)) return { ok: true, windowIndex: requestedWindowIndex }
  return { ok: true, windowIndex: windows[0] }
}
