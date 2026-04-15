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

export function buildCodexSessionDetailFields(detail: CodexSessionDetailShape | null | undefined): CodexSessionDetailField[]
