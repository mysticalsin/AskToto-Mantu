import { useCallback } from 'react'
import type { PublicSettings } from '@shared/ipc'

export function useEncryptedProfileUnlock(
  setSettings: (settings: PublicSettings) => void,
  setBootError: (message: string | null) => void
): () => Promise<void> {
  return useCallback(async (): Promise<void> => {
    try {
      setSettings(await window.toto.unlockEncryptedProfile())
      setBootError(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setBootError(message)
      throw error
    }
  }, [setSettings, setBootError])
}
