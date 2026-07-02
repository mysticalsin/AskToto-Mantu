import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Settings } from '@shared/ipc'
import { MeetingExtractionSchema, type MeetingExtraction } from '@shared/brain'
import { computeSilence } from '@shared/silence'
import { buildMarsWeek } from '@shared/mars'
import { ingestExtraction, settleCommitment } from './ingest'
import {
  slugify,
  readGraph,
  readAccount,
  readPerson,
  readDeal,
  writeDeal,
  listEntities,
  listMeetingExtractions,
  readMeetingExtraction,
  readIndex
} from './store'

vi.mock('electron')

/**
 * END-TO-END PROOF that the Intelligence numbers are real.
 *
 * A planted ground truth (8 meetings, 3 accounts, 3 people, 4 deals, 3 spoken commitments, one
 * going-dark account, one vanished champion, one dropped topic, one single-threaded deal, one
 * unmapped account, one won + one lost deal in the current week) is pushed through the REAL
 * pipeline — real mergeExtraction, real JSON files on a real temp disk, real store readers — and
 * then every number the dashboard derives (entity counts, graph, commitment ledger, Silence
 * Detector, Mars week) is asserted against what was planted. Nothing is mocked except Electron
 * itself. If any surface invented or lost a number, this file fails.
 *
 * The one nondeterministic step in production — the LLM extraction — is represented by fixture
 * extractions that are schema-validated exactly like live output; everything downstream runs for real.
 */

const NOW = new Date('2026-07-02T12:00:00Z').getTime()
const DAY = 24 * 60 * 60 * 1000
const iso = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString().slice(0, 10)

interface Fixture {
  file: string
  daysAgo: number
  x: MeetingExtraction
}

function fx(p: {
  file: string
  daysAgo: number
  account: { name: string; sector: 'banking' | 'retail' | 'technology' } | null
  title: string
  topics: string[]
  people?: { name: string; role?: string }[]
  deal?: { name: string; band?: 'good' | 'mixed' | 'concerning'; stage?: string }
  commitments?: { text: string; by: string; due_hint?: string }[]
  sentiment?: 'good' | 'mixed' | 'concerning'
}): Fixture {
  // Deliberately NO source_file / date here — production stamps provenance from the transcript's
  // frontmatter inside ingestExtraction. If stamping broke, every date-driven number below would fail.
  const x = MeetingExtractionSchema.parse({
    title24: p.title,
    topics: p.topics,
    sentiment: p.sentiment ?? 'mixed',
    account: p.account ? { name: p.account.name, sector: p.account.sector, confidence: 'EXTRACTED' } : null,
    people: (p.people ?? []).map((pp) => ({ name: pp.name, role: pp.role ?? null, org: null, confidence: 'EXTRACTED' })),
    deal: p.deal ? { name: p.deal.name, stage: p.deal.stage ?? 'open', win_likelihood_band: p.deal.band ?? null } : null,
    commitments: (p.commitments ?? []).map((c) => ({ ...c, quote: `"${c.text}"`, confidence: 'EXTRACTED' }))
  })
  return { file: p.file, daysAgo: p.daysAgo, x }
}

/** Minimal transcript markdown carrying the frontmatter production stamps provenance from. */
const transcriptMd = (daysAgo: number): string =>
  `---\ntype: meeting-transcript\nsource: AskToto\ndate: ${iso(daysAgo)}\n---\n\n## Full transcript\n\n**[10:00:00] Them:** hello\n`

// ── GROUND TRUTH ─────────────────────────────────────────────────────────────
// Acme (banking): 5 meetings. 'migration' discussed in the three old ones, gone recently (dropped
// topic). Claire Dubois present in the old three only (vanished champion). Two deals: Core Banking
// (open) and Add-on (later marked WON by human action, touched this week).
// Globex (retail): 2 meetings, both months old — went dark. One person (Maria) → its open Renewal
// deal is single-threaded. RFP deal later marked LOST (old — must NOT appear in this week's Mars).
// Initech (technology): first-ever meeting 2 days ago (first contact / new account), no people
// mapped (unexplored), its Pilot deal marked LOST this week.
const FIXTURES: Fixture[] = [
  fx({ file: 'acme-1.md', daysAgo: 90, account: { name: 'Acme', sector: 'banking' }, title: 'Migration kickoff', topics: ['migration', 'pricing'], people: [{ name: 'Claire Dubois', role: 'CFO' }, { name: 'Tom Reed' }], deal: { name: 'Acme Core Banking', band: 'mixed' } }),
  fx({ file: 'acme-2.md', daysAgo: 75, account: { name: 'Acme', sector: 'banking' }, title: 'Migration security', topics: ['migration', 'security'], people: [{ name: 'Claire Dubois' }], deal: { name: 'Acme Core Banking', band: 'mixed' } }),
  fx({ file: 'acme-3.md', daysAgo: 60, account: { name: 'Acme', sector: 'banking' }, title: 'Migration plan', topics: ['migration'], people: [{ name: 'Claire Dubois' }, { name: 'Tom Reed' }], deal: { name: 'Acme Core Banking', band: 'mixed' }, commitments: [{ text: 'intro AskToto to the CISO', by: 'Claire Dubois' }] }),
  fx({ file: 'acme-4.md', daysAgo: 3, account: { name: 'Acme', sector: 'banking' }, title: 'Pricing rollout', topics: ['pricing', 'rollout'], people: [{ name: 'Tom Reed' }], deal: { name: 'Acme Core Banking', band: 'good' }, commitments: [{ text: 'send the security pack', by: 'you', due_hint: 'by Friday' }] }),
  fx({ file: 'acme-5.md', daysAgo: 1, account: { name: 'Acme', sector: 'banking' }, title: 'Add-on close', topics: ['rollout'], people: [{ name: 'Tom Reed' }], deal: { name: 'Acme Add-on', band: 'good' }, sentiment: 'good' }),
  fx({ file: 'globex-1.md', daysAgo: 120, account: { name: 'Globex', sector: 'retail' }, title: 'RFP walkthrough', topics: ['rfp'], people: [{ name: 'Maria Silva' }], deal: { name: 'Globex RFP', band: 'mixed' } }),
  fx({ file: 'globex-2.md', daysAgo: 70, account: { name: 'Globex', sector: 'retail' }, title: 'Renewal terms', topics: ['rfp', 'renewal'], people: [{ name: 'Maria Silva' }], deal: { name: 'Globex Renewal', band: 'concerning' }, commitments: [{ text: 'send renewal terms', by: 'you' }], sentiment: 'concerning' }),
  fx({ file: 'initech-1.md', daysAgo: 2, account: { name: 'Initech', sector: 'technology' }, title: 'Pilot debrief', topics: ['pilot'], deal: { name: 'Initech Pilot', band: 'concerning' }, sentiment: 'concerning' })
]

// Both storage modes run the identical planted world: the numbers must be indistinguishable whether
// the brain files sit plaintext or inside the ATKENC envelope (encryptTranscripts on).
describe.each([
  ['plaintext', false],
  ['encrypted-at-rest', true]
])('END-TO-END PROOF (%s): planted ground truth → real pipeline → every dashboard number', (_mode, encrypt) => {
  let folder: string
  let s: Settings
  let extractions: MeetingExtraction[]

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-e2e-proof-'))
    s = { meetingsFolder: folder, encryptTranscripts: encrypt } as Settings

    // The EXACT production ingest path (ingestExtraction = processJob minus the LLM call):
    // provenance stamping from transcript frontmatter, extraction persist, entity merge, ingest-log
    // index write, lint refresh. Deep-clone fixtures so the two storage modes can't contaminate each other.
    for (const f of FIXTURES) {
      const x = MeetingExtractionSchema.parse(JSON.parse(JSON.stringify(f.x)))
      await ingestExtraction(s, x, transcriptMd(f.daysAgo), join(folder, f.file))
    }

    // Human actions (the only way outcomes/settlements ever move — never the LLM):
    const addon = readDeal(s, slugify('Acme Add-on'))!
    addon.outcome = 'won'
    await writeDeal(s, slugify('Acme Add-on'), addon)
    const pilot = readDeal(s, slugify('Initech Pilot'))!
    pilot.outcome = 'lost'
    await writeDeal(s, slugify('Initech Pilot'), pilot)
    const rfp = readDeal(s, slugify('Globex RFP'))!
    rfp.outcome = 'lost' // lost long ago — must NOT count in this week's Mars
    await writeDeal(s, slugify('Globex RFP'), rfp)
    // Claire delivered her intro — settled through the real settlement path (deal + person mirror).
    const settled = await settleCommitment(s, slugify('Acme Core Banking'), 'intro AskToto to the CISO', 'kept')
    if (!settled.ok) throw new Error(settled.error)

    // Read everything back OFF DISK through the real readers (what IPC brain:read serves).
    extractions = listMeetingExtractions(s)
      .map((slug) => readMeetingExtraction(s, slug))
      .filter((x): x is MeetingExtraction => !!x)
  })
  afterAll(() => rmSync(folder, { recursive: true, force: true }))

  it('the UI headline "meetings ingested" number — the ingest-log index — records all 8, ok, stamped', () => {
    const idx = readIndex(s)
    const entries = Object.entries(idx.ingested)
    expect(entries).toHaveLength(8) // BrainView's headline stat counts exactly these
    expect(entries.every(([, v]) => v.ok)).toBe(true)
    // Production stamping proven: the fixtures carried NO date/source — the frontmatter did.
    const acme4 = readMeetingExtraction(s, slugify('acme-4.md'))!
    expect(acme4.source_file).toBe('acme-4.md')
    expect(acme4.date).toBe(iso(3))
  })

  it('entity counts match the planted world exactly', () => {
    expect(listEntities(s, 'account').sort()).toEqual(['acme', 'globex', 'initech'])
    expect(listEntities(s, 'person').sort()).toEqual(['claire-dubois', 'maria-silva', 'tom-reed'])
    expect(listEntities(s, 'deal').sort()).toEqual(['acme-add-on', 'acme-core-banking', 'globex-renewal', 'globex-rfp', 'initech-pilot'])
    expect(extractions).toHaveLength(8)
  })

  it('entities compound per meeting — meeting refs count exactly', () => {
    expect(readAccount(s, 'acme')!.meetings).toHaveLength(5)
    expect(readAccount(s, 'globex')!.meetings).toHaveLength(2)
    expect(readAccount(s, 'initech')!.meetings).toHaveLength(1)
    expect(readPerson(s, 'claire-dubois')!.meetings.map((m) => m.file).sort()).toEqual(['acme-1.md', 'acme-2.md', 'acme-3.md'])
    expect(readPerson(s, 'tom-reed')!.meetings.map((m) => m.file).sort()).toEqual(['acme-1.md', 'acme-3.md', 'acme-4.md', 'acme-5.md'])
    expect(readDeal(s, 'acme-core-banking')!.meetings).toHaveLength(4)
  })

  it('graph carries exactly the planted structure', () => {
    const g = readGraph(s)
    const byType = (t: string): number => g.nodes.filter((n) => n.type === t).length
    expect(byType('account')).toBe(3)
    expect(byType('person')).toBe(3)
    expect(byType('deal')).toBe(5)
    expect(byType('sector')).toBe(3) // banking, retail, technology
    expect(byType('meeting')).toBe(8) // one node per ingested meeting (display layers drop these)
    const edgeKeys = g.edges.map((e) => `${e.from}|${e.to}|${e.rel}`)
    expect(new Set(edgeKeys).size).toBe(edgeKeys.length) // zero duplicate edges after 8 merges
    expect(g.edges.some((e) => e.from === 'person:claire-dubois' && e.rel === 'works-at')).toBe(true)
  })

  it('commitment ledger: 3 spoken promises, 2 still open, 1 settled by human action', () => {
    const core = readDeal(s, 'acme-core-banking')!
    expect(core.commitments).toHaveLength(2)
    expect(core.commitments.filter((c) => c.status === 'open').map((c) => c.text)).toEqual(['send the security pack'])
    expect(core.commitments.filter((c) => c.status === 'kept')).toHaveLength(1)
    const renewal = readDeal(s, 'globex-renewal')!
    expect(renewal.commitments.filter((c) => c.status === 'open').map((c) => c.text)).toEqual(['send renewal terms'])
    // The named person's own ledger caught her spoken promise — and settlement mirrored onto it,
    // so the per-person kept-promise reliability read (kept 1/1) is computable from real data.
    const claire = readPerson(s, 'claire-dubois')!
    expect(claire.commitments.map((c) => ({ text: c.text, status: c.status }))).toEqual([
      { text: 'intro AskToto to the CISO', status: 'kept' }
    ])
  })


  it('Silence Detector finds exactly the planted decay — and nothing else', () => {
    const silence = computeSilence(extractions, NOW)
    expect(silence.map((x) => x.account)).toEqual(['Globex', 'Acme']) // dark first, Initech too young to judge

    const globex = silence[0]
    expect(globex.wentDark).toBe(true)
    expect(globex.daysQuiet).toBe(70)
    // Exact list, exact persistence counts — an invented extra topic or count would fail here.
    expect(globex.droppedTopics).toEqual([
      { topic: 'rfp', priorMentions: 2 },
      { topic: 'renewal', priorMentions: 1 }
    ])
    expect(globex.vanishedPeople).toEqual(['Maria Silva'])

    const acme = silence[1]
    expect(acme.wentDark).toBe(false)
    expect(acme.cooling).toBe(false) // recent sentiment did not fall vs prior — must not cry wolf
    expect(acme.droppedTopics).toEqual([
      { topic: 'migration', priorMentions: 3 }, // 3 old meetings raised it
      { topic: 'security', priorMentions: 1 }
    ]) // 'pricing' correctly absent — still live 3 days ago
    expect(acme.vanishedPeople).toEqual(['Claire Dubois'])
    expect(acme.daysQuiet).toBe(1)
  })

  it('Mars week reports exactly this week: 3 meetings, 1 new account, 1 won, 1 lost, 2 follow-ups, 1 at-risk', () => {
    const deals = listEntities(s, 'deal').map((d) => readDeal(s, d)!)
    const mars = buildMarsWeek(extractions, deals, NOW)

    expect(mars.meetings).toHaveLength(3) // acme-4 (d-3), initech-1 (d-2), acme-5 (d-1)
    expect(mars.meetings.map((m) => m.title)).toEqual(['Pricing rollout', 'Pilot debrief', 'Add-on close'])
    expect(mars.newAccounts).toEqual(['Initech']) // Acme is old; only Initech's FIRST meeting is this week
    expect(mars.meetings.find((m) => m.account === 'Initech')!.firstContact).toBe(true)
    expect(mars.meetings.filter((m) => m.firstContact)).toHaveLength(1)

    expect(mars.won).toEqual([{ name: 'Acme Add-on', account: 'Acme' }])
    expect(mars.lost).toEqual([{ name: 'Initech Pilot', account: 'Initech' }]) // Globex RFP lost months ago — correctly absent

    expect(mars.openFollowups.map((f) => f.text).sort()).toEqual(['send renewal terms', 'send the security pack'])
    expect(mars.atRisk.map((d) => d.name)).toEqual(['Globex Renewal']) // concerning + open; lost deals excluded
  })

  it('PROOF TABLE — every number above, printed from the real store', () => {
    const deals = listEntities(s, 'deal').map((d) => readDeal(s, d)!)
    const mars = buildMarsWeek(extractions, deals, NOW)
    const silence = computeSilence(extractions, NOW)
    const g = readGraph(s)
    const rows = [
      ['meetings ingested', 8, extractions.length],
      ['accounts', 3, listEntities(s, 'account').length],
      ['people', 3, listEntities(s, 'person').length],
      ['deals', 5, listEntities(s, 'deal').length],
      ['graph nodes', 22, g.nodes.length], // 3 accounts + 3 people + 5 deals + 3 sectors + 8 meetings
      ['graph duplicate edges', 0, g.edges.length - new Set(g.edges.map((e) => `${e.from}|${e.to}|${e.rel}`)).size],
      ['open commitments', 2, deals.flatMap((d) => d.commitments).filter((c) => c.status === 'open').length],
      ['kept commitments', 1, deals.flatMap((d) => d.commitments).filter((c) => c.status === 'kept').length],
      ['silence signals', 2, silence.length],
      ['dark accounts', 1, silence.filter((x) => x.wentDark).length],
      ['Mars meetings this week', 3, mars.meetings.length],
      ['Mars new accounts', 1, mars.newAccounts.length],
      ['Mars won', 1, mars.won.length],
      ['Mars lost', 1, mars.lost.length],
      ['Mars open follow-ups', 2, mars.openFollowups.length],
      ['Mars at-risk', 1, mars.atRisk.length]
    ] as const
    // eslint-disable-next-line no-console
    console.log('\nPROOF OF NUMBERS — planted ground truth vs computed from the real on-disk store')
    for (const [label, planted, computed] of rows) {
      // eslint-disable-next-line no-console
      console.log(`  ${String(label).padEnd(26)} planted=${String(planted).padEnd(4)} computed=${computed}`)
      expect(computed).toBe(planted)
    }
  })

  // LAST on purpose: this ingests a 9th meeting, mutating the world the tests above pinned.
  it('a re-spoken promise stays ONE ledger row, aging from when it was first made', async () => {
    // Same promise text extracted again from a newer meeting — the classic double-count trap.
    const again = MeetingExtractionSchema.parse({
      title24: 'Terms follow-up',
      topics: ['renewal'],
      account: { name: 'Globex', sector: 'retail', confidence: 'EXTRACTED' },
      deal: { name: 'Globex Renewal', stage: 'open' },
      commitments: [{ text: 'send renewal terms', by: 'you', quote: 'again: I will send renewal terms', confidence: 'EXTRACTED' }]
    })
    await ingestExtraction(s, again, transcriptMd(0), join(folder, 'globex-3.md'))
    const renewal = readDeal(s, 'globex-renewal')!
    const rows = renewal.commitments.filter((c) => c.text === 'send renewal terms')
    expect(rows).toHaveLength(1) // one obligation, not two
    expect(rows[0].date).toBe(iso(70)) // aging anchored to the FIRST time it was promised
  })
})
