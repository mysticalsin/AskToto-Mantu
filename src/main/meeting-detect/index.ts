import { detectMac } from './mac'
import { detectWindows } from './win'

/** Returns "<app>|<detail>" when a live meeting is detected, else "". Never rejects. Cross-platform. */
export function detectMeeting(customApps: string[] = []): Promise<string> {
  if (process.platform === 'darwin') return detectMac(customApps)
  if (process.platform === 'win32') return detectWindows(customApps)
  // Linux: BY-DESIGN empty. AskToto targets macOS/Windows; meeting detection on Linux would require
  // a new implementation (e.g., parsing /proc or a desktop portal) and is not currently supported.
  return Promise.resolve('')
}

/** Emitted only on a rising/falling edge of "a meeting is present". `app` is '' when active is false. */
export interface MeetingWatcherState {
  app: string
  active: boolean
}

export interface MeetingWatcherOptions {
  /** Poll interval in ms (the previous popup-driving poller used 7000). */
  intervalMs: number
  /** Live getter so the caller can hand in an always-current setting (e.g. customMeetingApps) — read fresh on every poll, not captured once at construction. */
  getApps: () => string[]
  /** Fired only when the latch flips (meeting started / meeting ended) — never on every poll tick. */
  onChange: (state: MeetingWatcherState) => void
  /** Optional: called when a single poll throws. Detection resumes on the next tick regardless. */
  onError?: (error: unknown) => void
}

export interface MeetingWatcher {
  /** Stops polling. Safe to call more than once. */
  stop: () => void
}

/**
 * Starts polling detectMeeting() on an interval and reports rising/falling edges of "a meeting is
 * present" via onChange. Pure detection plumbing only: no window.show(), no IPC, no popup — the
 * caller decides what (if anything) to do when a meeting starts or ends.
 */
export function createMeetingWatcher(options: MeetingWatcherOptions): MeetingWatcher {
  const { intervalMs, getApps, onChange, onError } = options
  let detecting = false // skip a tick if the previous poll is still in flight (no overlap)
  let active = false
  let stopped = false

  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    if (detecting) return
    detecting = true
    detectMeeting(getApps())
      .then((hit) => {
        if (stopped) return
        if (hit && !active) {
          active = true
          onChange({ app: hit.split('|')[0], active: true })
        } else if (!hit && active) {
          active = false
          onChange({ app: '', active: false })
        }
      })
      .catch((e) => onError?.(e))
      .finally(() => {
        detecting = false
      })
  }, intervalMs)

  return {
    stop(): void {
      stopped = true
      clearInterval(timer)
    }
  }
}
