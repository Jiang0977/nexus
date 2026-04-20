import { useEffect, useState } from 'react'

interface UseProfileGuideArgs {
  token: string
}

export function useProfileGuide({ token }: UseProfileGuideArgs) {
  const [hasProfiles, setHasProfiles] = useState<boolean | null>(null)
  const [showProfileGuide, setShowProfileGuide] = useState(false)

  useEffect(() => {
    if (hasProfiles !== null) return
    Promise.all([
      fetch('/api/configs', { headers: { Authorization: `Bearer ${token}` } }).then((response) => response.ok ? response.json() : []),
      fetch('/api/codex-configs', { headers: { Authorization: `Bearer ${token}` } }).then((response) => response.ok ? response.json() : []),
    ])
      .then(([claudeConfigs, codexConfigs]) => {
        const hasAny =
          (Array.isArray(claudeConfigs) && claudeConfigs.length > 0) ||
          (Array.isArray(codexConfigs) && codexConfigs.length > 0)
        setHasProfiles(hasAny)
        if (!hasAny) {
          setShowProfileGuide(true)
        }
      })
      .catch(() => {
        setHasProfiles(true)
      })
  }, [hasProfiles, token])

  return {
    dismissProfileGuide: () => setShowProfileGuide(false),
    markProfilesDetected: () => {
      setHasProfiles(true)
      setShowProfileGuide(false)
    },
    showProfileGuide,
  }
}
