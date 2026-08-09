import { describe, it, expect } from 'vitest'
import {
  DEFAULT_TIME_SAVED_ASSUMPTIONS,
  formatSavedTime,
  perMeetingSaved,
  timeSavedFromMeetings,
  timeSavedFromTotals
} from './time-saved'

const A = DEFAULT_TIME_SAVED_ASSUMPTIONS // ratio 0.2, floor 5, cap 30

describe('perMeetingSaved — clamp math', () => {
  it('credits the ratio in the sane middle band', () => {
    expect(perMeetingSaved(60, A)).toBe(12) // 60 * 0.2
    expect(perMeetingSaved(100, A)).toBe(20)
  })

  it('floors a short meeting so a 2-minute call still credits the minimum note', () => {
    expect(perMeetingSaved(2, A)).toBe(5) // 2 * 0.2 = 0.4 -> floor 5
    expect(perMeetingSaved(10, A)).toBe(5) // 10 * 0.2 = 2 -> floor 5
  })

  it('caps a long meeting so a 3-hour call is not summarized proportionally forever', () => {
    expect(perMeetingSaved(180, A)).toBe(30) // 180 * 0.2 = 36 -> cap 30
    expect(perMeetingSaved(600, A)).toBe(30)
  })

  it('credits nothing for a zero-length (no speech) meeting', () => {
    expect(perMeetingSaved(0, A)).toBe(0)
    expect(perMeetingSaved(-5, A)).toBe(0)
    expect(perMeetingSaved(NaN, A)).toBe(0)
  })

  it('respects an adjusted assumption', () => {
    expect(perMeetingSaved(60, { writeupRatio: 0.5, floorMin: 5, capMin: 60 })).toBe(30)
  })

  it('never returns NaN for a garbage assumption (managed-config / hand edit)', () => {
    const bad = { writeupRatio: NaN, floorMin: NaN, capMin: NaN }
    expect(Number.isFinite(perMeetingSaved(60, bad))).toBe(true)
  })

  it('keeps cap >= floor even when a hand edit inverts them', () => {
    // floor 30, cap 10 (inverted): cap is raised to the floor so the band never goes negative.
    expect(perMeetingSaved(1000, { writeupRatio: 0.2, floorMin: 30, capMin: 10 })).toBe(30)
  })
})

describe('timeSavedFromMeetings — precise, per-meeting', () => {
  it('sums each meeting by its real length', () => {
    const r = timeSavedFromMeetings([{ durationMin: 60 }, { durationMin: 30 }, { durationMin: 180 }], A)
    // 12 + 6 (above floor) + 30 (cap) = 48 ; conversation 270
    expect(r.savedMinutes).toBe(48)
    expect(r.meetings).toBe(3)
    expect(r.conversationMinutes).toBe(270)
    expect(r.perMeetingAvgMin).toBe(16) // 48/3 = 16
  })

  it('is all zeros for no meetings (drives the empty state, never "0h saved" from a divide)', () => {
    const r = timeSavedFromMeetings([], A)
    expect(r).toEqual({ savedMinutes: 0, meetings: 0, conversationMinutes: 0, perMeetingAvgMin: 0 })
  })

  it('tolerates a meeting with a missing/garbage duration without poisoning the total', () => {
    const r = timeSavedFromMeetings([{ durationMin: 60 }, { durationMin: NaN as unknown as number }], A)
    expect(r.savedMinutes).toBe(12)
    expect(r.conversationMinutes).toBe(60)
    expect(r.meetings).toBe(2) // the meeting still counts as a meeting; it just added no minutes
  })
})

describe('timeSavedFromTotals — durable, survives retention deletion', () => {
  it('credits each meeting at the average length once the transcripts are gone', () => {
    // 10 meetings, 600 min total -> avg 60 -> 12/meeting -> 120
    const r = timeSavedFromTotals({ meetingsSummarized: 10, conversationMinutes: 600 }, A)
    expect(r.savedMinutes).toBe(120)
    expect(r.meetings).toBe(10)
    expect(r.perMeetingAvgMin).toBe(12)
  })

  it('is all zeros with no meetings — no divide-by-zero, no NaN', () => {
    const r = timeSavedFromTotals({ meetingsSummarized: 0, conversationMinutes: 0 }, A)
    expect(r).toEqual({ savedMinutes: 0, meetings: 0, conversationMinutes: 0, perMeetingAvgMin: 0 })
  })

  it('agrees with the precise path when every meeting is the same length', () => {
    const uniform = Array.from({ length: 5 }, () => ({ durationMin: 40 }))
    const precise = timeSavedFromMeetings(uniform, A)
    const totals = timeSavedFromTotals({ meetingsSummarized: 5, conversationMinutes: 200 }, A)
    expect(totals.savedMinutes).toBe(precise.savedMinutes)
  })
})

describe('formatSavedTime', () => {
  it('shows whole minutes under an hour', () => {
    expect(formatSavedTime(45)).toBe('45 min')
    expect(formatSavedTime(0)).toBe('0 min')
    expect(formatSavedTime(59)).toBe('59 min')
  })

  it('shows one decimal hour above, trimming a clean .0', () => {
    expect(formatSavedTime(312)).toBe('5.2 hours')
    expect(formatSavedTime(360)).toBe('6 hours')
    expect(formatSavedTime(60)).toBe('1 hour')
    expect(formatSavedTime(90)).toBe('1.5 hours')
  })
})
