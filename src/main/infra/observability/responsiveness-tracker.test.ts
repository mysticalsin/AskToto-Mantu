import { describe, it, expect, vi } from 'vitest'
import { performance } from 'node:perf_hooks'
import { createResponsivenessTracker } from './responsiveness-tracker'

describe('createResponsivenessTracker', () => {
  it('reports the elapsed ms between markUnresponsive and the matching markResponsive', () => {
    let t = 1000
    const tracker = createResponsivenessTracker(() => t)
    tracker.markUnresponsive()
    t = 5200
    expect(tracker.markResponsive()).toBe(4200)
  })

  it('markResponsive without a preceding markUnresponsive returns null (no unpaired app.responsive)', () => {
    const tracker = createResponsivenessTracker(() => 0)
    expect(tracker.markResponsive()).toBeNull()
  })

  it('a second markUnresponsive before markResponsive does not push the start time forward', () => {
    let t = 0
    const tracker = createResponsivenessTracker(() => t)
    tracker.markUnresponsive()
    t = 500
    tracker.markUnresponsive() // still wedged from the first call — must not reset the clock
    t = 1000
    expect(tracker.markResponsive()).toBe(1000) // measured from t=0, not from t=500
  })

  it('markResponsive clears the pending state so a later unpaired markResponsive returns null again', () => {
    let t = 0
    const tracker = createResponsivenessTracker(() => t)
    tracker.markUnresponsive()
    t = 100
    expect(tracker.markResponsive()).toBe(100)
    t = 200
    expect(tracker.markResponsive()).toBeNull()
  })

  it('defaults now to performance.now and never calls Date.now, so a wall-clock jump cannot manufacture a fake duration', () => {
    const nowSpy = vi.spyOn(performance, 'now')
    const dateNowSpy = vi.spyOn(Date, 'now')
    try {
      const tracker = createResponsivenessTracker()
      const callsAtStart = nowSpy.mock.calls.length
      tracker.markUnresponsive()
      expect(nowSpy.mock.calls.length).toBeGreaterThan(callsAtStart)
      const stallMs = tracker.markResponsive()
      expect(stallMs).not.toBeNull()
      expect(stallMs).toBeGreaterThanOrEqual(0)
      expect(stallMs).toBeLessThan(1000)
      expect(dateNowSpy).not.toHaveBeenCalled()
    } finally {
      nowSpy.mockRestore()
      dateNowSpy.mockRestore()
    }
  })

  it('markGone clears a pending unresponsive so a later unresponsive/responsive pair after a renderer crash is not measured from before the crash', () => {
    let t = 0
    const tracker = createResponsivenessTracker(() => t)
    tracker.markUnresponsive() // t=0 — the renderer wedges
    t = 999_999_999 // it never recovers; render-process-gone fires instead, hours later
    tracker.markGone()
    t = 1_000_000_000 // the reloaded renderer wedges again, long after the crash
    tracker.markUnresponsive()
    t = 1_000_000_100
    expect(tracker.markResponsive()).toBe(100) // measured from the NEW markUnresponsive, not the stale one
  })

  it('markGone with no pending unresponsive state is a no-op — a later unpaired markResponsive is still null', () => {
    const tracker = createResponsivenessTracker(() => 0)
    tracker.markGone()
    expect(tracker.markResponsive()).toBeNull()
  })
})
