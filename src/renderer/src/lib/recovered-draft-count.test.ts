import { describe, expect, it } from 'vitest'
import { RecoveredDraftCountGate, recoveredDraftOwnerKey } from './recovered-draft-count'

describe('renderer recovered draft count gate', () => {
  it('derives a distinct owner for each sign-in state and profile', () => {
    const keys = new Set([
      recoveredDraftOwnerKey(true, 'Work'),
      recoveredDraftOwnerKey(false, 'Work'),
      recoveredDraftOwnerKey(true, 'Home'),
      recoveredDraftOwnerKey(true, undefined)
    ])
    expect(keys.size).toBe(4)
    expect(recoveredDraftOwnerKey(undefined, 'Work')).toBe(recoveredDraftOwnerKey(false, 'Work'))
  })

  it('applies snapshots in revision order and ignores older ones', () => {
    const gate = new RecoveredDraftCountGate()
    gate.bindOwner(recoveredDraftOwnerKey(true, 'Work'))
    expect(gate.accept({ count: 2, revision: 3 })).toBe(true)
    expect(gate.accept({ count: 1, revision: 2 })).toBe(false)
    expect(gate.accept({ count: 2, revision: 3 })).toBe(true)
    expect(gate.accept({ count: 0, revision: 4 })).toBe(true)
  })

  it('rejects malformed snapshots', () => {
    const gate = new RecoveredDraftCountGate()
    gate.bindOwner(recoveredDraftOwnerKey(true, 'Work'))
    for (const snapshot of [
      { count: -1, revision: 0 },
      { count: 1.5, revision: 0 },
      { count: 1, revision: Number.NaN },
      { count: Number.POSITIVE_INFINITY, revision: 0 }
    ]) {
      expect(gate.accept(snapshot)).toBe(false)
    }
  })

  it('versions renderer snapshots and clears the visible count when auth or profile ownership changes', () => {
    const gate = new RecoveredDraftCountGate()
    expect(gate.bindOwner(recoveredDraftOwnerKey(true, 'Work'))).toBe(false)
    expect(gate.accept({ count: 3, revision: 5 })).toBe(true)
    expect(gate.bindOwner(recoveredDraftOwnerKey(true, 'Work'))).toBe(false)
    expect(gate.accept({ count: 3, revision: 4 })).toBe(false)

    // Sign-out is a new owner: clear, and a lower revision from the new owner is accepted again.
    expect(gate.bindOwner(recoveredDraftOwnerKey(false, 'Work'))).toBe(true)
    expect(gate.accept({ count: 0, revision: 0 })).toBe(true)

    // A profile switch is also a new owner.
    gate.accept({ count: 1, revision: 6 })
    expect(gate.bindOwner(recoveredDraftOwnerKey(false, 'Home'))).toBe(true)
    expect(gate.accept({ count: 2, revision: 1 })).toBe(true)
  })
})
