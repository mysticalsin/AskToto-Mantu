import { describe, it, expect } from 'vitest'
import {
  shouldPollAgain,
  stripChips,
  resolveEntityIds,
  confidenceBadge,
  STRIP_POLL_TIMEOUT_MS,
  type StripChip
} from './ReviewEntityStrip'
import { MeetingExtractionSchema, type BrainRead, type MeetingExtraction } from '@shared/brain'

const extraction = (overrides: Record<string, unknown> = {}): MeetingExtraction =>
  MeetingExtractionSchema.parse({
    account: { name: 'Acme Corp', sector: 'banking', confidence: 'EXTRACTED' },
    people: [
      { name: 'Maria Silva', role: 'CFO', org: null, confidence: 'EXTRACTED' },
      { name: 'John Doe', role: null, org: null, confidence: 'AMBIGUOUS' }
    ],
    deal: { name: 'Core Banking', stage: 'discovery' },
    ...overrides
  })

describe('shouldPollAgain — strip poll stop conditions (2s cadence, 60s budget, silent stop)', () => {
  it('keeps polling while no extraction and under the budget', () => {
    expect(shouldPollAgain(0, null)).toBe(true)
    expect(shouldPollAgain(STRIP_POLL_TIMEOUT_MS - 1, null)).toBe(true)
  })

  it('stops at the 60s budget', () => {
    expect(shouldPollAgain(STRIP_POLL_TIMEOUT_MS, null)).toBe(false)
    expect(shouldPollAgain(STRIP_POLL_TIMEOUT_MS + 1, null)).toBe(false)
  })

  it('stops the moment an extraction exists, regardless of elapsed time', () => {
    expect(shouldPollAgain(0, extraction())).toBe(false)
    expect(shouldPollAgain(STRIP_POLL_TIMEOUT_MS + 999, extraction())).toBe(false)
  })
})

describe('stripChips — which chips one extraction yields', () => {
  it('yields account, people, and deal chips with their confidences', () => {
    const chips = stripChips(extraction())
    expect(chips).toEqual([
      { kind: 'account', name: 'Acme Corp', confidence: 'EXTRACTED' },
      { kind: 'person', name: 'Maria Silva', confidence: 'EXTRACTED' },
      { kind: 'person', name: 'John Doe', confidence: 'AMBIGUOUS' },
      { kind: 'deal', name: 'Core Banking', confidence: 'EXTRACTED' }
    ])
  })

  it('a null extraction yields nothing', () => {
    expect(stripChips(null)).toEqual([])
  })

  it('skips a null account, blank-named people, and a blank deal name', () => {
    const chips = stripChips(
      extraction({ account: null, people: [{ name: '  ', role: null, org: null, confidence: 'EXTRACTED' }], deal: { name: '', stage: '' } })
    )
    expect(chips).toEqual([])
  })

  it('a deal chip inherits the account confidence when the account is AMBIGUOUS', () => {
    const chips = stripChips(
      extraction({
        account: { name: 'Acme Corp', sector: 'banking', confidence: 'AMBIGUOUS' },
        people: []
      })
    )
    expect(chips.find((c) => c.kind === 'deal')?.confidence).toBe('AMBIGUOUS')
  })
})

describe('resolveEntityIds — chip name → live entity id (exact, case-insensitive, alias-aware)', () => {
  const read = {
    people: [{ id: 'maria-silva', name: 'Maria Silva', aliases: ['M Silva'] }],
    accounts: [{ id: 'acme-corp', name: 'Acme', aliases: ['Acme Corp'] }],
    deals: [{ id: 'core-banking', name: 'Core Banking', aliases: [] }]
  } as unknown as BrainRead

  it('resolves by current name, by alias, and case-insensitively', () => {
    const chips: StripChip[] = [
      { kind: 'person', name: 'maria silva', confidence: 'EXTRACTED' },
      { kind: 'account', name: 'Acme Corp', confidence: 'EXTRACTED' }, // alias of the renamed account
      { kind: 'deal', name: 'Core Banking', confidence: 'EXTRACTED' }
    ]
    const resolved = resolveEntityIds(chips, read)
    expect(resolved.map((c) => c.id)).toEqual(['maria-silva', 'acme-corp', 'core-banking'])
  })

  it('a name matching nothing stays id-less (display-only chip)', () => {
    const resolved = resolveEntityIds([{ kind: 'person', name: 'Nobody', confidence: 'EXTRACTED' }], read)
    expect(resolved[0].id).toBeUndefined()
  })

  it('never cross-matches kinds — a person named like an account resolves only within person entities', () => {
    const resolved = resolveEntityIds([{ kind: 'person', name: 'Acme', confidence: 'EXTRACTED' }], read)
    expect(resolved[0].id).toBeUndefined()
  })
})

describe('confidenceBadge — EXTRACTED plain, INFERRED hollow, AMBIGUOUS warning tint', () => {
  it('EXTRACTED gets no badge', () => {
    expect(confidenceBadge('EXTRACTED')).toBeNull()
  })
  it('INFERRED gets a hollow badge', () => {
    expect(confidenceBadge('INFERRED')).toEqual({ label: 'inferred', variant: 'hollow' })
  })
  it('AMBIGUOUS gets a warning badge', () => {
    expect(confidenceBadge('AMBIGUOUS')).toEqual({ label: 'unsure', variant: 'warn' })
  })
})
