import { describe, it, expect } from 'vitest'
import { MeetingExtractionSchema, DealEntitySchema, type MeetingExtraction, type DealEntity } from './brain'
import { buildMarsWeek, renderMarsMarkdown } from './mars'

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-07-02T17:00:00Z').getTime() // a Thursday
const iso = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString().slice(0, 10)

const meeting = (p: {
  daysAgo: number
  title?: string
  account?: string | null
  stage?: string
  band?: 'good' | 'mixed' | 'concerning' | null
}): MeetingExtraction =>
  MeetingExtractionSchema.parse({
    title24: p.title ?? 'Untitled sync',
    date: iso(p.daysAgo),
    source_file: `${iso(p.daysAgo)}.md`,
    sentiment: 'mixed',
    account: p.account === null ? null : { name: p.account ?? 'Acme', sector: 'banking' },
    deal: p.stage ? { name: `${p.account ?? 'Acme'} deal`, stage: p.stage, win_likelihood_band: p.band ?? null } : null
  })

const deal = (p: Partial<DealEntity>): DealEntity => DealEntitySchema.parse({ name: 'D', ...p })

describe('buildMarsWeek', () => {
  it('lists only the last 7 days of meetings, ordered by date', () => {
    const w = buildMarsWeek(
      [meeting({ daysAgo: 9, title: 'too old' }), meeting({ daysAgo: 3, title: 'mid week' }), meeting({ daysAgo: 0, title: 'today' })],
      [],
      NOW
    )
    expect(w.meetings.map((m) => m.title)).toEqual(['mid week', 'today'])
    expect(w.weekStart).toBe(iso(6))
    expect(w.weekEnd).toBe(iso(0))
  })

  it('flags first-contact accounts only when their first EVER meeting is inside the week', () => {
    const w = buildMarsWeek(
      [
        meeting({ daysAgo: 30, account: 'OldClient' }),
        meeting({ daysAgo: 2, account: 'OldClient' }), // returning — not new
        meeting({ daysAgo: 1, account: 'BrandNew' }) // genuinely new
      ],
      [],
      NOW
    )
    expect(w.newAccounts).toEqual(['BrandNew'])
    expect(w.meetings.find((m) => m.account === 'OldClient' && m.date === iso(2))?.firstContact).toBe(false)
  })

  it('won/lost report human-set outcomes only, and only for deals touched this week', () => {
    const deals = [
      deal({ name: 'WonNow', outcome: 'won', meetings: [{ file: 'a.md', date: iso(1), title: '' }] }),
      deal({ name: 'WonAges', outcome: 'won', meetings: [{ file: 'b.md', date: iso(40), title: '' }] }),
      deal({ name: 'LostNow', outcome: 'lost', meetings: [{ file: 'c.md', date: iso(3), title: '' }] }),
      deal({ name: 'StillOpen', outcome: 'open', meetings: [{ file: 'd.md', date: iso(1), title: '' }] })
    ]
    const w = buildMarsWeek([], deals, NOW)
    expect(w.won.map((d) => d.name)).toEqual(['WonNow'])
    expect(w.lost.map((d) => d.name)).toEqual(['LostNow'])
  })

  it('open follow-ups come from the commitment ledger, oldest first; at-risk = concerning open deals', () => {
    const deals = [
      deal({
        name: 'BigDeal',
        outcome: 'open',
        win_likelihood_band: 'concerning',
        band_evidence: 'budget freeze mentioned twice',
        commitments: [
          { text: 'send security docs', by: 'you', due_hint: 'by Friday', quote: '', confidence: 'EXTRACTED', meeting: 'm.md', date: iso(2), status: 'open' },
          { text: 'intro to CTO', by: 'them', due_hint: '', quote: '', confidence: 'EXTRACTED', meeting: 'n.md', date: iso(9), status: 'open' },
          { text: 'already done', by: 'you', due_hint: '', quote: '', confidence: 'EXTRACTED', meeting: 'o.md', date: iso(1), status: 'kept' }
        ]
      })
    ]
    const w = buildMarsWeek([], deals, NOW)
    expect(w.openFollowups.map((f) => f.text)).toEqual(['intro to CTO', 'send security docs']) // oldest first, kept excluded
    expect(w.atRisk).toEqual([{ name: 'BigDeal', account: '', evidence: 'budget freeze mentioned twice' }])
  })

  it('accountless (internal) meetings are listed but never counted as new accounts', () => {
    const w = buildMarsWeek([meeting({ daysAgo: 1, account: null, title: 'internal standup' })], [], NOW)
    expect(w.meetings).toHaveLength(1)
    expect(w.meetings[0].account).toBe('')
    expect(w.newAccounts).toEqual([])
  })
})

describe('renderMarsMarkdown', () => {
  it('renders a paste-ready draft with honest empty sections', () => {
    const md = renderMarsMarkdown(buildMarsWeek([meeting({ daysAgo: 1, account: 'Acme', stage: 'proposal', band: 'good' })], [], NOW))
    expect(md).toContain('# Mars week draft')
    expect(md).toContain('## Meetings this week (1)')
    expect(md).toContain('stage: proposal')
    expect(md).toContain('none marked won this week') // absence stated, never invented
    expect(md).toContain('the Mars bucket (prospection / cold call / QM) is yours to confirm')
  })
})
