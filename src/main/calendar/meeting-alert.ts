import type { CalendarEvent, CalendarTodayResult } from '@shared/ipc'
import { BoundedSet } from '../bounded-set'

const CACHE_TTL_MS = 30_000
const NEGATIVE_TTL_MS = 5 * 60_000
const WINDOW_MS = 60_000
const TOO_LATE_MS = -30_000
const NOW_MS = 5_000

/** The notification body from the real time left (D2-9, D9-5): never a fixed "1 minute". */
export function meetingAlertBody(subject: string, msUntil: number): string {
  return msUntil <= NOW_MS ? `${subject} is starting now` : `${subject} starts in less than a minute`
}

export interface MeetingAlertDeps {
  now: () => number
  /** The meetingNotifications setting and OS support for notifications. */
  enabled: () => boolean
  requireAuth: () => boolean
  /** The same Graph rate gate the IPC path uses. */
  denyIfLimited: () => boolean
  timeZone: () => string
  fetchToday: (tz: string) => Promise<CalendarTodayResult>
  /** Shows the OS notification; clicking it reveals the overlay and starts nothing. */
  notify: (title: string, body: string) => void
  warn: (message: string, error?: unknown) => void
}

/**
 * One tick of the meeting notifier, run on main's 30 s interval (the timer stays in index.ts). Owns the
 * agenda cache, the previous-poll edge trigger and the dedupe set. A consent failure, an error or a thrown
 * fetch is remembered for five minutes, so an unavailable calendar is not re-requested every tick (D9-6).
 */
export function createMeetingAlert(deps: MeetingAlertDeps): () => Promise<void> {
  let cache: { events: CalendarEvent[]; ts: number } | null = null
  let backoffUntil = 0
  let prevPollMs = 0
  // Bounded: the notifier polls for the life of the process.
  const notifiedKeys = new BoundedSet<string>(1_000)

  async function todaysEvents(now: number): Promise<CalendarEvent[]> {
    if (cache && now - cache.ts <= CACHE_TTL_MS) return cache.events
    if (now < backoffUntil || !deps.requireAuth() || deps.denyIfLimited()) return []
    try {
      const res = await deps.fetchToday(deps.timeZone())
      if (res.ok && res.events) {
        cache = { events: res.events, ts: now }
        return res.events
      }
      backoffUntil = now + NEGATIVE_TTL_MS
    } catch (e) {
      backoffUntil = now + NEGATIVE_TTL_MS
      deps.warn('[meeting-notifier] tick failed:', e instanceof Error ? e.message : String(e))
    }
    return []
  }

  return async () => {
    if (!deps.enabled()) return
    const now = deps.now()
    const events = await todaysEvents(now)
    const prev = prevPollMs
    prevPollMs = now
    for (const ev of events) {
      if (!ev.start) continue
      const startMs = Date.parse(ev.start)
      if (Number.isNaN(startMs)) continue
      // Edge trigger: fire on the first poll where the 60 s mark has been crossed, whatever the poll jitter.
      const msUntil = startMs - now
      if (msUntil < TOO_LATE_MS || msUntil > WINDOW_MS) continue
      const prevMsUntil = prev > 0 ? startMs - prev : Number.POSITIVE_INFINITY
      if (prevMsUntil <= WINDOW_MS) continue
      const key = `${ev.subject}@${ev.start}`
      if (notifiedKeys.has(key)) continue
      notifiedKeys.add(key)
      deps.notify('Meeting starting soon', meetingAlertBody(ev.subject, msUntil))
    }
  }
}
