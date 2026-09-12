import { describe, expect, it } from 'vitest'
import { measuredDurationMs, meetingDurationMinutes, reviewDurationSeconds, transcriptSpanMs } from './meeting-duration'
import { SaveMeetingSchema } from './ipc'

describe('MQA-310 measured recording duration', () => {
  it('shows the complete recording even with one line or sparse line starts', () => {
    expect(reviewDurationSeconds({ durationMs: 28_840, lines: [{ t: 0 }, { t: 15_000 }], endedAt: Date.now(), isPastMeeting: true })).toBe(29)
    expect(reviewDurationSeconds({ durationMs: 28_840, lines: [{ t: 0 }], endedAt: Date.now(), isPastMeeting: true })).toBe(29)
    expect(meetingDurationMinutes({ durationMs: 150_000, lines: [{ t: 0 }] })).toBe(3)
  })

  it.each([-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid measured duration %s at the IPC boundary', (durationMs) => {
    expect(measuredDurationMs(durationMs)).toBeUndefined()
    expect(SaveMeetingSchema.safeParse({ startedAt: 1, lines: [], durationMs }).success).toBe(false)
  })

  it('retains legacy span semantics without using the time a saved meeting was opened', () => {
    expect(reviewDurationSeconds({ lines: [{ t: 1000 }], isPastMeeting: true, startedAt: 1000, endedAt: 90_000 })).toBe(0)
    expect(reviewDurationSeconds({ lines: [], startedAt: 1000, endedAt: 90_000 })).toBe(89)
    expect(reviewDurationSeconds({ lines: [{ t: 1000 }, { t: 31_000 }], isPastMeeting: true, endedAt: 90_000 })).toBe(30)
    expect(meetingDurationMinutes({ lines: [] })).toBe(0)
  })

  it('handles long and partially corrupt legacy transcripts without argument-spread limits', () => {
    const lines = Array.from({ length: 200_000 }, (_, t) => ({ t }))
    lines.push({ t: NaN })
    expect(transcriptSpanMs(lines)).toBe(199_999)
  })
})
