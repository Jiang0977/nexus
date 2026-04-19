export interface FeatureConfig {
  features?: {
    codexHistory?: boolean
  }
}

export function isCodexHistoryEnabled(config: FeatureConfig | null | undefined): boolean
