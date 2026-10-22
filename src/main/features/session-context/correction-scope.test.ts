import { describe, expect, it } from 'vitest'
import { CorrectionTracker } from './correction-scope'

describe('CorrectionTracker', () => {
  it('starts at epoch 0 and a capture with nothing corrected is unaffected', () => {
    const tracker = new CorrectionTracker()
    const deps = tracker.capture(['a', 'b'])
    expect(tracker.epoch).toBe(0)
    expect(tracker.affects(deps)).toBe(false)
  })

  it('a correction affects only the captures that held that line', () => {
    const tracker = new CorrectionTracker()
    const holdsA = tracker.capture(['a', 'b'])
    const holdsB = tracker.capture(['b'])
    tracker.record('a')
    expect(tracker.affects(holdsA)).toBe(true)
    expect(tracker.affects(holdsB)).toBe(false)
  })

  it('a capture taken after the correction already reads the corrected line and is unaffected', () => {
    const tracker = new CorrectionTracker()
    tracker.record('a')
    expect(tracker.affects(tracker.capture(['a']))).toBe(false)
    tracker.record('a')
    expect(tracker.affects(tracker.capture(['a']))).toBe(false)
  })

  it('reports each affected capture until it is re-captured (a miss, then a fresh read)', () => {
    const tracker = new CorrectionTracker()
    const deps = tracker.capture(['a'])
    tracker.record('a')
    expect(tracker.affects(deps)).toBe(true)
    expect(tracker.affects(deps)).toBe(true)
    expect(tracker.affects(tracker.capture(['a']))).toBe(false)
  })

  it('forgets the oldest corrections past its bound and then treats older captures as affected', () => {
    const tracker = new CorrectionTracker(4)
    const old = tracker.capture(['x'])
    for (const id of ['a', 'b', 'c', 'd', 'e']) tracker.record(id)
    // The correction record for the oldest id fell out; a capture older than that cannot prove it was spared.
    expect(tracker.affects(old)).toBe(true)
    const fresh = tracker.capture(['x'])
    expect(tracker.affects(fresh)).toBe(false)
  })
})
