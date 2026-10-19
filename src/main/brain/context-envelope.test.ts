import { describe, expect, it } from 'vitest'
import type { BrainContextBuildResult } from './context'
import {
  brainContextForProvider,
  createBrainContextEnvelope,
  unavailableBrainContextEnvelope
} from './context-envelope'

const owner = {
  authSessionGeneration: 3,
  contextRevision: 8,
  brainRevision: 12,
  profileKey: 'a'.repeat(64)
} as const

const readyResult: BrainContextBuildResult = {
  block: 'historical facts [meeting.md]',
  matched: true,
  sourceReferences: [
    {
      kind: 'meeting',
      source: 'meeting.md',
      date: '2026-10-01',
      sourceRootId: 'b'.repeat(64),
      sourceDigest: 'c'.repeat(64)
    }
  ],
  sourceReferencesComplete: true
}

describe('main-only brain context envelope', () => {
  it('keeps a bounded ready block and explicit source references for the same owner', () => {
    const envelope = createBrainContextEnvelope(owner, readyResult)
    expect(envelope.version).toBe(1)
    expect(envelope.status).toBe('ready')
    expect(envelope.budget.usedChars).toBe(readyResult.block.length)
    expect(envelope.sourceReferences).toEqual(readyResult.sourceReferences)
    expect(brainContextForProvider(envelope, owner)).toBe(readyResult.block)
  })

  it('omits empty, unavailable, and stale-owner context from provider prompts', () => {
    const empty = createBrainContextEnvelope(owner, {
      block: '',
      matched: false,
      sourceReferences: [],
      sourceReferencesComplete: true
    })
    expect(empty.status).toBe('empty')
    expect(brainContextForProvider(empty, owner)).toBeUndefined()

    const unavailable = unavailableBrainContextEnvelope(owner)
    expect(unavailable.status).toBe('unavailable')
    expect(brainContextForProvider(unavailable, owner)).toBeUndefined()

    const staleOwner = { ...owner, authSessionGeneration: owner.authSessionGeneration + 1 }
    expect(brainContextForProvider(createBrainContextEnvelope(owner, readyResult), staleOwner)).toBeUndefined()
    expect(
      brainContextForProvider(createBrainContextEnvelope(owner, readyResult), {
        ...owner,
        brainRevision: owner.brainRevision + 1
      })
    ).toBeUndefined()
    expect(
      brainContextForProvider(createBrainContextEnvelope(owner, readyResult), { ...owner, profileKey: 'b'.repeat(64) })
    ).toBeUndefined()
  })

  it('omits malformed or over-budget envelopes', () => {
    const envelope = createBrainContextEnvelope(owner, readyResult)
    expect(
      brainContextForProvider({ ...envelope, budget: { ...envelope.budget, usedChars: 0 } }, owner)
    ).toBeUndefined()
    expect(
      brainContextForProvider(
        {
          ...envelope,
          sourceReferences: Array.from({ length: 65 }, () => ({
            kind: 'meeting' as const,
            source: 'm.md',
            sourceRootId: 'b'.repeat(64),
            sourceDigest: 'c'.repeat(64)
          }))
        },
        owner
      )
    ).toBeUndefined()
    expect(createBrainContextEnvelope(owner, { ...readyResult, sourceReferencesComplete: false }).status).toBe(
      'unavailable'
    )
    expect(
      createBrainContextEnvelope(owner, {
        ...readyResult,
        sourceReferences: [
          { kind: 'meeting', source: 'm'.repeat(513), sourceRootId: 'b'.repeat(64), sourceDigest: 'c'.repeat(64) }
        ]
      }).status
    ).toBe('unavailable')
  })
})
