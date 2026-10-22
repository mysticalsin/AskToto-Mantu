import { auditLog } from './logger'

/**
 * Q14: a Start click that does nothing must be explainable afterwards. Every step of the main-side Start path
 * (the click's activation, the readiness fallback, the listening-state transition) records one bounded,
 * content-free `meeting.start` audit record: a stage, an outcome and a reason code. Never a title, a path,
 * a transcript or an identity. Absence of any record for a click means the click never reached main.
 */
export type MeetingStartStage = 'activation' | 'activation-ready' | 'transition'
export type MeetingStartOutcome = 'granted' | 'accepted' | 'denied'
export type MeetingStartReason =
  | 'not-authenticated'
  | 'input-closing'
  | 'window-not-visible'
  | 'no-frame'
  | 'wrong-action'
  | 'frame-not-current'
  | 'start-not-allowed'
  | 'clock-invalid'
  | 'refused'
  | 'no-pending-grant'
  | 'invalid-request'
  | 'no-activation-grant'
  | 'rejected-before-grant'
  | 'rejected-after-grant'

export type MeetingStartAudit = (
  stage: MeetingStartStage,
  outcome: MeetingStartOutcome,
  reason?: MeetingStartReason
) => void

export interface MeetingStartAuditOptions {
  sink: (detail: Record<string, unknown>) => void
  now?: () => number
  /** The same stage/outcome/reason is recorded at most once per interval (a click spam is one record). */
  repeatWindowMs?: number
  /** Hard ceiling per rolling minute across all codes, so diagnostics can never flood the audit log. */
  maxPerMinute?: number
}

export function createMeetingStartAudit(options: MeetingStartAuditOptions): MeetingStartAudit {
  const now = options.now ?? Date.now
  const repeatWindowMs = options.repeatWindowMs ?? 1_000
  const maxPerMinute = options.maxPerMinute ?? 60
  const lastByKey = new Map<string, number>()
  let minuteStart = Number.NEGATIVE_INFINITY
  let inMinute = 0
  return (stage, outcome, reason) => {
    const at = now()
    const key = `${stage}|${outcome}|${reason ?? ''}`
    const last = lastByKey.get(key)
    if (last !== undefined && at - last < repeatWindowMs) return
    if (at - minuteStart >= 60_000) {
      minuteStart = at
      inMinute = 0
    }
    if (inMinute >= maxPerMinute) return
    inMinute += 1
    lastByKey.set(key, at)
    options.sink({ stage, outcome, ...(reason ? { reason } : {}) })
  }
}

/** The production recorder: bounded, content-free, written to the hash-chained audit log. */
export const recordMeetingStart: MeetingStartAudit = createMeetingStartAudit({
  sink: (detail) => auditLog('meeting.start', detail)
})
