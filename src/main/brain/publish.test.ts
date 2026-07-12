import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Settings } from '@shared/ipc'
import {
  DealEntitySchema,
  AccountEntitySchema,
  MeetingExtractionSchema,
  type DealEntity,
  type ProvenanceState,
  type Confidence,
  type MeetingExtraction
} from '@shared/brain'
import { writeDeal, writeAccount } from './store'
import { ingestExtraction } from './ingest'
import {
  publishEntity,
  publishMeetingCard,
  publishIndexes,
  publishAll,
  removeFromWiki,
  removeWiki,
  wikiDir,
  readConfidentialMeetings
} from './publish'

/**
 * Task MI-5 — the four load-bearing guarantees the brief calls out explicitly:
 *  1. Render gate: a deal amount/close_date NEVER renders anywhere in the wiki unless
 *     state ∈ {verified, pinned, edited} — property test over a synthetic brain.
 *  2. Confidential exclusion across all three surfaces (note card, entity pages, indexes).
 *  3. Publish determinism: publishAll run twice over the same brain state is byte-identical.
 *  4. Consent no-op: every publish entry point is a true no-op when publishBrainPages is off.
 */

vi.mock('electron')

const settingsFor = (folder: string, overrides: Partial<Settings> = {}): Settings =>
  ({ meetingsFolder: folder, encryptTranscripts: false, publishBrainPages: true, ...overrides }) as Settings

function meetingMd(opts: { date: string; title?: string; confidential?: boolean; recap?: string }): string {
  const lines = [
    '---',
    'type: meeting-transcript',
    'source: Métis',
    'mode: "meeting"',
    `date: ${opts.date}`,
    `title: "${opts.title ?? 'Test meeting'}"`,
    'status: ready-for-followup',
    ...(opts.confidential ? ['confidential: true'] : []),
    '---',
    '',
    `# ${opts.title ?? 'Test meeting'}`,
    '',
    '## Notes & follow-ups',
    '',
    opts.recap ?? '## Overview\n\nDiscussed the renewal.\n\n## Decisions\n\n- Proceed with the pilot\n\n## Action items\n\n- Send the proposal (You)',
    '',
    '## Full transcript',
    '',
    '**[10:00:00] Them:** hello there',
    ''
  ]
  return lines.join('\n')
}

function writeMeetingFile(folder: string, name: string, opts: { date: string; title?: string; confidential?: boolean; recap?: string }): void {
  writeFileSync(join(folder, name), meetingMd(opts), 'utf8')
}

/** Every file under `dir`, recursively, keyed by its path relative to `dir` — used to prove determinism
 *  (two publishAll runs produce byte-identical content) and to sweep the whole corpus for a leaked value. */
function snapshotDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(dir)) return out
  const walk = (d: string, prefix: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      const rel = prefix ? `${prefix}/${name}` : name
      if (statSync(p).isDirectory()) walk(p, rel)
      else out[rel] = readFileSync(p, 'utf8')
    }
  }
  walk(dir, '')
  return out
}

/** Mirrors publish.ts's private formatNumber grouping exactly, for constructing expected assertion
 *  strings — publish.ts deliberately avoids Number.toLocaleString() (locale-dependent, would break
 *  determinism), so tests must match that same hand-rolled comma grouping, not the locale-formatted one. */
function fmtAmount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function baseDeal(overrides: Partial<DealEntity> & { id: string; name: string }): DealEntity {
  return DealEntitySchema.parse({ schema_version: 2, aliases: [], stage: '', ...overrides })
}

describe('publish.ts — Task MI-5 markdown mirror', () => {
  let folder: string
  let s: Settings

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-publish-test-'))
    s = settingsFor(folder)
  })
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

  // ── 1. Render gate — the LOAD-BEARING guarantee, extended from MI-4 to the wiki ────────────────────

  describe('render gate — a numeric field never renders unless state ∈ {verified, pinned, edited}', () => {
    const cases: Array<{ label: string; state: ProvenanceState; confidence: Confidence; shouldRender: boolean }> = [
      { label: 'extracted + AMBIGUOUS', state: 'extracted', confidence: 'AMBIGUOUS', shouldRender: false },
      // The strict numeric gate: EXTRACTED confidence ALONE is not enough — this is the case a naive
      // "confidence-only" gate would get wrong, and exactly what MI-4's money-card gate guards against.
      { label: 'extracted + EXTRACTED', state: 'extracted', confidence: 'EXTRACTED', shouldRender: false },
      { label: 'extracted + INFERRED', state: 'extracted', confidence: 'INFERRED', shouldRender: false },
      { label: 'verified', state: 'verified', confidence: 'EXTRACTED', shouldRender: true },
      { label: 'pinned', state: 'pinned', confidence: 'EXTRACTED', shouldRender: true },
      { label: 'edited', state: 'edited', confidence: 'EXTRACTED', shouldRender: true }
    ]

    it('property test over a synthetic brain: an AMBIGUOUS/unverified amount never appears in any wiki file, ever', async () => {
      const ambiguousValues: number[] = []
      const verifiedValues: number[] = []
      // Amount values are deliberately UNRELATED to the deal's id/name/index (7-digit, far from the
      // small loop index) so the sweep below can never false-positive on the deal's own identity
      // metadata (title/resource path/filename) — only a genuine render-gate leak trips it.
      let amountCounter = 8_000_001
      let dealIndex = 0
      for (const c of cases) {
        const amountValue = amountCounter++
        const idx = dealIndex++
        ;(c.shouldRender ? verifiedValues : ambiguousValues).push(amountValue)
        const deal = baseDeal({
          id: `deal-${idx}`,
          name: `Deal ${idx}`,
          amount: {
            value: { value: amountValue, currency: 'EUR' },
            source_file: 'm1.md',
            date: '2026-01-01',
            quote: 'stated aloud',
            confidence: c.confidence,
            state: c.state,
            superseded: []
          }
        })
        await writeDeal(s, deal.id, deal)
        await publishEntity(s, 'deal', deal.id)
      }

      // Sweep EVERY file under wiki/ — the ambiguous/unverified amounts must never appear ANYWHERE
      // (not just on their own deal's page), while every verified/pinned/edited amount appears somewhere.
      // Checked in BOTH the raw digit string and publish.ts's comma-grouped rendering (fmtAmount mirrors
      // formatNumber's grouping exactly) — a real leak would appear comma-grouped, not as raw digits.
      const allText = Object.values(snapshotDir(wikiDir(s))).join('\n')
      for (const v of ambiguousValues) {
        expect(allText).not.toContain(String(v))
        expect(allText).not.toContain(fmtAmount(v))
      }
      for (const v of verifiedValues) expect(allText).toContain(fmtAmount(v))
    })

    for (const c of cases) {
      it(`amount with state=${c.state}, confidence=${c.confidence} (${c.label}) renders=${c.shouldRender}`, async () => {
        const deal = baseDeal({
          id: 'single-deal',
          name: 'Single Deal',
          amount: {
            value: { value: 424242, currency: 'USD' },
            source_file: 'm1.md',
            date: '2026-01-01',
            quote: 'stated aloud',
            confidence: c.confidence,
            state: c.state,
            superseded: []
          }
        })
        await writeDeal(s, deal.id, deal)
        await publishEntity(s, 'deal', deal.id)
        const content = readFileSync(join(wikiDir(s), 'deals', 'single-deal.md'), 'utf8')
        if (c.shouldRender) {
          expect(content).toContain('424,242 USD')
        } else {
          expect(content).not.toContain('424242')
          expect(content).not.toContain('424,242')
          expect(content).toMatch(/\| Amount \| not established \|/)
        }
      })
    }

    it('a confidential-sourced numeric field NEVER falls back into superseded — even a "verified-shaped" history entry is not enough', async () => {
      writeMeetingFile(folder, 'confidential.md', { date: '2026-02-01', confidential: true })
      const deal = baseDeal({
        id: 'fallback-deal',
        name: 'Fallback Deal',
        amount: {
          value: { value: 555000, currency: 'EUR' },
          source_file: 'confidential.md',
          date: '2026-02-01',
          quote: 'stated aloud',
          confidence: 'EXTRACTED',
          state: 'verified', // would normally render — but its ONLY source is confidential
          superseded: []
        }
      })
      await writeDeal(s, deal.id, deal)
      await publishEntity(s, 'deal', deal.id)
      const content = readFileSync(join(wikiDir(s), 'deals', 'fallback-deal.md'), 'utf8')
      expect(content).not.toContain('555000')
      expect(content).not.toContain('555,000')
      expect(content).toMatch(/\| Amount \| not established \|/)
    })
  })

  // ── 2. Confidential exclusion — all three surfaces ──────────────────────────────────────────────────

  describe('confidential meetings are excluded from all three published surfaces', () => {
    it('surface 1 — a confidential meeting gets NO note card (and any stale one is removed)', async () => {
      writeMeetingFile(folder, 'open.md', { date: '2026-01-01' })
      writeMeetingFile(folder, 'secret.md', { date: '2026-01-02', confidential: true })

      await publishMeetingCard(s, 'open.md')
      await publishMeetingCard(s, 'secret.md')
      expect(existsSync(join(wikiDir(s), 'meetings', 'open-md.md'))).toBe(true)
      expect(existsSync(join(wikiDir(s), 'meetings', 'secret-md.md'))).toBe(false)

      // Flagging AFTER a card already exists removes the stale card.
      writeMeetingFile(folder, 'open.md', { date: '2026-01-01' })
      await publishMeetingCard(s, 'open.md')
      expect(existsSync(join(wikiDir(s), 'meetings', 'open-md.md'))).toBe(true)
      writeMeetingFile(folder, 'open.md', { date: '2026-01-01', confidential: true })
      await publishMeetingCard(s, 'open.md')
      expect(existsSync(join(wikiDir(s), 'meetings', 'open-md.md'))).toBe(false)
    })

    it('surface 2 — entity pages exclude timeline rows and fall back current-facts values sourced from a confidential meeting', async () => {
      writeMeetingFile(folder, 'a.md', { date: '2026-01-01' })
      writeMeetingFile(folder, 'b.md', { date: '2026-02-01', confidential: true })

      const account = AccountEntitySchema.parse({
        id: 'acme',
        name: 'Acme',
        aliases: [],
        meetings: [
          { file: 'a.md', date: '2026-01-01', title: 'Kickoff' },
          { file: 'b.md', date: '2026-02-01', title: 'Confidential follow-up' }
        ],
        // The CURRENT sector sighting came from the confidential meeting; a non-confidential, EXTRACTED
        // superseded entry exists — the fallback should surface IT instead of going straight to "not
        // established" (proving the fallback isn't just "always fail closed").
        sector_provenance: {
          value: 'banking',
          source_file: 'b.md',
          date: '2026-02-01',
          confidence: 'EXTRACTED',
          state: 'extracted',
          superseded: [{ value: 'technology', date: '2026-01-01', source_file: 'a.md', confidence: 'EXTRACTED' }]
        }
      })
      await writeAccount(s, 'acme', account)
      await publishEntity(s, 'account', 'acme')

      const content = readFileSync(join(wikiDir(s), 'accounts', 'acme.md'), 'utf8')
      // Timeline: the confidential meeting is gone, the open one remains.
      expect(content).toContain('Kickoff')
      expect(content).not.toContain('Confidential follow-up')
      // Current facts: falls back to the non-confidential superseded sighting ("technology"), never the
      // confidential-sourced "banking".
      expect(content).toContain('technology')
      expect(content).not.toContain('banking')
    })

    it('surface 2b — falls back to "not established" when EVERY sighting of a field is confidential-sourced', async () => {
      writeMeetingFile(folder, 'only-secret.md', { date: '2026-01-01', confidential: true })
      const account = AccountEntitySchema.parse({
        id: 'shadow-co',
        name: 'Shadow Co',
        aliases: [],
        meetings: [{ file: 'only-secret.md', date: '2026-01-01', title: 'Secret meeting' }],
        sector_provenance: {
          value: 'banking',
          source_file: 'only-secret.md',
          date: '2026-01-01',
          confidence: 'EXTRACTED',
          state: 'extracted',
          superseded: []
        }
      })
      await writeAccount(s, 'shadow-co', account)
      await publishEntity(s, 'account', 'shadow-co')
      const content = readFileSync(join(wikiDir(s), 'accounts', 'shadow-co.md'), 'utf8')
      expect(content).not.toContain('banking')
      expect(content).toMatch(/\| Sector \| not established \|/)
      expect(content).not.toContain('Secret meeting')
    })

    it('surface 3 — indexes (index.md) exclude confidential meetings from Recent meetings', async () => {
      writeMeetingFile(folder, 'open.md', { date: '2026-01-01', title: 'Open Meeting' })
      writeMeetingFile(folder, 'secret.md', { date: '2026-01-02', title: 'Secret Meeting', confidential: true })
      const account = AccountEntitySchema.parse({
        id: 'acme',
        name: 'Acme',
        aliases: [],
        meetings: [
          { file: 'open.md', date: '2026-01-01', title: 'Open Meeting' },
          { file: 'secret.md', date: '2026-01-02', title: 'Secret Meeting' }
        ]
      })
      await writeAccount(s, 'acme', account)
      await publishIndexes(s)
      const index = readFileSync(join(wikiDir(s), 'index.md'), 'utf8')
      expect(index).toContain('Open Meeting')
      expect(index).not.toContain('Secret Meeting')
    })

    it('readConfidentialMeetings reads the frontmatter flag, never guessing on an undecryptable file', () => {
      writeMeetingFile(folder, 'a.md', { date: '2026-01-01' })
      writeMeetingFile(folder, 'b.md', { date: '2026-01-02', confidential: true })
      const set = readConfidentialMeetings(s)
      expect(set.has('b.md')).toBe(true)
      expect(set.has('a.md')).toBe(false)
    })
  })

  // ── 3. Determinism ──────────────────────────────────────────────────────────────────────────────────

  describe('determinism — publishing twice over the same brain state is byte-identical', () => {
    it('publishAll run twice produces identical bytes for every wiki file', async () => {
      writeMeetingFile(folder, join('2026-01-01_100000-kickoff.md'), { date: '2026-01-01T10:00:00.000Z', title: 'Kickoff call' })
      writeMeetingFile(folder, join('2026-02-01_110000-followup.md'), { date: '2026-02-01T11:00:00.000Z', title: 'Follow-up call' })

      const meeting1: MeetingExtraction = MeetingExtractionSchema.parse({
        account: { name: 'Acme Corp', sector: 'banking', confidence: 'EXTRACTED' },
        people: [{ name: 'Maria Silva', role: 'CFO', org: null, confidence: 'EXTRACTED' }],
        deal: { name: 'Acme Core Banking', stage: 'discovery' },
        commitments: [{ text: 'send the deck', by: 'you', quote: 'I will send the deck', confidence: 'EXTRACTED' }]
      })
      const meeting2: MeetingExtraction = MeetingExtractionSchema.parse({
        account: { name: 'Acme Corp', sector: 'banking', confidence: 'EXTRACTED' },
        people: [{ name: 'Maria Silva', role: 'CFO', org: null, confidence: 'EXTRACTED' }],
        deal: { name: 'Acme Core Banking', stage: 'proposal' }
      })
      await ingestExtraction(s, meeting1, readFileSync(join(folder, '2026-01-01_100000-kickoff.md'), 'utf8'), join(folder, '2026-01-01_100000-kickoff.md'))
      await ingestExtraction(s, meeting2, readFileSync(join(folder, '2026-02-01_110000-followup.md'), 'utf8'), join(folder, '2026-02-01_110000-followup.md'))

      await publishAll(s)
      const first = snapshotDir(wikiDir(s))
      expect(Object.keys(first).length).toBeGreaterThan(0)

      await publishAll(s)
      const second = snapshotDir(wikiDir(s))
      expect(second).toEqual(first)
    })
  })

  // ── 4. Consent no-op ─────────────────────────────────────────────────────────────────────────────────

  describe('consent gate — publishBrainPages off is a true no-op everywhere', () => {
    it('publishEntity/publishMeetingCard/publishIndexes/publishAll never touch disk when the setting is off', async () => {
      const off = settingsFor(folder, { publishBrainPages: false })
      writeMeetingFile(folder, 'm1.md', { date: '2026-01-01' })
      const account = AccountEntitySchema.parse({ id: 'acme', name: 'Acme', aliases: [] })
      await writeAccount(off, 'acme', account)

      await publishEntity(off, 'account', 'acme')
      await publishMeetingCard(off, 'm1.md')
      await publishIndexes(off)
      await publishAll(off)

      expect(existsSync(wikiDir(off))).toBe(false)
    })

    it('removeWiki deletes an existing mirror (the publishBrainPages-disabled flow)', async () => {
      writeMeetingFile(folder, 'm1.md', { date: '2026-01-01' })
      const account = AccountEntitySchema.parse({ id: 'acme', name: 'Acme', aliases: [] })
      await writeAccount(s, 'acme', account)
      await publishAll(s)
      expect(existsSync(wikiDir(s))).toBe(true)

      const r = removeWiki(s)
      expect(r.ok).toBe(true)
      expect(existsSync(wikiDir(s))).toBe(false)
    })
  })

  // ── Sanity: entity removal / basic content shape ────────────────────────────────────────────────────

  describe('entity removal + basic page shape', () => {
    it('removeFromWiki deletes a stale entity page, and publishEntity self-heals a tombstoned entity', async () => {
      const account = AccountEntitySchema.parse({ id: 'acme', name: 'Acme', aliases: [] })
      await writeAccount(s, 'acme', account)
      await publishEntity(s, 'account', 'acme')
      expect(existsSync(join(wikiDir(s), 'accounts', 'acme.md'))).toBe(true)

      await removeFromWiki(s, 'account', 'acme')
      expect(existsSync(join(wikiDir(s), 'accounts', 'acme.md'))).toBe(false)
    })

    it('every wiki page carries the Article 50 frontmatter marking', async () => {
      const account = AccountEntitySchema.parse({ id: 'acme', name: 'Acme', aliases: [] })
      await writeAccount(s, 'acme', account)
      await publishEntity(s, 'account', 'acme')
      const content = readFileSync(join(wikiDir(s), 'accounts', 'acme.md'), 'utf8')
      expect(content).toMatch(/ai_generated: true/)
      expect(content).toMatch(/generated_by: "asktoto\//)
      expect(content).toContain('AI-generated summary — verify before relying.')
    })

    it('publishIndexes writes index.md, AGENTS.md, and README.md', async () => {
      await publishIndexes(s)
      expect(existsSync(join(wikiDir(s), 'index.md'))).toBe(true)
      expect(existsSync(join(wikiDir(s), 'AGENTS.md'))).toBe(true)
      expect(existsSync(join(wikiDir(s), 'README.md'))).toBe(true)
      const agents = readFileSync(join(wikiDir(s), 'AGENTS.md'), 'utf8')
      expect(agents).toContain('File schema')
    })
  })
})
