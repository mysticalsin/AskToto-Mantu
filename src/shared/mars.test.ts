import { describe, it, expect, afterEach } from 'vitest'
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

/**
 * MQA-195 — the Mars draft must date meetings by the LOCAL calendar day, exactly as History does
 * (RecallView.localDateKey). Meeting frontmatter carries a full ISO instant, so truncating it to
 * 10 characters yields the UTC day: west of UTC every evening meeting is reported on the following
 * day, and the 7-day window slides with it — dropping a Saturday-morning meeting out of the week and
 * claiming a range that runs into tomorrow.
 *
 * TZ is pinned rather than trusted from the host (Node/V8 re-resolve process.env.TZ on every Date
 * call), so the reproduction is deterministic wherever the suite runs.
 */
describe('MQA-195 — Mars week is bucketed by the local calendar day', () => {
  const ORIGINAL_TZ = process.env.TZ
  // Fri 2026-08-14 19:00 PDT — the user's Friday evening, already Saturday in UTC.
  const FRIDAY_EVENING = new Date('2026-08-15T02:00:00.000Z').getTime()

  const extraction = (date: string, title: string, account: string | null = 'Acme'): MeetingExtraction =>
    MeetingExtractionSchema.parse({
      title24: title,
      date,
      source_file: `${title}.md`,
      sentiment: 'mixed',
      account: account === null ? null : { name: account, sector: 'banking' }
    })

  afterEach(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ
    else process.env.TZ = ORIGINAL_TZ
  })

  it('MQA-195: an evening meeting is reported on the day the user held it, and the window covers the local week', () => {
    process.env.TZ = 'America/Los_Angeles'
    const w = buildMarsWeek(
      [
        extraction('2026-08-08T16:00:00.000Z', 'saturday morning', 'NewCo'), // Sat 2026-08-08 09:00 PDT
        extraction('2026-08-10', 'monday note'), // bare frontmatter date — a calendar day, no instant
        extraction('2026-08-13T01:15:00.000Z', 'wednesday evening'), // Wed 2026-08-12 18:15 PDT
        extraction('2026-08-15T02:00:00.000Z', 'friday evening'), // Fri 2026-08-14 19:00 PDT
        extraction('2026-08-08T04:00:00.000Z', 'last friday night') // Fri 2026-08-07 21:00 PDT — previous week
      ],
      [],
      FRIDAY_EVENING
    )

    expect(w.weekStart).toBe('2026-08-08')
    expect(w.weekEnd).toBe('2026-08-14') // never a day the user has not lived yet
    expect(w.meetings.map((m) => [m.title, m.date])).toEqual([
      ['saturday morning', '2026-08-08'],
      ['monday note', '2026-08-10'], // a bare date is already a calendar day — never shifted by a zone
      ['wednesday evening', '2026-08-12'],
      ['friday evening', '2026-08-14']
    ])
    expect(w.newAccounts).toContain('NewCo')

    const md = renderMarsMarkdown(w)
    expect(md).toContain('# Mars week draft: 2026-08-08 → 2026-08-14')
    expect(md).toContain('- 2026-08-12: wednesday evening')
  })

  it('MQA-195: a deal touched on a local in-week day counts, and an unparseable meeting date is ignored', () => {
    process.env.TZ = 'America/Los_Angeles'
    const deals = [
      deal({ name: 'SatDeal', outcome: 'won', meetings: [{ file: 'a.md', date: '2026-08-08T16:00:00.000Z', title: '' }] }),
      deal({ name: 'LastWeekDeal', outcome: 'won', meetings: [{ file: 'b.md', date: '2026-08-08T04:00:00.000Z', title: '' }] }),
      deal({ name: 'GarbageDate', outcome: 'won', meetings: [{ file: 'c.md', date: 'not a date', title: '' }] })
    ]
    const w = buildMarsWeek([], deals, FRIDAY_EVENING)
    expect(w.won.map((d) => d.name)).toEqual(['SatDeal'])
  })
})
