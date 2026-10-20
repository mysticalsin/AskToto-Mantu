import { describe, expect, it } from 'vitest'
import { RecoveredDraftCount } from './recovered-draft-count'

describe('recovered draft count stays within its active profile boundary', () => {
  it('starts empty at revision zero', () => {
    expect(new RecoveredDraftCount().snapshot()).toEqual({ count: 0, revision: 0 })
  })

  it('records drafts recovered by current work under a new revision', () => {
    const counter = new RecoveredDraftCount()
    const token = counter.revisionToken()
    expect(counter.recordRecovered(token, 3)).toBe(true)
    expect(counter.snapshot()).toEqual({ count: 3, revision: 1 })
  })

  it('publishes a new empty revision after a confirmed profile recovery', () => {
    const counter = new RecoveredDraftCount()
    counter.recordRecovered(counter.revisionToken(), 2)
    const before = counter.snapshot()
    counter.resetForProfileRecovery()
    const after = counter.snapshot()
    expect(after.count).toBe(0)
    expect(after.revision).toBeGreaterThan(before.revision)
  })

  it('ignores orphan recovery work that began under the previous profile revision', () => {
    const counter = new RecoveredDraftCount()
    const token = counter.revisionToken()
    counter.resetForProfileRecovery()
    const reset = counter.snapshot()
    expect(counter.isCurrent(token)).toBe(false)
    expect(counter.recordRecovered(token, 4)).toBe(false)
    expect(counter.snapshot()).toEqual(reset)
  })

  it('leaves the revision unchanged when current recovery found nothing', () => {
    const counter = new RecoveredDraftCount()
    for (const recovered of [0, -1, Number.NaN]) {
      expect(counter.recordRecovered(counter.revisionToken(), recovered)).toBe(false)
    }
    expect(counter.snapshot()).toEqual({ count: 0, revision: 0 })
  })

  it('hides the count from an unauthenticated snapshot while keeping the revision', () => {
    const counter = new RecoveredDraftCount()
    counter.recordRecovered(counter.revisionToken(), 5)
    expect(counter.snapshot(false)).toEqual({ count: 0, revision: 1 })
    expect(counter.snapshot(true)).toEqual({ count: 5, revision: 1 })
  })
})
