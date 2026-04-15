export function isCodexHistoryEnabled(config) {
  const value = config?.features?.codexHistory
  return value === undefined ? true : value !== false
}
