export function buildCodexSessionDetailFields(detail) {
  const fields = [
    ['source', detail?.source],
    ['originator', detail?.originator],
    ['cliVersion', detail?.cliVersion],
    ['modelProvider', detail?.modelProvider],
    ['startedAt', detail?.startedAt],
  ]

  return fields
    .filter(([, value]) => String(value || '').trim() !== '')
    .map(([key, value]) => ({ key, value: String(value) }))
}
