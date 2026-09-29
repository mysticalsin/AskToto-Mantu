/**
 * capture-backoff.ts — failure backoff for unattended screen captures (M2-0429, reused for M2-0044).
 *
 * The background screen reader ticks every 6 s. With a capture that keeps failing (Screen Recording not in
 * effect for this build, a Windows graphics-capture block) every tick used to be a fresh attempt plus a
 * capture.failed audit line: thousands a day. This spaces attempts out exponentially from 6 s to 10 min and
 * stops entirely (latches) after 5 consecutive permission failures, since a permission does not come back on
 * its own inside one process. The caller resets it on success, on a settings change, and implicitly on a
 * relaunch (a new process starts with a fresh one).
 *
 * `suspended` is reported exactly once per failure streak — on the failure that latches it, or on the one that
 * first reaches the 10 min ceiling — so the audit trail carries one line per streak instead of one per tick.
 */
import { isScreenCapturePermissionError } from '@shared/screen-capture'

export const BACKOFF_BASE_MS = 6_000
export const BACKOFF_MAX_MS = 10 * 60_000
export const BACKOFF_LATCH_AFTER = 5

/** A failure that will not clear by retrying in this process: the permission copy main throws, or, on macOS,
 *  ScreenCaptureKit's bare "Failed to get sources." rejection, which is what a denied capture produces. */
export function isPermissionTypeCaptureFailure(message: string, platform: NodeJS.Platform | string): boolean {
  return isScreenCapturePermissionError(message) || (platform === 'darwin' && /failed to get sources/i.test(message))
}

export interface CaptureBackoffFailure {
  /** True exactly once per streak: attempts are now latched off or at the ceiling. */
  suspended: boolean
  latched: boolean
  failures: number
  /** Delay before the next attempt is allowed; Infinity once latched. */
  retryInMs: number
}

export interface CaptureBackoff {
  canAttempt: (now: number) => boolean
  recordFailure: (now: number, permission: boolean) => CaptureBackoffFailure
  recordSuccess: () => void
  reset: () => void
}

export function createCaptureBackoff({
  baseMs = BACKOFF_BASE_MS,
  maxMs = BACKOFF_MAX_MS,
  latchAfter = BACKOFF_LATCH_AFTER
}: { baseMs?: number; maxMs?: number; latchAfter?: number } = {}): CaptureBackoff {
  let failures = 0
  let permissionStreak = 0
  let nextAt = 0
  let latched = false
  let suspendedReported = false

  const reset = (): void => {
    failures = 0
    permissionStreak = 0
    nextAt = 0
    latched = false
    suspendedReported = false
  }

  return {
    canAttempt: (now) => !latched && now >= nextAt,
    recordFailure: (now, permission) => {
      failures += 1
      permissionStreak = permission ? permissionStreak + 1 : 0
      const delay = Math.min(maxMs, baseMs * 2 ** (failures - 1))
      latched = latched || permissionStreak >= latchAfter
      nextAt = now + delay
      const atRest = latched || delay >= maxMs
      const suspended = atRest && !suspendedReported
      if (suspended) suspendedReported = true
      return { suspended, latched, failures, retryInMs: latched ? Infinity : delay }
    },
    recordSuccess: reset,
    reset
  }
}
