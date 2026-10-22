import { describe, expect, it } from 'vitest'
import {
  MAX_HANDOFF_TURNS,
  anchorOf,
  createTurnLedger,
  goalDigestOf,
  type HandoffAnchor,
  type TurnLedger
} from './ask-handoff'

const ANCHOR: HandoffAnchor = {
  owner: `${'c'.repeat(8)}/${'a'.repeat(8)}`,
  sessionId: 'meeting-1',
  generation: 3,
  contextRevision: 10,
  permissionFingerprint: 'perm-a'
}
const GOAL = { mode: 'answer', prompt: 'What did we agree on the budget?' }

function ledger(): { ledger: TurnLedger; clock: { now: number } } {
  const clock = { now: 1_000 }
  return { ledger: createTurnLedger({ now: () => clock.now }), clock }
}

describe('goal digest', () => {
  it('is stable for the same goal and ignores whitespace and a deeper flag', () => {
    expect(goalDigestOf(GOAL)).toBe(goalDigestOf({ ...GOAL, prompt: '  What did we  agree on the budget?\n' }))
    expect(goalDigestOf(GOAL)).toBe(goalDigestOf({ ...GOAL, depth: 'deeper' }))
  })

  it('changes with the mode, the kind or the words', () => {
    const base = goalDigestOf(GOAL)
    expect(goalDigestOf({ ...GOAL, mode: 'vision' })).not.toBe(base)
    expect(goalDigestOf({ ...GOAL, kind: 'factcheck' })).not.toBe(base)
    expect(goalDigestOf({ ...GOAL, prompt: 'Something else.' })).not.toBe(base)
  })

  it('carries no prompt text', () => {
    expect(goalDigestOf(GOAL)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('anchorOf', () => {
  it('reads the owner, session, generation, revision and grants from the snapshot', () => {
    const handle = {
      snapshot: {
        scope: { tenantId: 'tenant-1', userId: 'user-1', sessionId: 'meeting-9' },
        generation: 4,
        contextRevision: 12,
        permissionFingerprint: 'fp'
      }
    }
    expect(anchorOf(handle as never)).toEqual({
      owner: 'tenant-1/user-1',
      sessionId: 'meeting-9',
      generation: 4,
      contextRevision: 12,
      permissionFingerprint: 'fp'
    })
  })

  it('an ask with no live meeting has an empty anchor', () => {
    expect(anchorOf(null)).toEqual({
      owner: null,
      sessionId: null,
      generation: null,
      contextRevision: null,
      permissionFingerprint: null
    })
  })
})

describe('one turn, two stages', () => {
  it('a plain ask opens a turn whose id is its own', () => {
    const { ledger: l } = ledger()
    expect(l.open({ id: 'fast-1', ...GOAL }, ANCHOR)).toEqual({ kind: 'fresh', turnId: 'fast-1', stage: 'fast' })
    expect(l.turnOf('fast-1')?.stages).toEqual([
      expect.objectContaining({ id: 'fast-1', stage: 'fast', outcome: 'running', supersededBy: null })
    ])
  })

  it('a deeper ask of a delivered fast answer keeps the turn, supersedes the fast stage and records the lineage', () => {
    const { ledger: l } = ledger()
    l.open({ id: 'fast-1', ...GOAL }, ANCHOR)
    l.settle('fast-1', 'delivered')
    const plan = l.open({ id: 'deep-1', ...GOAL, depth: 'deeper' }, { ...ANCHOR, contextRevision: 12 })
    expect(plan).toEqual({
      kind: 'handoff',
      turnId: 'fast-1',
      stage: 'deep',
      supersedes: 'fast-1',
      supersededOutcome: 'delivered'
    })
    const turn = l.turnOf('deep-1')
    expect(turn?.turnId).toBe('fast-1')
    expect(turn?.stages.map((s) => [s.id, s.stage, s.supersededBy])).toEqual([
      ['fast-1', 'fast', 'deep-1'],
      ['deep-1', 'deep', null]
    ])
    // the same owner, session and grants, and a snapshot that is the fast one or a later one
    expect(turn?.stages.map((s) => s.anchor.contextRevision)).toEqual([10, 12])
    expect(turn?.stages.every((s) => s.anchor.owner === ANCHOR.owner)).toBe(true)
    expect(turn?.stages.every((s) => s.anchor.permissionFingerprint === ANCHOR.permissionFingerprint)).toBe(true)
  })

  it('a deeper ask while the fast stage is still running supersedes it too', () => {
    const { ledger: l } = ledger()
    l.open({ id: 'fast-1', ...GOAL }, ANCHOR)
    expect(l.open({ id: 'deep-1', ...GOAL, depth: 'deeper' }, ANCHOR)).toMatchObject({
      kind: 'handoff',
      supersedes: 'fast-1',
      supersededOutcome: 'running'
    })
  })

  it('a second deeper ask supersedes the deep stage, never the fast one twice', () => {
    const { ledger: l } = ledger()
    l.open({ id: 'fast-1', ...GOAL }, ANCHOR)
    l.settle('fast-1', 'delivered')
    l.open({ id: 'deep-1', ...GOAL, depth: 'deeper' }, ANCHOR)
    l.settle('deep-1', 'delivered')
    expect(l.open({ id: 'deep-2', ...GOAL, depth: 'deeper' }, ANCHOR)).toMatchObject({
      kind: 'handoff',
      turnId: 'fast-1',
      supersedes: 'deep-1'
    })
    expect(
      l
        .turnOf('deep-2')
        ?.stages.filter((s) => s.supersededBy === null)
        .map((s) => s.id)
    ).toEqual(['deep-2'])
  })

  it('looks the fast stage up by goal, so an unrelated ask in between does not break the handoff', () => {
    const { ledger: l } = ledger()
    l.open({ id: 'fast-1', ...GOAL }, ANCHOR)
    l.settle('fast-1', 'delivered')
    l.open({ id: 'other', mode: 'answer', prompt: 'A different question.' }, ANCHOR)
    l.settle('other', 'delivered')
    expect(l.open({ id: 'deep-1', ...GOAL, depth: 'deeper' }, ANCHOR)).toMatchObject({
      kind: 'handoff',
      turnId: 'fast-1',
      supersedes: 'fast-1'
    })
  })
})

describe('a handoff that cannot keep its promises is a fresh ask, said so', () => {
  const refusal = (anchor: Partial<HandoffAnchor>, setup?: (l: TurnLedger) => void): string | undefined => {
    const { ledger: l } = ledger()
    l.open({ id: 'fast-1', ...GOAL }, ANCHOR)
    l.settle('fast-1', 'delivered')
    setup?.(l)
    const plan = l.open({ id: 'deep-1', ...GOAL, depth: 'deeper' }, { ...ANCHOR, ...anchor })
    expect(plan.kind).toBe('fresh')
    if (plan.kind !== 'fresh') return undefined
    // a refused handoff is its own turn: it does not inherit the old identity
    expect(plan.turnId).toBe('deep-1')
    expect(l.turnOf('fast-1')?.stages[0].supersededBy).toBeNull()
    return plan.refused
  }

  it('different owner', () => {
    expect(refusal({ owner: 'other/owner' })).toBe('owner_changed')
  })
  it('different grants (Private View or a permission moved)', () => {
    expect(refusal({ permissionFingerprint: 'perm-b' })).toBe('permissions_changed')
  })
  it('a different meeting session or a stopped and resumed context', () => {
    expect(refusal({ sessionId: 'meeting-2' })).toBe('context_reset')
    expect(refusal({ generation: 4 })).toBe('context_reset')
  })
  it('a snapshot older than the fast one', () => {
    expect(refusal({ contextRevision: 9 })).toBe('context_reset')
  })
  it('a fast stage that never delivered (failed or cancelled)', () => {
    const { ledger: l } = ledger()
    l.open({ id: 'fast-1', ...GOAL }, ANCHOR)
    l.settle('fast-1', 'ended')
    expect(l.open({ id: 'deep-1', ...GOAL, depth: 'deeper' }, ANCHOR)).toEqual({
      kind: 'fresh',
      turnId: 'deep-1',
      stage: 'fast',
      refused: 'fast_not_delivered'
    })
  })
  it('no earlier turn with this goal', () => {
    const { ledger: l } = ledger()
    expect(l.open({ id: 'deep-1', ...GOAL, depth: 'deeper' }, ANCHOR)).toEqual({
      kind: 'fresh',
      turnId: 'deep-1',
      stage: 'fast',
      refused: 'no_fast_turn'
    })
  })
  it('an old turn is forgotten', () => {
    const { ledger: l, clock } = ledger()
    l.open({ id: 'fast-1', ...GOAL }, ANCHOR)
    l.settle('fast-1', 'delivered')
    clock.now += 60 * 60 * 1000
    expect(l.open({ id: 'deep-1', ...GOAL, depth: 'deeper' }, ANCHOR)).toMatchObject({ refused: 'no_fast_turn' })
  })
})

describe('bounds', () => {
  it('keeps at most MAX_HANDOFF_TURNS turns, oldest first out', () => {
    const { ledger: l } = ledger()
    for (let i = 0; i < MAX_HANDOFF_TURNS + 5; i++) l.open({ id: `t${i}`, mode: 'answer', prompt: `q${i}` }, ANCHOR)
    expect(l.size()).toBe(MAX_HANDOFF_TURNS)
    expect(l.turnOf('t0')).toBeUndefined()
    expect(l.turnOf(`t${MAX_HANDOFF_TURNS + 4}`)).toBeDefined()
  })

  it('settling or reading an unknown id is harmless', () => {
    const { ledger: l } = ledger()
    l.settle('nope', 'ended')
    expect(l.turnOf('nope')).toBeUndefined()
  })

  it('reusing an ask id replaces the old registration instead of duplicating it', () => {
    const { ledger: l } = ledger()
    l.open({ id: 'a', ...GOAL }, ANCHOR)
    l.open({ id: 'a', ...GOAL }, ANCHOR)
    expect(l.size()).toBe(1)
  })
})
