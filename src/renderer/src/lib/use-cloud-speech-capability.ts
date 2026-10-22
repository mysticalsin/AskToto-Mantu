import { useEffect, useRef, useState } from 'react'
import type { CloudSpeechCapability } from '@shared/cloud-speech'
import { createCloudSpeechRequestFence } from './cloud-speech-request-fence'

/**
 * The approved cloud speech route for the lean package, re-read when the window regains focus.
 * A rejected IPC sets `checkFailed` (the row then offers Try Again) instead of leaving the capability
 * null, which the row reads as "still checking" forever. `key` changes when any setting that can move
 * the route changes; `onSettled` fires after every check so setup never waits on this row.
 */
export function useCloudSpeechCapability(
  enabled: boolean,
  key: string,
  onSettled: () => void
): { capability: CloudSpeechCapability | null; checkFailed: boolean; refresh: (force?: boolean) => void } {
  const [capability, setCapability] = useState<CloudSpeechCapability | null>(null)
  const [checkFailed, setCheckFailed] = useState(false)
  const refreshRef = useRef<(force?: boolean) => void>(() => {})
  const settledRef = useRef(onSettled)
  settledRef.current = onSettled
  useEffect(() => {
    if (!enabled) return
    let current = true
    let lastCheckAt = 0
    const requestFence = createCloudSpeechRequestFence()
    const refresh = (force = false): void => {
      if (!force && Date.now() - lastCheckAt < 750) return
      lastCheckAt = Date.now()
      const requestId = requestFence.begin()
      setCapability(null)
      setCheckFailed(false)
      void window.toto
        .cloudSpeechCapability()
        .then((next) => {
          if (current && requestFence.isCurrent(requestId)) setCapability(next)
        })
        .catch(() => {
          if (current && requestFence.isCurrent(requestId)) {
            setCapability(null)
            setCheckFailed(true)
          }
        })
        .finally(() => {
          if (current && requestFence.isCurrent(requestId)) settledRef.current()
        })
    }
    const onFocus = (): void => refresh()
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') refresh()
    }
    refreshRef.current = refresh
    refresh()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      current = false
      requestFence.invalidate()
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [enabled, key])
  return { capability, checkFailed, refresh: (force) => refreshRef.current(force) }
}
