import { describe, expect, it } from 'vitest'
import { brainToDashboard, type BrainRead } from './brainAdapter.ts'
import { slug } from './slug.ts'

/**
 * Synthetic BrainRead fixture exercising every corner brainAdapter.ts touches: 2 accounts, 3 people,
 * 3 deals (one won with a kept commitment, one plain open deal, one single-threaded open deal), 4 dated
 * meetings with sentiment/topics, an index warning, one failed ingest entry, and two deliberately
 * duplicated feedback/missed-signal statements (to prove coaching-insight clustering + confidence math).
 *
 * Account structure on purpose:
 *   Acme Corp   — 2 mapped people (Jane Doe, John Smith) → its open deal is NOT single-threaded.
 *   Globex Inc  — 1 mapped person (Ravi Patel)            → its open deal IS single-threaded.
 */
const FIXTURE: BrainRead = {
  index: {
    warnings: ['Globex Inc has no confirmed budget owner mapped after 3 meetings.'],
    ingested: {
      'm1.md': { at: 1, ok: true },
      'm2.md': { at: 2, ok: true },
      'm3.md': { at: 3, ok: true },
      'm4.md': { at: 4, ok: true },
      'm5-corrupt.md': { at: 5, ok: false, error: 'JSON parse failure on model output' }
    }
  },
  graph: {
    nodes: [
      { id: 'account:acme-corp', type: 'account', label: 'Acme Corp' },
      { id: 'account:globex-inc', type: 'account', label: 'Globex Inc' },
      { id: 'person:jane-doe', type: 'person', label: 'Jane Doe' },
      { id: 'person:john-smith', type: 'person', label: 'John Smith' },
      { id: 'person:ravi-patel', type: 'person', label: 'Ravi Patel' },
      { id: 'deal:acme-platform-deal', type: 'deal', label: 'Acme Platform Deal' },
      { id: 'deal:acme-expansion', type: 'deal', label: 'Acme Expansion' },
      { id: 'deal:globex-renewal', type: 'deal', label: 'Globex Renewal' },
      { id: 'sector:technology', type: 'sector', label: 'technology' },
      { id: 'sector:banking', type: 'sector', label: 'banking' },
      // Meeting nodes: present in the raw brain graph, must be dropped from the DISPLAY graph.
      { id: 'meeting:m1', type: 'meeting', label: 'Acme Kickoff Call' },
      { id: 'meeting:m2', type: 'meeting', label: 'Acme SOW Review' },
      { id: 'meeting:m3', type: 'meeting', label: 'Acme Expansion Chat' },
      { id: 'meeting:m4', type: 'meeting', label: 'Globex Renewal Sync' }
    ],
    edges: [
      { from: 'person:jane-doe', to: 'account:acme-corp', rel: 'works-at', confidence: 'EXTRACTED' },
      { from: 'person:john-smith', to: 'account:acme-corp', rel: 'works-at', confidence: 'EXTRACTED' },
      { from: 'person:ravi-patel', to: 'account:globex-inc', rel: 'works-at', confidence: 'EXTRACTED' },
      { from: 'deal:acme-platform-deal', to: 'account:acme-corp', rel: 'belongs-to', confidence: 'EXTRACTED' },
      { from: 'deal:acme-expansion', to: 'account:acme-corp', rel: 'belongs-to', confidence: 'EXTRACTED' },
      { from: 'deal:globex-renewal', to: 'account:globex-inc', rel: 'belongs-to', confidence: 'EXTRACTED' },
      { from: 'account:acme-corp', to: 'sector:technology', rel: 'in-sector', confidence: 'EXTRACTED' },
      { from: 'account:globex-inc', to: 'sector:banking', rel: 'in-sector', confidence: 'EXTRACTED' },
      // A single cross-account bridge: makes the display graph ONE connected component so the
      // community test below actually proves label propagation beats connected-components.
      { from: 'account:acme-corp', to: 'account:globex-inc', rel: 'related-account', confidence: 'INFERRED' },
      // Meeting-node edges: must be dropped along with their nodes.
      { from: 'meeting:m1', to: 'account:acme-corp', rel: 'discussed-in', confidence: 'EXTRACTED' },
      { from: 'meeting:m1', to: 'person:jane-doe', rel: 'attends', confidence: 'EXTRACTED' },
      { from: 'meeting:m2', to: 'deal:acme-platform-deal', rel: 'discussed-in', confidence: 'EXTRACTED' },
      { from: 'meeting:m4', to: 'deal:globex-renewal', rel: 'discussed-in', confidence: 'EXTRACTED' }
    ]
  },
  people: [
    {
      name: 'Jane Doe',
      role: 'VP Engineering',
      account: 'Acme Corp',
      // MI-2.5 Fix C fixture: role is a pending suggestion (state 'extracted'), org has no sidecar at
      // all — proves field_state carries the former and honestly omits the latter (never an implicit
      // 'extracted').
      role_provenance: { state: 'extracted' },
      meetings: [
        { file: 'm1.md', date: '2026-01-10', title: 'Acme Kickoff Call' },
        { file: 'm2.md', date: '2026-02-01', title: 'Acme SOW Review' }
      ],
      stance_trail: [
        { meeting: 'm1.md', kind: 'positive', statement: 'Enthusiastic about the roadmap fit' },
        { meeting: 'm2.md', kind: 'positive', statement: 'Pushing internally for sign-off' }
      ],
      commitments: [
        { text: 'Loop in procurement', by: 'Jane Doe', status: 'open', due_hint: 'next week', quote: '', meeting: 'm2.md', date: '2026-02-01' }
      ]
    },
    {
      name: 'John Smith',
      role: 'Procurement Lead',
      account: 'Acme Corp',
      meetings: [{ file: 'm3.md', date: '2026-01-20', title: 'Acme Expansion Chat' }],
      stance_trail: [],
      commitments: []
    },
    {
      name: 'Ravi Patel',
      role: 'Head of Vendor Risk',
      account: 'Globex Inc',
      meetings: [{ file: 'm4.md', date: '2026-01-25', title: 'Globex Renewal Sync' }],
      stance_trail: [{ meeting: 'm4.md', kind: 'objection', statement: 'Flagged the price increase to his boss' }],
      commitments: []
    }
  ],
  accounts: [
    {
      name: 'Acme Corp',
      sector: 'technology',
      strategic: true,
      // MI-2.5 Fix C fixture: a human already confirmed this one — proves field_state carries states
      // other than 'extracted' through untouched, not just the pending-review case.
      sector_provenance: { state: 'verified' },
      people: ['jane-doe', 'john-smith'],
      deals: ['acme-platform-deal', 'acme-expansion'],
      meetings: [
        { file: 'm1.md', date: '2026-01-10', title: 'Acme Kickoff Call' },
        { file: 'm2.md', date: '2026-02-01', title: 'Acme SOW Review' },
        { file: 'm3.md', date: '2026-01-20', title: 'Acme Expansion Chat' }
      ],
      win_reasons: [{ statement: 'Strong technical fit with the platform', quote: 'this integrates perfectly with our stack', meeting: 'm2.md' }],
      loss_reasons: []
    },
    {
      name: 'Globex Inc',
      sector: 'banking',
      strategic: false,
      people: ['ravi-patel'],
      deals: ['globex-renewal'],
      meetings: [{ file: 'm4.md', date: '2026-01-25', title: 'Globex Renewal Sync' }],
      win_reasons: [],
      loss_reasons: [{ statement: 'Price sensitivity from procurement', quote: 'the price increase is too steep for us', meeting: 'm4.md' }]
    }
  ],
  deals: [
    {
      name: 'Acme Platform Deal',
      account: 'Acme Corp',
      stage: 'closed-won',
      outcome: 'won',
      win_likelihood_band: 'good',
      band_evidence: 'Legal signed off and budget is confirmed',
      velocity: { signal: 'hard-calendar-gate', evidence: 'must sign before Q1 close (March 31)' },
      // MI-2.5 Fix C fixture: stage already human-pinned, win_likelihood_band still a pending
      // suggestion, velocity has no sidecar at all — exercises all three field_state outcomes on one deal.
      stage_provenance: { state: 'pinned' },
      win_likelihood_band_provenance: { state: 'extracted' },
      meetings: [
        { file: 'm1.md', date: '2026-01-10', title: 'Acme Kickoff Call' },
        { file: 'm2.md', date: '2026-02-01', title: 'Acme SOW Review' }
      ],
      signals: [
        { kind: 'positive', statement: 'Budget confirmed for the platform deal', quote: 'we have the budget approved', confidence: 'EXTRACTED', meeting: 'm1.md' },
        { kind: 'positive', statement: 'Champion pushing internally for sign-off', quote: '', confidence: 'INFERRED', meeting: 'm2.md' }
      ],
      missed_signals: [],
      feedback: [{ note: 'Could have pushed for a multi-year contract term structure', quote: '', confidence: 'INFERRED', meeting: 'm2.md' }],
      commitments: [
        { text: 'Send updated SOW', by: 'you', due_hint: 'by Friday', quote: 'I will send the SOW by Friday', confidence: 'EXTRACTED', meeting: 'm2.md', date: '2026-02-01', status: 'kept' }
      ]
    },
    {
      name: 'Acme Expansion',
      account: 'Acme Corp',
      stage: 'discovery',
      outcome: 'open',
      win_likelihood_band: 'mixed',
      band_evidence: 'Early stage, budget not yet confirmed',
      velocity: { signal: 'no-hard-date-found', evidence: '' },
      meetings: [{ file: 'm3.md', date: '2026-01-20', title: 'Acme Expansion Chat' }],
      signals: [{ kind: 'neutral', statement: 'Discussing phase 2 scope', quote: '', confidence: 'INFERRED', meeting: 'm3.md' }],
      missed_signals: [
        { statement: 'Never asked about the timeline for phase 2 budget approval', why_it_matters: 'Could reveal a hidden budget cycle risk', quote: '', confidence: 'INFERRED', meeting: 'm3.md' }
      ],
      feedback: [{ note: 'Could have pushed for a multi-year contract term structure', quote: '', confidence: 'INFERRED', meeting: 'm3.md' }],
      commitments: []
    },
    {
      name: 'Globex Renewal',
      account: 'Globex Inc',
      stage: 'renewal-at-risk',
      outcome: 'open',
      win_likelihood_band: 'concerning',
      band_evidence: 'Client flagged budget pressure from procurement',
      velocity: { signal: 'soft-organizational-gate', evidence: 'renewal expected before year end' },
      meetings: [{ file: 'm4.md', date: '2026-01-25', title: 'Globex Renewal Sync' }],
      signals: [{ kind: 'objection', statement: 'Price increase is a sticking point', quote: 'the price increase is too steep for us', confidence: 'EXTRACTED', meeting: 'm4.md' }],
      missed_signals: [
        { statement: 'Never asked about the timeline for phase 2 budget approval', why_it_matters: 'Could reveal a hidden budget cycle risk', quote: '', confidence: 'INFERRED', meeting: 'm4.md' }
      ],
      feedback: [],
      commitments: []
    }
  ],
  meetings: [
    { source_file: 'm1.md', date: '2026-01-10', title24: 'Acme Kickoff Call', sentiment: 'good', topics: ['budget', 'timeline', 'stakeholders'], account: { name: 'Acme Corp' } },
    { source_file: 'm2.md', date: '2026-02-01', title24: 'Acme SOW Review', sentiment: 'good', topics: ['contract', 'pricing'], account: { name: 'Acme Corp' } },
    { source_file: 'm3.md', date: '2026-01-20', title24: 'Acme Expansion Chat', sentiment: 'mixed', topics: ['expansion', 'roadmap'], account: { name: 'Acme Corp' } },
    { source_file: 'm4.md', date: '2026-01-25', title24: 'Globex Renewal Sync', sentiment: 'concerning', topics: ['price', 'renewal'], account: { name: 'Globex Inc' } }
  ]
}

const dashboard = brainToDashboard(FIXTURE)

describe('brainToDashboard — claims', () => {
  it('carries every signal as a claim, with raised_by/was_deciding_factor honestly omitted', () => {
    expect(dashboard.deals.flatMap((d) => d.claims)).toHaveLength(4)
    for (const d of dashboard.deals) {
      for (const c of d.claims) {
        expect(c.raised_by).toBeUndefined()
        expect(c.was_deciding_factor).toBeUndefined()
      }
    }
  })

  it('categorizes claims from their statement + quote text', () => {
    const globexRenewal = dashboard.deals.find((d) => d.display_name === 'Globex Renewal')!
    expect(globexRenewal.claims[0].category).toBe('pricing')
    expect(globexRenewal.claims[0].stance).toBe('objection')
  })
})

describe('brainToDashboard — deals: band_evidence, velocity, commitments', () => {
  const won = dashboard.deals.find((d) => d.display_name === 'Acme Platform Deal')!
  const expansion = dashboard.deals.find((d) => d.display_name === 'Acme Expansion')!
  const renewal = dashboard.deals.find((d) => d.display_name === 'Globex Renewal')!

  it('carries band_evidence and velocity through untouched', () => {
    expect(won.band_evidence).toBe('Legal signed off and budget is confirmed')
    expect(won.velocity).toEqual({ signal: 'hard-calendar-gate', evidence: 'must sign before Q1 close (March 31)' })
    expect(expansion.velocity.signal).toBe('no-hard-date-found')
  })

  it('carries the deal commitment ledger with normalized status', () => {
    expect(won.commitments).toHaveLength(1)
    expect(won.commitments[0]).toEqual({
      text: 'Send updated SOW',
      by: 'you',
      status: 'kept',
      due_hint: 'by Friday',
      quote: 'I will send the SOW by Friday',
      date: '2026-02-01',
      meeting: 'm2.md'
    })
    expect(expansion.commitments).toEqual([])
    expect(renewal.commitments).toEqual([])
  })

  it('marks the won deal correctly and leaves the others open', () => {
    expect(won.outcome).toBe('won')
    expect(expansion.outcome).toBe('open')
    expect(renewal.outcome).toBe('open')
  })
})

describe('brainToDashboard — coaching insights (clustering + confidence)', () => {
  it('clusters the two duplicated feedback notes and the two duplicated missed signals into exactly 2 insights', () => {
    expect(dashboard.coaching_insights).toHaveLength(2)
    for (const insight of dashboard.coaching_insights) {
      expect(insight.n_observations).toBe(2)
      expect(insight.deals).toHaveLength(2)
    }
  })

  it('computes the corroboration-boosted confidence exactly (INFERRED base 0.55 + 1 extra observation * 0.06, no quote)', () => {
    for (const insight of dashboard.coaching_insights) {
      expect(insight.confidence).toBeCloseTo(0.61, 5)
      expect(insight.grounding).toBe('assumed')
    }
  })

  it('buckets the missed-signal cluster as pricing (mentions "budget") and the feedback cluster as commercial-model (mentions "contract")', () => {
    const categories = dashboard.coaching_insights.map((i) => i.category).sort()
    expect(categories).toEqual(['commercial-model', 'pricing'])
  })
})

describe('brainToDashboard — scope summaries', () => {
  it('rolls up account_summaries with non-empty insight_ids', () => {
    const acme = dashboard.account_summaries.find((s) => s.label === 'Acme Corp')!
    const globex = dashboard.account_summaries.find((s) => s.label === 'Globex Inc')!
    expect(acme.deal_count).toBe(2)
    expect(acme.band_counts).toEqual({ good: 1, mixed: 1, concerning: 0 })
    expect(acme.insight_ids.length).toBeGreaterThan(0)
    expect(globex.deal_count).toBe(1)
    expect(globex.band_counts).toEqual({ good: 0, mixed: 0, concerning: 1 })
    expect(globex.insight_ids.length).toBeGreaterThan(0)
  })

  it('rolls up sector_summaries with non-empty insight_ids (the hardcoded [] bug)', () => {
    const technology = dashboard.sector_summaries.find((s) => s.label === 'technology')!
    const banking = dashboard.sector_summaries.find((s) => s.label === 'banking')!
    expect(technology.deal_count).toBe(2)
    expect(technology.insight_ids.length).toBeGreaterThan(0)
    expect(banking.deal_count).toBe(1)
    expect(banking.insight_ids.length).toBeGreaterThan(0)
  })
})

describe('brainToDashboard — display graph', () => {
  it('drops meeting nodes/edges from the display graph', () => {
    expect(dashboard.account_graph.nodes).toHaveLength(10) // 2 accounts + 3 people + 3 deals + 2 sectors
    expect(dashboard.account_graph.nodes.some((n) => n.type === 'meeting' as never)).toBe(false)
    // 9 non-meeting edges defined in the fixture; the 4 meeting-attached edges are dropped.
    expect(dashboard.account_graph.edges).toHaveLength(9)
  })

  it('computes degree from the filtered edge set', () => {
    const acme = dashboard.account_graph.nodes.find((n) => n.id === 'account:acme-corp')!
    // jane, john, 2 deals, sector, globex-inc bridge = 6
    expect(acme.degree).toBe(6)
    const jane = dashboard.account_graph.nodes.find((n) => n.id === 'person:jane-doe')!
    expect(jane.degree).toBe(1)
  })

  it('finds more than one community via label propagation even though the graph is one connected component', () => {
    const communityIds = new Set(dashboard.account_graph.nodes.map((n) => n.community_id))
    expect(communityIds.size).toBeGreaterThan(1)
    const acme = dashboard.account_graph.nodes.find((n) => n.id === 'account:acme-corp')!
    const globex = dashboard.account_graph.nodes.find((n) => n.id === 'account:globex-inc')!
    expect(acme.community_id).not.toBe(globex.community_id)
    // Local structure preserved: each account's own people/deals land in the SAME community as it.
    const jane = dashboard.account_graph.nodes.find((n) => n.id === 'person:jane-doe')!
    const ravi = dashboard.account_graph.nodes.find((n) => n.id === 'person:ravi-patel')!
    expect(jane.community_id).toBe(acme.community_id)
    expect(ravi.community_id).toBe(globex.community_id)
  })

  it('derives ref/date/is_client_facing on entity nodes from their own latest dated meeting', () => {
    const acme = dashboard.account_graph.nodes.find((n) => n.id === 'account:acme-corp')!
    expect(acme.date).toBe('2026-02-01') // latest of m1/m2/m3
    expect(acme.ref).toBe('m2.md')
    expect(acme.is_client_facing).toBe(true)
    const ravi = dashboard.account_graph.nodes.find((n) => n.id === 'person:ravi-patel')!
    expect(ravi.date).toBe('2026-01-25')
    expect(ravi.ref).toBe('m4.md')
  })
})

describe('brainToDashboard — entity carry-through (accounts/people)', () => {
  it('carries account win_reasons/loss_reasons', () => {
    const acme = dashboard.accounts.find((a) => a.name === 'Acme Corp')!
    const globex = dashboard.accounts.find((a) => a.name === 'Globex Inc')!
    expect(acme.win_reasons).toEqual([{ statement: 'Strong technical fit with the platform', quote: 'this integrates perfectly with our stack', meeting: 'm2.md' }])
    expect(acme.loss_reasons).toEqual([])
    expect(globex.loss_reasons).toHaveLength(1)
    expect(acme.slug).toBe(slug('Acme Corp'))
  })

  it('carries person role, stance_trail, and commitment ledger', () => {
    const jane = dashboard.people.find((p) => p.name === 'Jane Doe')!
    expect(jane.role).toBe('VP Engineering')
    expect(jane.stance_trail).toHaveLength(2)
    expect(jane.commitments).toEqual([
      { text: 'Loop in procurement', by: 'Jane Doe', status: 'open', due_hint: 'next week', quote: '', date: '2026-02-01', meeting: 'm2.md' }
    ])
    const ravi = dashboard.people.find((p) => p.name === 'Ravi Patel')!
    expect(ravi.stance_trail).toEqual([{ meeting: 'm4.md', kind: 'objection', statement: 'Flagged the price increase to his boss' }])
  })

  // ── MI-2.5 Fix C: field_state (dashboard suggestion accept/dismiss, deferred CRM pattern 3) ────
  it('carries each provenance sidecar\'s state into field_state, keyed by field name', () => {
    const jane = dashboard.people.find((p) => p.name === 'Jane Doe')!
    expect(jane.field_state).toEqual({ role: 'extracted' }) // org has no sidecar — honestly omitted

    const acme = dashboard.accounts.find((a) => a.name === 'Acme Corp')!
    expect(acme.field_state).toEqual({ sector: 'verified' }) // carries states other than 'extracted' too

    const won = dashboard.deals.find((d) => d.display_name === 'Acme Platform Deal')!
    expect(won.field_state).toEqual({ stage: 'pinned', win_likelihood_band: 'extracted' }) // velocity omitted
  })

  it('omits field_state entirely for an entity with no provenance sidecars at all', () => {
    const ravi = dashboard.people.find((p) => p.name === 'Ravi Patel')!
    expect(ravi.field_state).toBeUndefined()

    const globex = dashboard.accounts.find((a) => a.name === 'Globex Inc')!
    expect(globex.field_state).toBeUndefined()

    const renewal = dashboard.deals.find((d) => d.display_name === 'Globex Renewal')!
    expect(renewal.field_state).toBeUndefined()
  })
})

describe('brainToDashboard — meetings feed', () => {
  it('carries all 4 meetings, newest first, with sentiment/topics/account', () => {
    expect(dashboard.meetings_feed).toHaveLength(4)
    expect(dashboard.meetings_feed.map((m) => m.date)).toEqual(['2026-02-01', '2026-01-25', '2026-01-20', '2026-01-10'])
    const first = dashboard.meetings_feed[0]
    expect(first.title24).toBe('Acme SOW Review')
    expect(first.account).toBe('Acme Corp')
    expect(first.sentiment).toBe('good')
    expect(first.topics).toEqual(['contract', 'pricing'])
    expect(first.slug).toBe(slug('m2.md'))
  })

  it('does not present a persisted-but-unmapped extraction as an indexed meeting', () => {
    const partial = {
      source_file: 'm5-corrupt.md',
      date: '2026-02-10',
      title24: 'Interrupted extraction',
      sentiment: 'mixed' as const,
      topics: ['partial'],
      account: null
    }
    const data = brainToDashboard({ ...FIXTURE, meetings: [...(FIXTURE.meetings ?? []), partial] })

    expect(data.meetings_feed.map((meeting) => meeting.slug)).not.toContain(slug('m5-corrupt.md'))
    expect(data.status.meetings).toBe(data.meetings_feed.length)
  })
})

describe('brainToDashboard — warnings, ingest errors, status', () => {
  it('carries index warnings through untouched', () => {
    expect(dashboard.warnings).toEqual(['Globex Inc has no confirmed budget owner mapped after 3 meetings.'])
  })

  it('surfaces the failed ingest entry as a structured error', () => {
    expect(dashboard.ingest_errors).toEqual([{ file: 'm5-corrupt.md', error: 'JSON parse failure on model output' }])
  })

  it('computes status counts that match the fixture, and parity with entity array lengths', () => {
    expect(dashboard.status).toEqual({
      meetings: 4, // 5 ingested, 1 failed (ok:false) — only the 4 successful ones count
      people: 3,
      accounts: 2,
      deals: 3,
      nodes: 14, // full raw graph, including the 4 meeting nodes the display graph drops
      edges: 13
    })
    expect(dashboard.status.people).toBe(dashboard.people.length)
    expect(dashboard.status.accounts).toBe(dashboard.accounts.length)
    expect(dashboard.status.deals).toBe(dashboard.deals.length)
    expect(dashboard.status.meetings).toBe(dashboard.meetings_feed.length)
  })
})

describe('brainToDashboard — going cold (single-threaded structural risk, sanity)', () => {
  it('flags the single-mapped-person Globex deal as single-threaded but not the 2-person Acme deal', () => {
    const globexDealNode = dashboard.account_graph.nodes.find((n) => n.id === 'deal:globex-renewal')!
    const acmeExpansionNode = dashboard.account_graph.nodes.find((n) => n.id === 'deal:acme-expansion')!
    expect(globexDealNode.single_threaded).toBe(true)
    expect(acmeExpansionNode.single_threaded).toBe(false)
  })
})

describe('MQA-220 — a rejected commitment never reaches the dashboard', () => {
  // 'rejected' is a human override: the user opened the record in Métis and struck out a promise the
  // extractor misheard. The adapter used to map every unrecognized status to 'open', so that struck-out
  // promise came back as a live obligation here — counted in the open tile, aged into the 90+ day
  // bucket, and scored into Needs attention — while goingCold.ts (which filters on 'open') disagreed
  // about the very same row. Métis said gone, Intelligence said still owed.
  const withRejected: BrainRead = {
    ...FIXTURE,
    deals: FIXTURE.deals.map((d, i) =>
      i === 0
        ? {
            ...d,
            commitments: [
              ...(d.commitments ?? []),
              { text: 'Never actually promised this', by: 'you', due_hint: '', quote: '', confidence: 'EXTRACTED', meeting: 'm2.md', date: '2026-02-02', status: 'rejected' }
            ]
          }
        : d
    ),
    people: FIXTURE.people.map((p, i) =>
      i === 0
        ? {
            ...p,
            commitments: [
              ...(p.commitments ?? []),
              { text: 'Misheard person promise', by: 'Jane Doe', due_hint: '', quote: '', meeting: 'm2.md', date: '2026-02-02', status: 'rejected' }
            ]
          }
        : p
    )
  }
  const adapted = brainToDashboard(withRejected)

  it('drops it from the deal ledger', () => {
    const texts = adapted.deals.flatMap((d) => d.commitments.map((c) => c.text))
    expect(texts).not.toContain('Never actually promised this')
    // The real rows on the same deal must survive — this is a filter, not a purge.
    expect(texts).toContain('Send updated SOW')
  })

  it('drops it from the person ledger', () => {
    const texts = adapted.people.flatMap((p) => p.commitments.map((c) => c.text))
    expect(texts).not.toContain('Misheard person promise')
    expect(texts).toContain('Loop in procurement')
  })

  it('never relabels it as open, which is how it used to come back', () => {
    const all = [
      ...adapted.deals.flatMap((d) => d.commitments),
      ...adapted.people.flatMap((p) => p.commitments)
    ]
    expect(all.filter((c) => c.status === 'open').map((c) => c.text)).not.toContain('Never actually promised this')
    // Same open count as the untouched fixture: adding a rejected row must move no number on the page.
    const baseline = [
      ...dashboard.deals.flatMap((d) => d.commitments),
      ...dashboard.people.flatMap((p) => p.commitments)
    ].filter((c) => c.status === 'open').length
    expect(all.filter((c) => c.status === 'open').length).toBe(baseline)
  })
})
