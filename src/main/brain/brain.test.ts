import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Settings } from '@shared/ipc'
import { MeetingExtractionSchema, type MeetingExtraction } from '@shared/brain'
import { extractJsonObject, mergeExtraction, lintBrain } from './ingest'
import { buildBrainContext } from './context'
import {
  brainDir,
  slugify,
  readGraph,
  readAccount,
  readPerson,
  readDeal,
  writeDeal,
  readIndex,
  writeIndex,
  listEntities,
  purgeBrain
} from './store'

vi.mock('electron')

const settingsFor = (folder: string): Settings => ({ meetingsFolder: folder } as Settings)

describe('brain', () => {
  let folder: string
  let s: Settings

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-brain-test-'))
    s = settingsFor(folder)
  })
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

  const sampleExtraction = (): MeetingExtraction =>
    MeetingExtractionSchema.parse({
      title24: 'LATAM SAP pricing defense',
      topics: ['pricing', 'SAP'],
      sentiment: 'mixed',
      account: { name: "L'Oréal", sector: 'consumer-goods', sector_confidence: 'INFERRED', confidence: 'EXTRACTED' },
      people: [{ name: 'Maria Silva', role: 'Procurement lead', org: null, confidence: 'EXTRACTED' }],
      deal: {
        name: 'LATAM SAP AMS',
        stage: 'defense',
        win_likelihood_band: 'mixed',
        band_evidence: 'price pressure but strong relationship',
        velocity: { signal: 'hard-calendar-gate', evidence: 'go/no-go week of June 15' }
      },
      signals: [
        { kind: 'objection', statement: 'Price is above competitors', quote: 'the price isn’t competitive', confidence: 'EXTRACTED' },
        { kind: 'positive', statement: 'Happy with delivery team', quote: '', confidence: 'INFERRED' }
      ],
      missed_signals: [{ statement: 'Did not probe the competitor bid details', why_it_matters: 'unknown pricing anchor' }],
      feedback: ['Ask sharper discovery questions on budget']
    })

  describe('extractJsonObject', () => {
    it('passes through a bare JSON object', () => {
      expect(JSON.parse(extractJsonObject('{"a":1}'))).toEqual({ a: 1 })
    })
    it('strips markdown fences and surrounding prose', () => {
      const raw = 'Sure! Here is the JSON:\n```json\n{"a": {"b": 2}}\n```\nHope that helps.'
      expect(JSON.parse(extractJsonObject(raw))).toEqual({ a: { b: 2 } })
    })
    it('recovers the outermost object from leading/trailing junk without fences', () => {
      expect(JSON.parse(extractJsonObject('noise {"x":[1,2]} trailing'))).toEqual({ x: [1, 2] })
    })
    it('throws when there is no JSON object at all', () => {
      expect(() => extractJsonObject('no json here')).toThrow()
    })
  })

  describe('mergeExtraction', () => {
    it('creates account/person/deal entities, graph nodes+edges, and buckets signals into win/loss reasons', async () => {
      const ref = { file: 'm1.md', date: '2026-07-01', title: 'LATAM SAP pricing defense' }
      await mergeExtraction(s, sampleExtraction(), ref)

      const acc = readAccount(s, slugify("L'Oréal"))
      expect(acc).not.toBeNull()
      expect(acc!.sector).toBe('consumer-goods')
      expect(acc!.people).toContain('Maria Silva')
      expect(acc!.loss_reasons.some((r) => r.statement.includes('above competitors'))).toBe(true)
      expect(acc!.win_reasons.some((r) => r.statement.includes('delivery team'))).toBe(true)

      const person = readPerson(s, slugify('Maria Silva'))
      expect(person?.account).toBe("L'Oréal")
      expect(person?.meetings.map((m) => m.file)).toContain('m1.md')

      const deal = readDeal(s, slugify('LATAM SAP AMS'))
      expect(deal?.win_likelihood_band).toBe('mixed')
      expect(deal?.velocity.signal).toBe('hard-calendar-gate')
      expect(deal?.missed_signals).toHaveLength(1)
      expect(deal?.feedback[0].note).toContain('discovery questions')

      const graph = readGraph(s)
      const ids = graph.nodes.map((n) => n.id)
      expect(ids).toContain(`account:${slugify("L'Oréal")}`)
      expect(ids).toContain('sector:consumer-goods')
      expect(ids).toContain(`person:${slugify('Maria Silva')}`)
      expect(graph.edges.some((e) => e.rel === 'in-sector')).toBe(true)
      expect(graph.edges.some((e) => e.rel === 'works-at' && e.confidence === 'INFERRED')).toBe(true)
    })

    it('is idempotent — re-merging the same meeting does not duplicate entries', async () => {
      const ref = { file: 'm1.md', date: '2026-07-01', title: 't' }
      await mergeExtraction(s, sampleExtraction(), ref)
      await mergeExtraction(s, sampleExtraction(), ref)
      const acc = readAccount(s, slugify("L'Oréal"))!
      expect(acc.meetings).toHaveLength(1)
      expect(acc.loss_reasons).toHaveLength(1)
      const graph = readGraph(s)
      const edgeKeys = graph.edges.map((e) => `${e.from}|${e.to}|${e.rel}`)
      expect(new Set(edgeKeys).size).toBe(edgeKeys.length)
    })

    it('a second meeting compounds onto existing entities instead of overwriting them', async () => {
      await mergeExtraction(s, sampleExtraction(), { file: 'm1.md', date: '', title: 't1' })
      const second = sampleExtraction()
      second.signals = [{ kind: 'positive', statement: 'Budget approved', quote: 'finance signed off', confidence: 'EXTRACTED' }]
      second.deal!.win_likelihood_band = 'good'
      await mergeExtraction(s, second, { file: 'm2.md', date: '', title: 't2' })
      const acc = readAccount(s, slugify("L'Oréal"))!
      expect(acc.meetings).toHaveLength(2)
      expect(acc.win_reasons.length).toBeGreaterThanOrEqual(2)
      const deal = readDeal(s, slugify('LATAM SAP AMS'))!
      expect(deal.win_likelihood_band).toBe('good') // freshest meeting's judgement wins
      expect(deal.meetings).toHaveLength(2)
    })

    it('personal chats (account=null, deal=null) create no account/deal entities', async () => {
      const x = sampleExtraction()
      x.account = null
      x.deal = null
      x.people = []
      await mergeExtraction(s, x, { file: 'chat.md', date: '', title: 'chat' })
      expect(listEntities(s, 'account')).toHaveLength(0)
      expect(listEntities(s, 'deal')).toHaveLength(0)
    })
  })

  describe('buildBrainContext (Receipt Mode)', () => {
    it('returns the relevant, meeting-cited slice when the question names a known entity', async () => {
      const x = sampleExtraction()
      x.commitments = [
        { text: 'send the ROI deck', by: 'Maria Silva', due_hint: 'by Friday', quote: "I'll get you the ROI deck", confidence: 'EXTRACTED' }
      ]
      await mergeExtraction(s, x, { file: 'm1.md', date: '2026-06-14', title: 'LATAM SAP pricing defense' })

      const { block, matched } = buildBrainContext(s, 'what did Maria Silva promise on pricing?')
      expect(matched).toBe(true)
      expect(block).toContain('Maria Silva')
      expect(block).toContain('LATAM SAP pricing defense') // the source-meeting citation
      expect(block).toContain('2026-06-14')
      expect(block).toContain('ROI deck') // her open commitment, carried with its citation
    })

    it('matches an account and a deal named in the question', async () => {
      await mergeExtraction(s, sampleExtraction(), { file: 'm1.md', date: '2026-06-14', title: 't' })
      const acc = buildBrainContext(s, "how is the L'Oréal relationship going?")
      expect(acc.matched).toBe(true)
      expect(acc.block).toContain("L'Oréal")

      const deal = buildBrainContext(s, 'give me the state of the LATAM SAP AMS deal')
      expect(deal.matched).toBe(true)
      expect(deal.block.toLowerCase()).toContain('latam sap ams')
    })

    it('returns nothing when the question names no known entity (drives the "not in your meetings" line)', async () => {
      await mergeExtraction(s, sampleExtraction(), { file: 'm1.md', date: '', title: 't' })
      const { block, matched } = buildBrainContext(s, 'what do you know about Globex Corporation?')
      expect(matched).toBe(false)
      expect(block).toBe('')
    })

    it('does not false-match a known entity name as a substring of an unrelated word', async () => {
      // A person slugged "sap" must not match the word "disappear"; whole-token boundaries only.
      const x = sampleExtraction()
      x.people = [{ name: 'Sap', role: null, org: null, confidence: 'EXTRACTED' }]
      x.account = null
      x.deal = null
      await mergeExtraction(s, x, { file: 'm1.md', date: '', title: 't' })
      expect(buildBrainContext(s, 'the concerns seem to disappear over time').matched).toBe(false)
    })
  })

  describe('lintBrain', () => {
    it('flags a closed deal that still carries a live band', async () => {
      await mergeExtraction(s, sampleExtraction(), { file: 'm1.md', date: '', title: 't' })
      const dslug = slugify('LATAM SAP AMS')
      const deal = readDeal(s, dslug)!
      deal.outcome = 'won'
      await writeDeal(s, dslug, deal)
      const warnings = lintBrain(s)
      expect(warnings.some((w) => w.includes('won') && w.includes('win-likelihood'))).toBe(true)
    })
  })

  it('store writes plaintext JSON when encryption is off and index round-trips', async () => {
    const idx = readIndex(s)
    idx.ingested['m1.md'] = { at: 123, ok: true }
    await writeIndex(s, idx)
    const onDisk = readFileSync(join(brainDir(s), 'index.json'), 'utf8')
    expect(onDisk).toContain('"m1.md"') // plaintext when encryptTranscripts is falsy
    expect(readIndex(s).ingested['m1.md'].ok).toBe(true)
  })

  it('purgeBrain erases the whole .brain store — entities, graph, and index (delete-all-data)', async () => {
    await mergeExtraction(s, sampleExtraction(), { file: 'm1.md', date: '2026-07-01', title: 't' })
    expect(existsSync(brainDir(s))).toBe(true)
    expect(listEntities(s, 'person').length).toBeGreaterThan(0)

    const r = purgeBrain(s)
    expect(r.ok).toBe(true)
    expect(existsSync(brainDir(s))).toBe(false) // nothing left on disk — no lingering quotes/entities
    expect(listEntities(s, 'person')).toHaveLength(0)
  })

  it('purgeBrain is a no-op that succeeds when no brain has been built yet', () => {
    expect(existsSync(brainDir(s))).toBe(false)
    expect(purgeBrain(s).ok).toBe(true)
  })

  it('store encrypts brain files at rest when encryptTranscripts is on', async () => {
    const enc = { ...s, encryptTranscripts: true } as Settings
    const idx = readIndex(enc)
    idx.ingested['secret-meeting.md'] = { at: 1, ok: true }
    await writeIndex(enc, idx)
    const raw = readFileSync(join(brainDir(enc), 'index.json'))
    expect(raw.subarray(0, 8).toString('utf8')).toBe('ATKENC2\n')
    expect(raw.toString('utf8')).not.toContain('secret-meeting')
    expect(readIndex(enc).ingested['secret-meeting.md'].ok).toBe(true) // decrypts transparently on read
  })
})
