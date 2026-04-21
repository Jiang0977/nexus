import { useEffect, useState } from 'react'
import { detectAnyProfiles } from './profileGuideApi'

interface UseProfileGuideArgs {
  token: string
}

export function useProfileGuide({ token }: UseProfileGuideArgs) {
  const [hasProfiles, setHasProfiles] = useState<boolean | null>(null)
  const [showProfileGuide, setShowProfileGuide] = useState(false)

  useEffect(() => {
    if (hasProfiles !== null) return
    detectAnyProfiles(token)
      .then((hasAnyProfiles) => {
        setHasProfiles(hasAnyProfiles)
        if (!hasAnyProfiles) {
          setShowProfileGuide(true)
        }
      })
      .catch((error: unknown) => {
        console.error('[useProfileGuide] Failed to detect available profiles', error)
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
