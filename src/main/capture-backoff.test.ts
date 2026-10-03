import { describe, expect, it } from 'vitest'
import { BACKOFF_MAX_MS, createCaptureBackoff, isPermissionTypeCaptureFailure } from './capture-backoff'

describe('isPermissionTypeCaptureFailure', () => {
  it('classifies the macOS and Windows permission copy and a darwin getSources rejection', () => {
    expect(isPermissionTypeCaptureFailure('Screen Recording permission is off for Métis. Enable it…', 'darwin')).toBe(true)
    expect(isPermissionTypeCaptureFailure('No screen source available. Check your system’s screen-capture permissions for Métis, then try again.', 'win32')).toBe(true)
    expect(isPermissionTypeCaptureFailure('Failed to get sources.', 'darwin')).toBe(true)
  })

  it('leaves transient errors alone', () => {
    expect(isPermissionTypeCaptureFailure('Failed to get sources.', 'win32')).toBe(false)
    expect(isPermissionTypeCaptureFailure('Screen capture returned an empty image. Try again in a moment.', 'darwin')).toBe(false)
  })
})

describe('createCaptureBackoff', () => {
  it('doubles the delay from 6 s and caps it at 10 min for non-permission failures', () => {
    const b = createCaptureBackoff()
    const delays: number[] = []
    let now = 0
    for (let i = 0; i < 9; i++) {
      const f = b.recordFailure(now, false)
      delays.push(f.retryInMs)
      now += f.retryInMs
    }
    expect(delays).toEqual([6_000, 12_000, 24_000, 48_000, 96_000, 192_000, 384_000, BACKOFF_MAX_MS, BACKOFF_MAX_MS])
  })

  it('blocks attempts until the delay has passed', () => {
    const b = createCaptureBackoff()
    expect(b.canAttempt(0)).toBe(true)
    b.recordFailure(0, false)
    expect(b.canAttempt(5_999)).toBe(false)
    expect(b.canAttempt(6_000)).toBe(true)
  })

  it('latches after 5 consecutive permission failures and never allows another attempt', () => {
    const b = createCaptureBackoff()
    let now = 0
    for (let i = 0; i < 4; i++) {
      const f = b.recordFailure(now, true)
      expect(f.latched).toBe(false)
      now += f.retryInMs
    }
    const fifth = b.recordFailure(now, true)
    expect(fifth).toMatchObject({ latched: true, suspended: true, failures: 5, retryInMs: Infinity })
    expect(b.canAttempt(now + 365 * 24 * 3_600_000)).toBe(false)
  })

  it('a non-permission failure breaks the permission streak', () => {
    const b = createCaptureBackoff()
    for (let i = 0; i < 4; i++) b.recordFailure(0, true)
    b.recordFailure(0, false)
    expect(b.recordFailure(0, true).latched).toBe(false)
  })

  it('reports suspended once per streak, and again after a success starts a new streak', () => {
    const b = createCaptureBackoff()
    const suspendedCount = (): number => {
      let n = 0
      for (let i = 0; i < 20; i++) if (b.recordFailure(0, true).suspended) n++
      return n
    }
    expect(suspendedCount()).toBe(1)
    b.recordSuccess()
    expect(b.canAttempt(0)).toBe(true)
    expect(suspendedCount()).toBe(1)
  })

  it('reset (settings change) clears a latch', () => {
    const b = createCaptureBackoff()
    for (let i = 0; i < 5; i++) b.recordFailure(0, true)
    expect(b.canAttempt(0)).toBe(false)
    b.reset()
    expect(b.canAttempt(0)).toBe(true)
  })
})
