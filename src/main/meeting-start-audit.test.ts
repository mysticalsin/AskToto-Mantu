import { describe, expect, it, vi } from 'vitest'
import { createMeetingStartAudit } from './meeting-start-audit'

describe('createMeetingStartAudit', () => {
  const make = (extra: { repeatWindowMs?: number; maxPerMinute?: number } = {}) => {
    let now = 1_000
    const sink = vi.fn()
    const audit = createMeetingStartAudit({ sink, now: () => now, ...extra })
    return {
      audit,
      sink,
      advance: (ms: number) => {
        now += ms
      }
    }
  }

  it('writes one record with stage, outcome and reason code only', () => {
    const { audit, sink } = make()
    audit('activation', 'denied', 'window-not-visible')
    audit('transition', 'accepted')
    expect(sink.mock.calls).toEqual([
      [{ stage: 'activation', outcome: 'denied', reason: 'window-not-visible' }],
      [{ stage: 'transition', outcome: 'accepted' }]
    ])
  })

  it('collapses a click spam of the same refusal into one record per window', () => {
    const { audit, sink, advance } = make()
    for (let i = 0; i < 20; i += 1) audit('activation', 'denied', 'window-not-visible')
    expect(sink).toHaveBeenCalledTimes(1)
    advance(1_000)
    audit('activation', 'denied', 'window-not-visible')
    expect(sink).toHaveBeenCalledTimes(2)
  })

  it('never writes more than the per-minute ceiling, then recovers', () => {
    const { audit, sink, advance } = make({ repeatWindowMs: 0, maxPerMinute: 3 })
    for (let i = 0; i < 10; i += 1) {
      audit('activation', 'denied', 'refused')
      advance(10)
    }
    expect(sink).toHaveBeenCalledTimes(3)
    advance(60_000)
    audit('activation', 'denied', 'refused')
    expect(sink).toHaveBeenCalledTimes(4)
  })
})
