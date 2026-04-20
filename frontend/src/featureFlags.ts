export interface FeatureConfig {
  features?: {
    codexHistory?: boolean
  }
}

export function isCodexHistoryEnabled(config: FeatureConfig | null | undefined): boolean {
  const value = config?.features?.codexHistory
  return value === undefined ? true : value !== false
}
