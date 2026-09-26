import { describe, it, expect } from 'vitest'
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

  it('defaults now to Date.now when not given', () => {
    const tracker = createResponsivenessTracker()
    tracker.markUnresponsive()
    const stallMs = tracker.markResponsive()
    expect(stallMs).not.toBeNull()
    expect(stallMs).toBeGreaterThanOrEqual(0)
    expect(stallMs).toBeLessThan(1000)
  })
})
