/** Pause accounting belongs to the meeting, not to a dock that can be parked and remounted. */
export interface MeetingPauseClock {
  pausedMs: number
  pausedAt: number | null
}

export function freshMeetingPauseClock(): MeetingPauseClock {
  return { pausedMs: 0, pausedAt: null }
}

export function setMeetingPaused(clock: MeetingPauseClock, paused: boolean, now: number): MeetingPauseClock {
  if (paused) return clock.pausedAt === null ? { ...clock, pausedAt: now } : clock
  if (clock.pausedAt === null) return clock
  return { pausedMs: clock.pausedMs + Math.max(0, now - clock.pausedAt), pausedAt: null }
}
