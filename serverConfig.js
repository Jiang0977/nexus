export function buildClientConfig({
  tmuxSession,
  workspaceRoot,
  codexHistoryEnabled,
}) {
  return {
    tmuxSession,
    workspaceRoot,
    features: {
      codexHistory: codexHistoryEnabled,
    },
  }
}
