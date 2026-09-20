import { describe, expect, it } from 'vitest'
import { buildStandSnapshot, STAND_QUESTIONS } from './stand-snapshot'
import type { DashboardData } from '../types/data'

function bare(partial: Partial<DashboardData> = {}): DashboardData {
  return {
    meta: {
      is_placeholder: false,
      note: 'test',
      generated: new Date().toISOString(),
      n_deals: 0
    },
    people: [],
    accounts: [],
    deals: [],
    meetings_feed: [],
    account_graph: { nodes: [], edges: [] },
    account_summaries: [],
    sector_summaries: [],
    coaching_insights: [],
    going_cold: [],
    warnings: [],
    ingest_errors: [],
    status: { meetings: 0, people: 0, accounts: 0, deals: 0, nodes: 0, edges: 0 },
    ...partial
  }
}

describe('Cap3 stand snapshot', () => {
  it('covers all seven locked questions', () => {
    const snap = buildStandSnapshot(bare())
    expect(snap.answers.map((a) => a.question)).toEqual([...STAND_QUESTIONS])
  })

  it('missing ≠ 0 — absent deals collection is insufficient, not zero open', () => {
    const data = bare()
    ;(data as { deals?: unknown }).deals = undefined
    const snap = buildStandSnapshot(data)
    const overall = snap.answers.find((a) => a.question === 'Where do we stand overall?')!
    expect(overall.facts.some((f) => f.kind === 'missing' && f.key === 'openDeals')).toBe(true)
    expect(overall.facts.some((f) => f.kind === 'count' && f.key === 'openDeals' && f.value === 0)).toBe(
      false
    )
    expect(snap.deterministicHint).toBe('insufficient')
    expect(snap.evidencePayload.openDeals).toBeNull()
  })

  it('empty deals array is a real zero, not missing', () => {
    const snap = buildStandSnapshot(bare({ deals: [] }))
    const overall = snap.answers.find((a) => a.question === 'Where do we stand overall?')!
    expect(overall.facts.some((f) => f.kind === 'count' && f.key === 'openDeals' && f.value === 0)).toBe(
      true
    )
  })

  it('evidence payload never invents week delta from status totals alone', () => {
    const data = bare({
      status: { meetings: 12, people: 0, accounts: 0, deals: 0, nodes: 0, edges: 0 }
    })
    ;(data as { meetings_feed?: unknown }).meetings_feed = undefined
    const snap = buildStandSnapshot(data)
    expect(snap.evidencePayload.meetingsThisWeek).toBeNull()
    const changed = snap.answers.find((a) => a.question === 'What changed since last week?')!
    expect(changed.facts.some((f) => f.kind === 'missing')).toBe(true)
  })
})
