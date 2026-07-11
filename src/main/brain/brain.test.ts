import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Settings } from '@shared/ipc'
import { MeetingExtractionSchema, BRAIN_EXTRACTION_PROMPT, type MeetingExtraction } from '@shared/brain'
import { INJECTION_GUARD } from '@shared/prompts'
import {
  extractJsonObject,
  mergeExtraction,
  lintBrain,
  commitmentKey,
  buildExtractionSystem,
  updateIndex,
  readMeetingSourceMode
} from './ingest'
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

  describe('readMeetingSourceMode', () => {
    it('reads only a bounded mode from the leading frontmatter block', () => {
      expect(readMeetingSourceMode('---\nmode: "meeting"\n---\n\nmode: "interview"')).toBe('meeting')
      expect(readMeetingSourceMode("---\r\nmode: 'interview'\r\n---\r\n")).toBe('interview')
    })

    it('rejects body-only, malformed, empty, and oversized mode values', () => {
      expect(readMeetingSourceMode('mode: "sales"')).toBe('')
      expect(readMeetingSourceMode('---\nmode: "sales"\nno closing delimiter')).toBe('')
      expect(readMeetingSourceMode('---\nmode: ""\n---\n')).toBe('')
      expect(readMeetingSourceMode(`---\nmode: "${'x'.repeat(101)}"\n---\n`)).toBe('')
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

  describe('slugify — non-Latin / emoji names', () => {
    it('two different non-Latin names never collapse to the same slug (no cross-entity merge)', () => {
      const beijing = slugify('北京公司')
      const moscow = slugify('Москва Банк')
      expect(beijing).not.toBe('unknown')
      expect(moscow).not.toBe('unknown')
      expect(beijing).not.toBe(moscow)
    })

    it('the same non-Latin name always produces the same slug (deterministic across calls)', () => {
      expect(slugify('北京公司')).toBe(slugify('北京公司'))
      expect(slugify('🎉🎊')).toBe(slugify('🎉🎊'))
    })

    it('falls back to a stable x-<hash> form, distinct from the ASCII slug path', () => {
      expect(slugify('北京公司')).toMatch(/^x-[0-9a-f]{8}$/)
      // Existing ASCII/diacritic behavior is untouched — no accidental regression on real slugs.
      expect(slugify("L'Oréal")).toBe('l-oreal')
    })

    it('two Chinese-named accounts stay fully separate through the real merge pipeline', async () => {
      const beijing = sampleExtraction()
      beijing.account = { name: '北京公司', sector: 'technology', sector_confidence: 'INFERRED', confidence: 'EXTRACTED' }
      beijing.deal = null
      beijing.people = []
      const shanghai = sampleExtraction()
      shanghai.account = { name: '上海银行', sector: 'banking', sector_confidence: 'INFERRED', confidence: 'EXTRACTED' }
      shanghai.deal = null
      shanghai.people = []

      await mergeExtraction(s, beijing, { file: 'b1.md', date: '', title: 't' })
      await mergeExtraction(s, shanghai, { file: 's1.md', date: '', title: 't' })

      const accounts = listEntities(s, 'account')
      expect(accounts).toHaveLength(2) // NOT merged into a single 'unknown'
      expect(accounts).not.toContain('unknown')
      const names = accounts.map((slug) => readAccount(s, slug)!.name).sort()
      expect(names).toEqual(['上海银行', '北京公司'])
    })
  })

  describe('slugify — Windows reserved device names', () => {
    it('a name that slugifies to a bare reserved word gets a disambiguating suffix', () => {
      expect(slugify('Aux')).toBe('aux-x')
      expect(slugify('CON')).toBe('con-x')
      expect(slugify('com1')).toBe('com1-x')
      expect(slugify('lpt9')).toBe('lpt9-x')
    })

    it('is stable across calls (deterministic, not a random suffix)', () => {
      expect(slugify('aux')).toBe(slugify('aux'))
    })

    it('does not over-trigger on names that merely contain a reserved word', () => {
      expect(slugify('Auxiliary Systems')).toBe('auxiliary-systems')
      expect(slugify('Contoso')).toBe('contoso')
    })
  })

  describe('commitmentKey', () => {
    it('trailing punctuation does not create a duplicate obligation', () => {
      expect(commitmentKey('Send the deck.')).toBe(commitmentKey('send the deck'))
      expect(commitmentKey('Send the deck!')).toBe(commitmentKey('send the deck'))
      expect(commitmentKey('Send the deck…')).toBe(commitmentKey('send the deck'))
    })

    it('NFKC-equivalent (composed vs decomposed) text produces the same key', () => {
      const composed = 'résumé' // résumé, single precomposed é
      const decomposed = 'résumé' // résumé, e + combining acute accent
      expect(commitmentKey(composed)).toBe(commitmentKey(decomposed))
    })

    it('still case-folds and collapses whitespace as before', () => {
      expect(commitmentKey('  Send   the DECK  ')).toBe('send the deck')
    })
  })

  describe('buildExtractionSystem (injection guard)', () => {
    it('leads with the injection guard, ahead of the extraction prompt', () => {
      const system = buildExtractionSystem()
      const guardStart = system.indexOf(INJECTION_GUARD.trim())
      const promptStart = system.indexOf(BRAIN_EXTRACTION_PROMPT)
      expect(guardStart).toBe(0) // the guard is the very first thing the model reads
      expect(promptStart).toBeGreaterThan(guardStart)
    })

    it('preserves the extraction prompt verbatim, including its trailing instruction', () => {
      const system = buildExtractionSystem()
      expect(system).toContain('Reply with the JSON object only.')
      expect(system.endsWith('Reply with the JSON object only.')).toBe(true)
    })

    it('appends the retry reinforcement text after the base prompt, guard still leading', () => {
      const extra = '\n\nREMINDER: your ENTIRE reply must be one valid JSON object. No fences, no prose.'
      const system = buildExtractionSystem(extra)
      expect(system.indexOf(INJECTION_GUARD.trim())).toBe(0)
      expect(system.endsWith(extra.trim())).toBe(true)
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

  it('updateIndex serializes concurrent mutations — no lost writes (production bug: idx.ingested went empty despite every extraction succeeding, because index.json has several independent writers — job completions, the queue-drained cleanup, a re-entrant startBackfill() call — and an unserialized read-mutate-write on each silently dropped whichever wrote last with a stale snapshot)', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => updateIndex(s, (idx) => { idx.ingested[`m${i}.md`] = { at: i, ok: true } }))
    )
    const idx = readIndex(s)
    expect(Object.keys(idx.ingested)).toHaveLength(10)
    for (let i = 0; i < 10; i++) expect(idx.ingested[`m${i}.md`]?.ok).toBe(true)
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
