import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * A boolean that flips true then auto-resets to false after `ms` — the "Copied!"/"Saved!" confirmation
 * pattern used across Answer/Copilot/Review. Clears any pending timer on unmount so the reset never fires
 * setState after the component showing it has gone away (e.g. the user switches view mid-flash).
 */
export function useFlash(ms = 1500): [boolean, () => void] {
  const [on, setOn] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const flash = useCallback((): void => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setOn(true)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setOn(false)
    }, ms)
  }, [ms])

  return [on, flash]
}
