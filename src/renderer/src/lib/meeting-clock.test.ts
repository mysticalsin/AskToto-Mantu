import { describe, expect, it } from 'vitest'
import { freshMeetingPauseClock, setMeetingPaused } from './meeting-clock'

describe('meeting pause clock', () => {
  it('retains paused time while the dock is parked and clears it for a new meeting', () => {
    let clock = freshMeetingPauseClock()
    clock = setMeetingPaused(clock, true, 85_000)
    expect(clock).toEqual({ pausedMs: 0, pausedAt: 85_000 })

    // No visible clock needs to be mounted while the meeting remains paused.
    clock = setMeetingPaused(clock, true, 130_000)
    expect(clock).toEqual({ pausedMs: 0, pausedAt: 85_000 })
    clock = setMeetingPaused(clock, false, 140_000)
    expect(clock).toEqual({ pausedMs: 55_000, pausedAt: null })
    clock = setMeetingPaused(clock, false, 150_000)
    expect(clock.pausedMs).toBe(55_000)

    clock = freshMeetingPauseClock()
    expect(clock).toEqual({ pausedMs: 0, pausedAt: null })
  })
})
