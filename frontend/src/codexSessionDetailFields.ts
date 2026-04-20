export interface CodexSessionDetailField {
  key: 'source' | 'originator' | 'cliVersion' | 'modelProvider' | 'startedAt'
  value: string
}

export interface CodexSessionDetailShape {
  source?: string
  originator?: string
  cliVersion?: string
  modelProvider?: string
  startedAt?: string
}

export function buildCodexSessionDetailFields(
  detail: CodexSessionDetailShape | null | undefined,
): CodexSessionDetailField[] {
  const fields: Array<[CodexSessionDetailField['key'], string | undefined]> = [
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
