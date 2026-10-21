import { afterEach, describe, expect, it } from 'vitest'
import {
  configureMeetingSpeechLimits,
  configureMeetingSpeechPersistence,
  getMeetingSpeechLimits,
  getMeetingSpeechReadLimitBytes
} from './meeting-speech'
import {
  installMeetingSpeechPolicy,
  MEETING_SPEECH_LIMITS,
  MEETING_SPEECH_WORKER_BOUNDS,
  validateMeetingSpeechPolicy
} from './meeting-speech-policy'

afterEach(() => {
  configureMeetingSpeechPersistence(undefined)
  configureMeetingSpeechLimits(undefined)
})

describe('meeting speech policy constants', () => {
  it('ships exactly the budgets the owner approved on 2026-10-21', () => {
    expect(MEETING_SPEECH_LIMITS).toEqual({
      maxRecords: 12_000,
      maxWords: 150_000,
      maxFieldBytes: 32_768,
      maxRecordBytes: 131_072,
      maxPayloadBytes: 67_108_864
    })
    expect(MEETING_SPEECH_WORKER_BOUNDS).toEqual({
      maxInputBytes: 134_217_728,
      maxOutputBytes: 134_217_728,
      operationDeadlineMs: 60_000,
      shutdownDeadlineMs: 5_000
    })
  })

  it('is frozen so no caller can widen it at runtime', () => {
    expect(Object.isFrozen(MEETING_SPEECH_LIMITS)).toBe(true)
    expect(Object.isFrozen(MEETING_SPEECH_WORKER_BOUNDS)).toBe(true)
  })

  it('keeps the relations the codec, host and journal constructors depend on', () => {
    const l = MEETING_SPEECH_LIMITS
    const b = MEETING_SPEECH_WORKER_BOUNDS
    expect(() => validateMeetingSpeechPolicy()).not.toThrow()
    expect(l.maxFieldBytes).toBeLessThanOrEqual(l.maxRecordBytes)
    expect(l.maxRecordBytes).toBeLessThanOrEqual(l.maxPayloadBytes)
    expect(l.maxPayloadBytes).toBeLessThanOrEqual(b.maxInputBytes)
    expect(l.maxPayloadBytes).toBeLessThanOrEqual(b.maxOutputBytes)
    expect(b.shutdownDeadlineMs).toBeLessThanOrEqual(b.operationDeadlineMs)
    // A schema-valid segment (8,192 characters, up to 4 bytes each) can never trip the field cap.
    expect(l.maxFieldBytes).toBeGreaterThanOrEqual(8_192 * 4)
    for (const value of [...Object.values(l), ...Object.values(b)]) expect(Number.isSafeInteger(value)).toBe(true)
  })

  it('rejects an inconsistent policy', () => {
    expect(() =>
      validateMeetingSpeechPolicy({ ...MEETING_SPEECH_LIMITS, maxPayloadBytes: 1 }, MEETING_SPEECH_WORKER_BOUNDS)
    ).toThrow('Meeting speech policy is inconsistent.')
    expect(() =>
      validateMeetingSpeechPolicy(MEETING_SPEECH_LIMITS, { ...MEETING_SPEECH_WORKER_BOUNDS, maxInputBytes: 1 })
    ).toThrow('Meeting speech policy is inconsistent.')
    expect(() =>
      validateMeetingSpeechPolicy({ ...MEETING_SPEECH_LIMITS, maxRecords: 0 }, MEETING_SPEECH_WORKER_BOUNDS)
    ).toThrow('Meeting speech policy is inconsistent.')
  })
})

describe('installMeetingSpeechPolicy', () => {
  it('installs the trusted budget and the saved-file read cap, idempotently', () => {
    expect(getMeetingSpeechLimits()).toBeUndefined()
    expect(getMeetingSpeechReadLimitBytes()).toBeUndefined()
    installMeetingSpeechPolicy()
    installMeetingSpeechPolicy()
    expect(getMeetingSpeechLimits()).toEqual(MEETING_SPEECH_LIMITS)
    expect(getMeetingSpeechReadLimitBytes()).toBe(MEETING_SPEECH_WORKER_BOUNDS.maxInputBytes)
  })

  it('is cleared with the budget, so a deliberately absent policy leaves no read cap', () => {
    installMeetingSpeechPolicy()
    configureMeetingSpeechLimits(undefined)
    expect(getMeetingSpeechLimits()).toBeUndefined()
    expect(getMeetingSpeechReadLimitBytes()).toBeUndefined()
  })

  it('keeps the payload cap as the read limit when only a budget is configured', () => {
    configureMeetingSpeechLimits({ ...MEETING_SPEECH_LIMITS })
    expect(getMeetingSpeechReadLimitBytes()).toBe(MEETING_SPEECH_LIMITS.maxPayloadBytes)
  })
})
