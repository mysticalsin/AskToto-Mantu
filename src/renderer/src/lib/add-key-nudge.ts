import { useEffect, useState } from 'react'

/** How long after onboarding the "Add your API key" nudge may show. */
export const ADD_KEY_NUDGE_WINDOW_MS = 10 * 60 * 1000

/**
 * The "Add your API key" nudge under the bar is a first-run courtesy, not a permanent nag. It shows
 * while no provider is ready, but only for 10 minutes after onboarding — then it steps aside (Settings
 * is always one M-logo click away). Anchored to the PERSISTED onboardingDoneAt so a relaunch can't
 * restart the clock and nag forever; the returned flag flips true live via a timeout even if the app
 * sits idle past the mark.
 */
export function useAddKeyNudgeExpired(
  onboardingDone: boolean | undefined,
  onboardingDoneAt: number,
  patch: (p: { onboardingDoneAt: number }) => unknown
): boolean {
  const [nudgeExpired, setNudgeExpired] = useState(false)
  useEffect(() => {
    if (onboardingDone && !onboardingDoneAt) {
      // Legacy profile that finished onboarding before this field existed: start the clock now (one
      // write) so the nudge still auto-expires instead of lingering forever.
      void patch({ onboardingDoneAt: Date.now() })
      return
    }
    if (!onboardingDoneAt) return
    const remaining = onboardingDoneAt + ADD_KEY_NUDGE_WINDOW_MS - Date.now()
    if (remaining <= 0) {
      setNudgeExpired(true)
      return
    }
    setNudgeExpired(false)
    const t = setTimeout(() => setNudgeExpired(true), remaining)
    return () => clearTimeout(t)
  }, [onboardingDone, onboardingDoneAt, patch])
  return nudgeExpired
}
