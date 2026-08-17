import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Settings } from '@shared/ipc'
import { MeetingExtractionSchema, BRAIN_EXTRACTION_PROMPT, type MeetingExtraction, type DealEntity, type PersonEntity } from '@shared/brain'
import { INJECTION_GUARD } from '@shared/prompts'
import {
  extractJsonObject,
  mergeExtraction,
  lintBrain,
  commitmentKey,
  buildExtractionSystem,
  updateIndex,
  readMeetingSourceMode, whenIndexWritesSettle } from './ingest'
import { buildBrainContext } from './context'
import {
  brainDir,
  slugify,
  readGraph,
  readAccount,
  writeAccount,
  readPerson,
  writePerson,
  readDeal,
  writeDeal,
  readIndex,
  writeIndex,
  listEntities,
  purgeBrain
} from './store'

/** Recursively sorts object keys, and sorts arrays-of-objects by their canonical JSON text — makes
 *  comparisons order-insensitive for arrays whose element order is an ingestion-order artifact (e.g.
 *  `meetings`), not part of what a given test is proving. Used by the A1 convergence property test. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    const mapped = value.map(canonicalize)
    const allPlainObjects = mapped.every((v) => v !== null && typeof v === 'object' && !Array.isArray(v))
    return allPlainObjects
      ? [...mapped].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : mapped
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k])
    }
    return out
  }
  return value
}

vi.mock('electron')

const settingsFor = (folder: string): Settings => ({ meetingsFolder: folder } as Settings)

describe('brain', () => {
  let folder: string
  let s: Settings

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-brain-test-'))
    s = settingsFor(folder)
  })
  // MQA-007: settle the index-write lane BEFORE removing the profile. updateIndex writes
  // index.json through a tmp+rename, and a detached one can still be in flight here — under
  // parallel load the rename then lands on a directory this line already deleted, failing an
  // unrelated test in whichever file happened to be running.
  afterEach(async () => {
    await whenIndexWritesSettle()
    rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
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
    it('keeps the first complete object when a small local model appends another JSON fragment', () => {
      expect(JSON.parse(extractJsonObject('{"x":1}\n{"extra":"commentary"}'))).toEqual({ x: 1 })
    })
    it('throws when there is no JSON object at all', () => {
      expect(() => extractJsonObject('no json here')).toThrow()
    })
  })

  it('accepts null optional deal sidecars emitted by the bundled local model', () => {
    const extraction = MeetingExtractionSchema.parse({ deal: { amount: null, close_date: null } })
    expect(extraction.deal?.amount).toBeNull()
    expect(extraction.deal?.close_date).toBeNull()
  })

  it('normalizes all-null optional deal sidecars emitted by small local models', () => {
    const extraction = MeetingExtractionSchema.parse({
      deal: {
        amount: { value: null, currency: null, quote: null },
        close_date: { value: null, quote: null }
      }
    })
    expect(extraction.deal?.amount).toBeNull()
    expect(extraction.deal?.close_date).toBeNull()
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

    // Task MI-5 — a question phrased with a corrected-away surface form still hits the canonical
    // record: token matching now expands to entity aliases[], not just the current id.
    it('a question using a corrected-away alias still matches the canonical entity', async () => {
      const person: PersonEntity = {
        schema_version: 2,
        id: 'acme-co',
        aliases: ['Acme Corp'], // the pre-rename surface form
        name: 'Acme Co',
        role: 'CFO',
        account: null,
        meetings: [{ file: 'm1.md', date: '2026-06-01', title: 'Renewal call' }],
        quotes: [],
        stance_trail: [],
        commitments: []
      }
      await writePerson(s, 'acme-co', person)
      const { block, matched } = buildBrainContext(s, 'what did Acme Corp say on the renewal call?')
      expect(matched).toBe(true)
      expect(block).toContain('Acme Co') // the CURRENT canonical name, not the alias itself
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

  describe('A1 — latest-MEETING-DATE-wins convergence (D1 fix)', () => {
    const dealExtraction = (stage: string, band: 'good' | 'mixed' | 'concerning'): MeetingExtraction =>
      MeetingExtractionSchema.parse({
        account: { name: 'Acme', sector: 'banking', sector_confidence: 'INFERRED', confidence: 'EXTRACTED' },
        deal: {
          name: 'Acme Core',
          stage,
          win_likelihood_band: band,
          band_evidence: `evidence-${stage}`,
          velocity: { signal: 'hard-calendar-gate', evidence: `gate-${stage}` }
        }
      })

    it('converges to a byte-identical deal entity file regardless of ingestion order', async () => {
      const rows = [
        { file: 'm1.md', date: '2026-01-01', stage: 'discovery', band: 'mixed' as const },
        { file: 'm2.md', date: '2026-02-01', stage: 'proposal', band: 'good' as const },
        { file: 'm3.md', date: '2026-03-01', stage: 'closing', band: 'concerning' as const }
      ]

      const folderA = mkdtempSync(join(tmpdir(), 'asktoto-brain-a1a-'))
      const folderB = mkdtempSync(join(tmpdir(), 'asktoto-brain-a1b-'))
      try {
        const sA = settingsFor(folderA)
        const sB = settingsFor(folderB)

        // Brain A: chronological ingestion order. Brain B: reverse (worst-case shuffled) order —
        // mirrors backfill's readdirSync-order enqueue completing out of chronological order (D1).
        for (const r of rows) {
          await mergeExtraction(sA, dealExtraction(r.stage, r.band), { file: r.file, date: r.date, title: r.file })
        }
        for (const r of [...rows].reverse()) {
          await mergeExtraction(sB, dealExtraction(r.stage, r.band), { file: r.file, date: r.date, title: r.file })
        }

        const dslug = slugify('Acme Core')
        const dealA = readDeal(sA, dslug)!
        const dealB = readDeal(sB, dslug)!

        expect(canonicalize(dealA)).toEqual(canonicalize(dealB))
        // Specifically: the CHRONOLOGICALLY latest meeting's judgement wins, not whichever merged last.
        expect(dealA.stage).toBe('closing')
        expect(dealA.win_likelihood_band).toBe('concerning')
        expect(dealA.velocity.evidence).toBe('gate-closing')
      } finally {
        rmSync(folderA, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
        rmSync(folderB, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      }
    })
  })

  describe('A1 hardening — deterministic tie-breaking via total order on (date, source_file)', () => {
    type Row = { file: string; date: string; stage: string; band: 'good' | 'mixed' | 'concerning' }

    const rowExtraction = (r: Row): MeetingExtraction =>
      MeetingExtractionSchema.parse({
        account: { name: 'Acme', sector: 'banking', sector_confidence: 'INFERRED', confidence: 'EXTRACTED' },
        people: [{ name: 'Kim Lee', role: `role-${r.stage}`, org: null, confidence: 'EXTRACTED' }],
        deal: {
          name: 'Acme Core',
          stage: r.stage,
          win_likelihood_band: r.band,
          band_evidence: `ev-${r.stage}`,
          velocity: { signal: 'hard-calendar-gate', evidence: `gate-${r.stage}` }
        }
      })

    const permutations = <T,>(items: T[]): T[][] =>
      items.length <= 1
        ? [[...items]]
        : items.flatMap((item, i) =>
            permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest])
          )

    /** Merge `order` into a fresh brain; return the canonical JSON of the resulting entity files plus
     *  the raw deal for order-sensitive assertions (canonicalize sorts arrays, erasing superseded order). */
    const stateAfter = async (order: Row[]): Promise<{ canon: string; deal: DealEntity }> => {
      const dir = mkdtempSync(join(tmpdir(), 'asktoto-brain-tie-'))
      try {
        const sx = settingsFor(dir)
        for (const r of order) {
          await mergeExtraction(sx, rowExtraction(r), { file: r.file, date: r.date, title: r.file })
        }
        const deal = readDeal(sx, slugify('Acme Core'))!
        const person = readPerson(sx, slugify('Kim Lee'))!
        return { canon: JSON.stringify({ deal: canonicalize(deal), person: canonicalize(person) }), deal }
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      }
    }

    it('two same-day meetings (bare dates, the common frontmatter form) converge — source_file breaks the tie', async () => {
      const rows: Row[] = [
        { file: 'a.md', date: '2026-01-15', stage: 'alpha', band: 'mixed' },
        { file: 'b.md', date: '2026-01-15', stage: 'beta', band: 'good' }
      ]
      const fwd = await stateAfter(rows)
      const rev = await stateAfter([...rows].reverse())
      expect(fwd.canon).toBe(rev.canon)
      expect(fwd.deal.stage).toBe('beta') // 'b.md' > 'a.md' lexically — a property of the data, not arrival order
    })

    it('two blank-date meetings (the statSync-failure fallback) converge the same way', async () => {
      const rows: Row[] = [
        { file: 'a.md', date: '', stage: 'alpha', band: 'mixed' },
        { file: 'b.md', date: '', stage: 'beta', band: 'good' }
      ]
      const fwd = await stateAfter(rows)
      const rev = await stateAfter([...rows].reverse())
      expect(fwd.canon).toBe(rev.canon)
      expect(fwd.deal.stage).toBe('beta')
    })

    it('ALL 6 permutations of a 3-extraction set with one tied pair produce byte-identical entity files', async () => {
      const rows: Row[] = [
        { file: 'm1.md', date: '2026-01-01', stage: 'discovery', band: 'mixed' },
        { file: 'm2.md', date: '2026-02-01', stage: 'proposal', band: 'good' },
        { file: 'm3.md', date: '2026-02-01', stage: 'negotiation', band: 'concerning' } // ties with m2
      ]
      const states: Awaited<ReturnType<typeof stateAfter>>[] = []
      for (const perm of permutations(rows)) states.push(await stateAfter(perm))
      for (const st of states.slice(1)) expect(st.canon).toBe(states[0].canon)

      const deal = states[0].deal
      expect(deal.stage).toBe('negotiation') // date tie m2/m3 → 'm3.md' > 'm2.md'
      expect(deal.win_likelihood_band).toBe('concerning')
      expect(deal.band_evidence).toBe('ev-negotiation')
      // History: one entry per losing value, most-recent-first by the same (date, source_file) key.
      expect(deal.stage_provenance!.superseded.map((e) => e.value)).toEqual(['proposal', 'discovery'])
      // Explicit budget: this case ingests 3 extractions through the real store for each of 6
      // permutations — 18 full write/read round trips against a temp profile, by far the heaviest test
      // in the file. vitest's 5s default is comfortable on an idle machine and not on a loaded CI runner,
      // where it aborts mid-permutation and reports a timeout that looks like a determinism failure.
      // MQA-007: raised past the 30s global for the same reason it needed one in the first place — it is
      // ~18x the I/O of an ordinary test here, so it is the first thing to cross any shared budget when
      // several suites compete for one disk. Serially it finishes in well under a second.
    }, 90_000)

    it('an EXTRACTED classification beats a weaker one in BOTH merge orders (never-downgrade, bidirectional)', async () => {
      const sectorX = (sector: 'banking' | 'technology', conf: 'EXTRACTED' | 'INFERRED'): MeetingExtraction =>
        MeetingExtractionSchema.parse({
          account: { name: 'TieCo', sector, sector_confidence: conf, confidence: 'EXTRACTED' }
        })
      const firmRef = { file: 'm1.md', date: '2026-01-01', title: 't' }
      const weakRef = { file: 'm2.md', date: '2026-02-01', title: 't' } // weaker evidence is NEWER — the divergent case

      const run = async (order: Array<[MeetingExtraction, typeof firmRef]>) => {
        const dir = mkdtempSync(join(tmpdir(), 'asktoto-brain-conf-'))
        try {
          const sx = settingsFor(dir)
          for (const [x, ref] of order) await mergeExtraction(sx, x, ref)
          const acc = readAccount(sx, slugify('TieCo'))!
          return { canon: JSON.stringify(canonicalize(acc)), acc }
        } finally {
          rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
        }
      }

      const a = await run([[sectorX('banking', 'EXTRACTED'), firmRef], [sectorX('technology', 'INFERRED'), weakRef]])
      const b = await run([[sectorX('technology', 'INFERRED'), weakRef], [sectorX('banking', 'EXTRACTED'), firmRef]])
      expect(a.canon).toBe(b.canon)
      expect(a.acc.sector).toBe('banking') // the EXTRACTED classification wins in both orders
      expect(a.acc.sector_confidence).toBe('EXTRACTED')
    })

    it('MI-4: mixed-tier superseded permutation — the reviewer-constructed case converges byte-equal across all 6 orderings', async () => {
      // Value V ('retail') is sighted TWICE, at different confidence tiers and dates: once weaker but
      // NEWER (INFERRED, z.md, 2026-03-01), once stronger but OLDER (EXTRACTED, a.md, 2026-01-01). Both
      // lose to value W ('banking'), the genuine EXTRACTED, most-recent winner (w.md, 2026-06-01). Pre-fix,
      // pushSuperseded's dedup ordered candidates by (date, source_file) alone — ignoring confidence
      // entirely — so the two V sightings could collapse onto the WRONG (weaker, merely-newer-dated) one.
      // Post-fix, the same `outranks` order (confidence tier first) used for winner selection also governs
      // the superseded dedup, so the kept V entry is deterministically the EXTRACTED sighting regardless
      // of arrival order.
      const sectorX = (sector: 'retail' | 'banking', conf: 'EXTRACTED' | 'INFERRED'): MeetingExtraction =>
        MeetingExtractionSchema.parse({
          account: { name: 'MixCo', sector, sector_confidence: conf, confidence: 'EXTRACTED' }
        })
      const weakerNewerV = { x: sectorX('retail', 'INFERRED'), ref: { file: 'z.md', date: '2026-03-01', title: 't' } }
      const strongerOlderV = { x: sectorX('retail', 'EXTRACTED'), ref: { file: 'a.md', date: '2026-01-01', title: 't' } }
      const winnerW = { x: sectorX('banking', 'EXTRACTED'), ref: { file: 'w.md', date: '2026-06-01', title: 't' } }
      const sightings = [weakerNewerV, strongerOlderV, winnerW]

      const run = async (order: typeof sightings) => {
        const dir = mkdtempSync(join(tmpdir(), 'asktoto-brain-mixedtier-'))
        try {
          const sx = settingsFor(dir)
          for (const { x, ref } of order) await mergeExtraction(sx, x, ref)
          const acc = readAccount(sx, slugify('MixCo'))!
          return { canon: JSON.stringify(canonicalize(acc)), acc }
        } finally {
          rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
        }
      }

      const results: Awaited<ReturnType<typeof run>>[] = []
      for (const perm of permutations(sightings)) results.push(await run(perm))
      for (const r of results.slice(1)) expect(r.canon).toBe(results[0].canon)

      const acc = results[0].acc
      expect(acc.sector).toBe('banking')
      expect(acc.sector_confidence).toBe('EXTRACTED')
      // Exactly ONE superseded entry for 'retail' — the two V sightings deduped — and it carries the
      // metadata of the STRONGER (EXTRACTED, a.md, 2026-01-01) sighting, not the merely-newer-dated
      // INFERRED one, despite its earlier date.
      expect(acc.sector_provenance!.superseded).toEqual([
        { value: 'retail', date: '2026-01-01', source_file: 'a.md', confidence: 'EXTRACTED' }
      ])
    })

    it('a bland velocity report neither clobbers a real calendar signal nor seeds order-dependent history', async () => {
      const velX = (signal: 'hard-calendar-gate' | 'no-hard-date-found', evidence: string): MeetingExtraction =>
        MeetingExtractionSchema.parse({
          account: { name: 'VelCo', sector: 'banking', confidence: 'EXTRACTED' },
          deal: { name: 'VelCo Deal', stage: 'open', velocity: { signal, evidence } }
        })
      const realRef = { file: 'm1.md', date: '2026-01-01', title: 't' }
      const blandRef = { file: 'm2.md', date: '2026-02-01', title: 't' } // "no info found" is NEWER — the dangerous order

      const run = async (order: Array<[MeetingExtraction, typeof realRef]>) => {
        const dir = mkdtempSync(join(tmpdir(), 'asktoto-brain-vel-'))
        try {
          const sx = settingsFor(dir)
          for (const [x, ref] of order) await mergeExtraction(sx, x, ref)
          const deal = readDeal(sx, slugify('VelCo Deal'))!
          return { canon: JSON.stringify(canonicalize(deal)), deal }
        } finally {
          rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
        }
      }

      const a = await run([
        [velX('hard-calendar-gate', 'kickoff June 3'), realRef],
        [velX('no-hard-date-found', ''), blandRef]
      ])
      const b = await run([
        [velX('no-hard-date-found', ''), blandRef],
        [velX('hard-calendar-gate', 'kickoff June 3'), realRef]
      ])
      expect(a.canon).toBe(b.canon)
      expect(a.deal.velocity).toEqual({ signal: 'hard-calendar-gate', evidence: 'kickoff June 3' })
      // 'no info found' is the absence of information, not superseded knowledge — it never enters history.
      expect(a.deal.velocity_provenance!.superseded).toHaveLength(0)
    })
  })

  describe('A2 — lintBrain multi-account detection (D8 fix)', () => {
    it('flags a person whose org history spans two distinct accounts', async () => {
      const x1 = sampleExtraction()
      x1.account = { name: 'Acme', sector: 'banking', sector_confidence: 'INFERRED', confidence: 'EXTRACTED' }
      x1.people = [{ name: 'Jamie Fox', role: null, org: null, confidence: 'EXTRACTED' }]
      x1.deal = null
      await mergeExtraction(s, x1, { file: 'a1.md', date: '2026-01-01', title: 't' })

      const x2 = sampleExtraction()
      x2.account = { name: 'Globex', sector: 'retail', sector_confidence: 'INFERRED', confidence: 'EXTRACTED' }
      x2.people = [{ name: 'Jamie Fox', role: null, org: null, confidence: 'EXTRACTED' }]
      x2.deal = null
      await mergeExtraction(s, x2, { file: 'a2.md', date: '2026-02-01', title: 't' })

      const warnings = lintBrain(s)
      expect(warnings.some((w) => w.includes('Jamie Fox') && w.includes('multiple accounts'))).toBe(true)
    })

    it('does not flag a person seen at only one account across meetings', async () => {
      const x1 = sampleExtraction()
      x1.people = [{ name: 'Solo Person', role: null, org: null, confidence: 'EXTRACTED' }]
      x1.deal = null
      await mergeExtraction(s, x1, { file: 'b1.md', date: '2026-01-01', title: 't' })

      const x2 = sampleExtraction()
      x2.people = [{ name: 'Solo Person', role: null, org: null, confidence: 'EXTRACTED' }]
      x2.deal = null
      await mergeExtraction(s, x2, { file: 'b2.md', date: '2026-02-01', title: 't' })

      const warnings = lintBrain(s)
      expect(warnings.some((w) => w.includes('Solo Person'))).toBe(false)
    })
  })

  describe('B3 — pinned/edited provenance is never overwritten by merge', () => {
    it('a pinned stage survives a later extraction with a different value, and logs the attempt to superseded', async () => {
      await mergeExtraction(s, sampleExtraction(), { file: 'm1.md', date: '2026-01-01', title: 't' })
      const dslug = slugify('LATAM SAP AMS')
      const deal = readDeal(s, dslug)!
      deal.stage_provenance = {
        value: 'human-verified-stage',
        source_file: 'manual',
        date: '2026-01-15',
        confidence: 'EXTRACTED',
        state: 'pinned',
        superseded: []
      }
      deal.stage = 'human-verified-stage'
      await writeDeal(s, dslug, deal)

      const second = sampleExtraction()
      second.deal!.stage = 'different-stage'
      await mergeExtraction(s, second, { file: 'm2.md', date: '2026-02-01', title: 't' })

      const after = readDeal(s, dslug)!
      expect(after.stage).toBe('human-verified-stage') // the pin survives a later, differing extraction
      expect(after.stage_provenance!.state).toBe('pinned')
      expect(after.stage_provenance!.superseded.some((x) => x.value === 'different-stage')).toBe(true)
    })

    it('an edited role survives a later extraction with a different value', async () => {
      await mergeExtraction(s, sampleExtraction(), { file: 'm1.md', date: '2026-01-01', title: 't' })
      const pslug = slugify('Maria Silva')
      const person = readPerson(s, pslug)!
      person.role_provenance = {
        value: 'Human-corrected role',
        source_file: 'manual',
        date: '2026-01-15',
        confidence: 'EXTRACTED',
        state: 'edited',
        superseded: []
      }
      person.role = 'Human-corrected role'
      await writePerson(s, pslug, person)

      const second = sampleExtraction()
      second.people = [{ name: 'Maria Silva', role: 'Different role', org: null, confidence: 'EXTRACTED' }]
      await mergeExtraction(s, second, { file: 'm2.md', date: '2026-02-01', title: 't' })

      const after = readPerson(s, pslug)!
      expect(after.role).toBe('Human-corrected role')
      expect(after.role_provenance!.state).toBe('edited')
      expect(after.role_provenance!.superseded.some((x) => x.value === 'Different role')).toBe(true)
    })

    it('a value-identical later extraction refreshes date/source but does not push a superseded entry', async () => {
      await mergeExtraction(s, sampleExtraction(), { file: 'm1.md', date: '2026-01-01', title: 't' })
      const dslug = slugify('LATAM SAP AMS')
      expect(readDeal(s, dslug)!.stage_provenance!.superseded).toHaveLength(0)

      const second = sampleExtraction() // identical stage value ('defense'), later date
      await mergeExtraction(s, second, { file: 'm2.md', date: '2026-02-01', title: 't' })

      const after = readDeal(s, dslug)!
      expect(after.stage).toBe('defense')
      expect(after.stage_provenance!.date).toBe('2026-02-01') // metadata refreshed to the later meeting
      expect(after.stage_provenance!.source_file).toBe('m2.md')
      expect(after.stage_provenance!.superseded).toHaveLength(0) // re-confirming the same fact is not history
    })

    it('EXTRACTED confidence never downgrades to INFERRED (generalized sector rule)', async () => {
      const firm = sampleExtraction()
      firm.account!.sector_confidence = 'EXTRACTED'
      await mergeExtraction(s, firm, { file: 'm1.md', date: '2026-01-01', title: 't' })
      const accSlug = slugify("L'Oréal")
      expect(readAccount(s, accSlug)!.sector_confidence).toBe('EXTRACTED')

      const weaker = sampleExtraction()
      weaker.account!.sector = 'technology' // a different, weaker-confidence classification
      weaker.account!.sector_confidence = 'INFERRED'
      await mergeExtraction(s, weaker, { file: 'm2.md', date: '2026-02-01', title: 't' })

      const after = readAccount(s, accSlug)!
      expect(after.sector).toBe('consumer-goods') // unchanged — the firmer EXTRACTED classification wins
      expect(after.sector_confidence).toBe('EXTRACTED')
    })
  })

  describe('B2 — v1 → v2 lazy migration', () => {
    it('migrates a v1 person file to v2 in memory: plain fields unchanged, role/org_provenance synthesized honestly', () => {
      const dir = join(brainDir(s), 'entities', 'person')
      mkdirSync(dir, { recursive: true })
      const v1 = {
        name: 'Maria Silva',
        role: 'Procurement lead',
        account: "L'Oréal",
        meetings: [{ file: 'm1.md', date: '2026-01-05', title: 't' }],
        quotes: [],
        stance_trail: [],
        commitments: []
      }
      writeFileSync(join(dir, 'maria-silva.json'), JSON.stringify(v1), 'utf8')

      const p = readPerson(s, 'maria-silva')!
      expect(p.schema_version).toBe(2)
      expect(p.id).toBe('maria-silva')
      expect(p.aliases).toEqual([])
      expect(p.role).toBe('Procurement lead') // plain field untouched — buildBrainContext keeps working
      expect(p.account).toBe("L'Oréal")
      expect(p.role_provenance).toEqual({
        value: 'Procurement lead',
        source_file: '', // honest: we don't know which meeting first asserted it — never fabricate one
        date: '2026-01-05', // the entity's earliest known meeting date
        confidence: 'INFERRED', // no per-field confidence existed in v1 — can't claim EXTRACTED
        state: 'extracted',
        superseded: []
      })
      expect(p.org_provenance!.value).toBe("L'Oréal")
    })

    it('migrates a v1 account file to v2, reusing the REAL existing sector_confidence rather than a blind default', () => {
      const dir = join(brainDir(s), 'entities', 'account')
      mkdirSync(dir, { recursive: true })
      const v1 = {
        name: 'Acme',
        sector: 'banking',
        sector_confidence: 'EXTRACTED',
        strategic: false,
        people: [],
        deals: [],
        meetings: [{ file: 'm1.md', date: '2026-02-01', title: 't' }],
        win_reasons: [],
        loss_reasons: []
      }
      writeFileSync(join(dir, 'acme.json'), JSON.stringify(v1), 'utf8')

      const a = readAccount(s, 'acme')!
      expect(a.schema_version).toBe(2)
      expect(a.id).toBe('acme')
      expect(a.sector).toBe('banking')
      expect(a.sector_provenance).toEqual({
        value: 'banking',
        source_file: '',
        date: '2026-02-01',
        confidence: 'EXTRACTED', // reused from the real, existing sector_confidence — not fabricated
        state: 'extracted',
        superseded: []
      })
    })

    it('migrates a v1 deal file to v2, seeding win_likelihood_band_provenance.quote from the existing band_evidence', () => {
      const dir = join(brainDir(s), 'entities', 'deal')
      mkdirSync(dir, { recursive: true })
      const v1 = {
        name: 'Acme Core Banking',
        account: 'Acme',
        stage: 'defense',
        outcome: 'open',
        win_likelihood_band: 'mixed',
        band_evidence: 'price pressure but strong relationship',
        velocity: { signal: 'hard-calendar-gate', evidence: 'go/no-go week of June 15' },
        meetings: [{ file: 'm1.md', date: '2026-03-01', title: 't' }],
        signals: [],
        missed_signals: [],
        commitments: [],
        feedback: []
      }
      writeFileSync(join(dir, 'acme-core-banking.json'), JSON.stringify(v1), 'utf8')

      const d = readDeal(s, 'acme-core-banking')!
      expect(d.schema_version).toBe(2)
      expect(d.id).toBe('acme-core-banking')
      expect(d.stage).toBe('defense')
      expect(d.stage_provenance).toEqual({
        value: 'defense', source_file: '', date: '2026-03-01', confidence: 'INFERRED', state: 'extracted', superseded: []
      })
      expect(d.win_likelihood_band_provenance!.quote).toBe('price pressure but strong relationship')
      expect(d.velocity_provenance!.value).toEqual({ signal: 'hard-calendar-gate', evidence: 'go/no-go week of June 15' })
    })

    it('write path always emits schema_version 2, and a migrated-then-written file round-trips stably', async () => {
      const dir = join(brainDir(s), 'entities', 'person')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'v1-roundtrip.json'),
        JSON.stringify({
          name: 'V1 Person', role: 'Buyer', account: 'Acme',
          meetings: [], quotes: [], stance_trail: [], commitments: []
        }),
        'utf8'
      )
      const migrated = readPerson(s, 'v1-roundtrip')!
      await writePerson(s, 'v1-roundtrip', migrated)

      const onDisk = JSON.parse(readFileSync(join(dir, 'v1-roundtrip.json'), 'utf8'))
      expect(onDisk.schema_version).toBe(2)

      const reread = readPerson(s, 'v1-roundtrip')!
      expect(reread).toEqual(migrated)
    })

    it('creates .brain.backup-v1 exactly once, before the first v2 write into a brain holding v1 files', async () => {
      const dir = join(brainDir(s), 'entities', 'person')
      mkdirSync(dir, { recursive: true })
      const v1Raw = JSON.stringify({
        name: 'Backup Test', role: null, account: null,
        meetings: [], quotes: [], stance_trail: [], commitments: []
      })
      writeFileSync(join(dir, 'backup-test.json'), v1Raw, 'utf8')

      const backupDir = `${brainDir(s)}.backup-v1`
      expect(existsSync(backupDir)).toBe(false)

      const migrated = readPerson(s, 'backup-test')!
      await writePerson(s, 'backup-test', migrated) // first v2 write — should trigger the backup

      expect(existsSync(backupDir)).toBe(true)
      const backedUpRaw = readFileSync(join(backupDir, 'entities', 'person', 'backup-test.json'), 'utf8')
      expect(JSON.parse(backedUpRaw)).toEqual(JSON.parse(v1Raw)) // pristine pre-migration snapshot

      // A second v2 write must NOT touch the backup again.
      const again = readPerson(s, 'backup-test')!
      again.role = 'changed after backup'
      await writePerson(s, 'backup-test', again)
      const stillOriginal = readFileSync(join(backupDir, 'entities', 'person', 'backup-test.json'), 'utf8')
      expect(JSON.parse(stillOriginal)).toEqual(JSON.parse(v1Raw))
    })

    it('a file that fails both v1 and v2 parse behaves exactly as before (returns null, never throws)', () => {
      const dir = join(brainDir(s), 'entities', 'person')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'broken.json'), '{ not valid json', 'utf8')
      expect(readPerson(s, 'broken')).toBeNull()
    })
  })
})
