export async function detectAnyProfiles(token: string): Promise<boolean> {
  const headers = { Authorization: `Bearer ${token}` }
  const [claudeResponse, codexResponse] = await Promise.all([
    fetch('/api/configs', { headers }),
    fetch('/api/codex-configs', { headers }),
  ])

  if (!claudeResponse.ok) {
    throw new Error(`Failed to load Claude profiles: HTTP ${claudeResponse.status}`)
  }
  if (!codexResponse.ok) {
    throw new Error(`Failed to load Codex profiles: HTTP ${codexResponse.status}`)
  }

  const [claudeConfigs, codexConfigs] = await Promise.all([
    claudeResponse.json(),
    codexResponse.json(),
  ])

  return (
    (Array.isArray(claudeConfigs) && claudeConfigs.length > 0) ||
    (Array.isArray(codexConfigs) && codexConfigs.length > 0)
  )
}
