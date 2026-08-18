import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Settings } from '@shared/ipc'
import { MeetingExtractionSchema, type DealEntity } from '@shared/brain'
import { ingestExtraction, updateIndex, whenIndexWritesSettle } from './ingest'
import { updateEntityField } from './corrections'
import { slugify, setDealOutcome, readMeetingExtraction, readDeal, writeDeal } from './store'
import { computeAttention } from './attention'
import { formatDeal } from './context'

vi.mock('electron')

const settingsFor = (folder: string): Settings => ({ meetingsFolder: folder, encryptTranscripts: false }) as Settings

const transcriptMd = (date: string): string =>
  `---\ntype: meeting-transcript\nsource: Métis\nmode: "meeting"\ndate: ${date}\n---\n\n## Full transcript\n\n**[10:00:00] Them:** hello\n`

describe('computeAttention (Task MI-3 needs-attention aggregation)', () => {
  let folder: string
  let s: Settings

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-attention-test-'))
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
  it('a clean brain (no entities) produces no items', () => {
    expect(computeAttention(s)).toEqual([])
  })

  it('a clean brain with entities but no lint/ambiguous/contradicted signals produces no items', async () => {
    const clean = MeetingExtractionSchema.parse({
      account: { name: 'Acme Corp', sector: 'banking', sector_confidence: 'EXTRACTED', confidence: 'EXTRACTED' },
      people: [{ name: 'Jamie Fox', role: 'CFO', org: null, confidence: 'EXTRACTED' }],
      deal: { name: 'Acme Core Banking', stage: 'discovery' }
    })
    await ingestExtraction(s, clean, transcriptMd('2026-06-01'), join(folder, 'clean.md'))
    expect(computeAttention(s)).toEqual([])
  })

  it('flags a lintBrain finding (closed deal still carrying a live win-likelihood band), entity-linked', async () => {
    const x = MeetingExtractionSchema.parse({
      deal: { name: 'Acme Core Banking', stage: 'discovery', win_likelihood_band: 'good', band_evidence: 'they love it' }
    })
    await ingestExtraction(s, x, transcriptMd('2026-06-01'), join(folder, 'm1.md'))
    const dealSlug = slugify('Acme Core Banking')
    const updated = await setDealOutcome(s, dealSlug, 'won')
    expect(updated).not.toBeNull()

    const items = computeAttention(s)
    const lint = items.find((i) => i.kind === 'lint')
    expect(lint).toBeDefined()
    expect(lint?.entityKind).toBe('deal')
    expect(lint?.id).toBe(dealSlug)
    expect(lint?.label).toBe('Acme Core Banking')
    expect(lint?.detail).toContain('won')
  })

  it('flags an AMBIGUOUS-confidence provenant field', async () => {
    const x = MeetingExtractionSchema.parse({
      account: { name: 'Acme Corp', sector: 'banking', sector_confidence: 'AMBIGUOUS', confidence: 'EXTRACTED' }
    })
    await ingestExtraction(s, x, transcriptMd('2026-06-01'), join(folder, 'm1.md'))

    const items = computeAttention(s)
    const ambiguous = items.find((i) => i.kind === 'ambiguous')
    expect(ambiguous).toBeDefined()
    expect(ambiguous?.entityKind).toBe('account')
    expect(ambiguous?.id).toBe(slugify('Acme Corp'))
    expect(ambiguous?.label).toBe('Acme Corp')
    expect(ambiguous?.detail).toContain('Sector')
  })

  it('flags a contradicted pin — a human pin followed by a later meeting reporting something different', async () => {
    const dealSlug = slugify('Acme Core Banking')
    const x1 = MeetingExtractionSchema.parse({ deal: { name: 'Acme Core Banking', stage: 'discovery' } })
    await ingestExtraction(s, x1, transcriptMd('2026-01-01'), join(folder, 'm1.md'))

    const pinned = await updateEntityField(s, { kind: 'deal', id: dealSlug, field: 'stage', value: 'negotiation' })
    expect(pinned.ok).toBe(true)

    // A meeting dated well AFTER the pin (the pin's own `date` is real "now") reports a different stage —
    // mergeProvenant refuses to overwrite the pin but records the contradiction into `superseded`.
    const x2 = MeetingExtractionSchema.parse({ deal: { name: 'Acme Core Banking', stage: 'closed-lost' } })
    await ingestExtraction(s, x2, transcriptMd('2030-01-01'), join(folder, 'm2.md'))

    const items = computeAttention(s)
    const contradicted = items.find((i) => i.kind === 'contradicted_pin')
    expect(contradicted).toBeDefined()
    expect(contradicted?.entityKind).toBe('deal')
    expect(contradicted?.id).toBe(dealSlug)
    expect(contradicted?.label).toBe('Acme Core Banking')
    expect(contradicted?.detail).toContain('negotiation')
    expect(contradicted?.detail).toContain('closed-lost')
  })

  it('does NOT flag a pin with no later contradicting meeting', async () => {
    const dealSlug = slugify('Acme Core Banking')
    const x1 = MeetingExtractionSchema.parse({ deal: { name: 'Acme Core Banking', stage: 'discovery' } })
    await ingestExtraction(s, x1, transcriptMd('2026-01-01'), join(folder, 'm1.md'))
    const pinned = await updateEntityField(s, { kind: 'deal', id: dealSlug, field: 'stage', value: 'negotiation' })
    expect(pinned.ok).toBe(true)

    const items = computeAttention(s)
    expect(items.find((i) => i.kind === 'contradicted_pin')).toBeUndefined()
  })

  it('flags a lintBrain multi-account person, entity-linked to the person', async () => {
    const x1 = MeetingExtractionSchema.parse({
      account: { name: 'Acme', sector: 'banking', confidence: 'EXTRACTED' },
      people: [{ name: 'Jamie Fox', role: null, org: null, confidence: 'EXTRACTED' }]
    })
    await ingestExtraction(s, x1, transcriptMd('2026-01-01'), join(folder, 'a1.md'))
    const x2 = MeetingExtractionSchema.parse({
      account: { name: 'Globex', sector: 'retail', confidence: 'EXTRACTED' },
      people: [{ name: 'Jamie Fox', role: null, org: null, confidence: 'EXTRACTED' }]
    })
    await ingestExtraction(s, x2, transcriptMd('2026-02-01'), join(folder, 'a2.md'))

    const items = computeAttention(s)
    const lint = items.find((i) => i.kind === 'lint')
    expect(lint).toBeDefined()
    expect(lint?.entityKind).toBe('person')
    expect(lint?.id).toBe(slugify('Jamie Fox'))
    expect(lint?.label).toBe('Jamie Fox')
    expect(lint?.detail).toContain('multiple accounts')
  })

  it('flags a durably failed ingest source with kind ingest_failed, no entityKind, and the error + exhausted flag in detail', async () => {
    await updateIndex(s, (idx) => {
      idx.ingested['bad-meeting.md'] = { at: Date.now(), ok: false, error: 'Provider timeout', attempts: 6, exhausted: true }
    })

    const items = computeAttention(s)
    const failed = items.find((i) => i.kind === 'ingest_failed')
    expect(failed).toBeDefined()
    expect(failed?.entityKind).toBeUndefined()
    expect(failed?.id).toBe('bad-meeting.md')
    expect(failed?.label).toBe('bad-meeting.md')
    expect(failed?.detail).toContain('Provider timeout')
    expect(failed?.detail.toLowerCase()).toContain('exhaust')
  })

  it('does not flag a successfully ingested source, and caps ingest_failed items', async () => {
    await updateIndex(s, (idx) => {
      idx.ingested['good.md'] = { at: Date.now(), ok: true }
      for (let i = 0; i < 15; i++) {
        idx.ingested[`bad-${i}.md`] = { at: Date.now() + i, ok: false, error: 'x' }
      }
    })

    const failed = computeAttention(s).filter((i) => i.kind === 'ingest_failed')
    expect(failed.some((i) => i.id === 'good.md')).toBe(false)
    expect(failed.length).toBeLessThanOrEqual(10)
  })
})

/** brain:meetingExtraction's store contract — the handler in index.ts is
 *  `readMeetingExtraction(s, slugify(basename(file)))`; this proves that key derivation round-trips
 *  with what ingestExtraction wrote, for both a full path and a bare basename, and that a
 *  never-ingested file reads back as null. */
describe('brain:meetingExtraction store contract', () => {
  let folder: string
  let s: Settings

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-meeting-extraction-test-'))
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
  it('returns the stored extraction for an ingested meeting, keyed by slugify(basename(file))', async () => {
    const x = MeetingExtractionSchema.parse({
      title24: 'Banking sync',
      account: { name: 'Acme Corp', sector: 'banking', confidence: 'EXTRACTED' }
    })
    const fullPath = join(folder, 'Meeting 2026-07-11.md')
    await ingestExtraction(s, x, transcriptMd('2026-07-11'), fullPath)

    const viaFullPath = readMeetingExtraction(s, slugify(basename(fullPath)))
    expect(viaFullPath).not.toBeNull()
    expect(viaFullPath?.title24).toBe('Banking sync')
    expect(viaFullPath?.account?.name).toBe('Acme Corp')
    // A renderer that only holds the basename (past meetings) derives the same key.
    expect(readMeetingExtraction(s, slugify(basename('Meeting 2026-07-11.md')))).toEqual(viaFullPath)
  })

  it('returns null for a meeting the brain never ingested', () => {
    expect(readMeetingExtraction(s, slugify('never-ingested.md'))).toBeNull()
  })
})

/**
 * MI-4 adversarial review fix — the headline guarantee ("no unverified numeric value ever reaches a
 * rendered surface") had a hole: `fieldItems`'s Amount/Close date branches interpolated the RAW field
 * value into `item.detail` with no gate on confidence/state, and BrainView renders `item.detail`
 * verbatim. Two reproduced leaks, both fixed by routing amount/close_date through a fixed redacted
 * phrase (see attention.ts's `'redact'` sentinel):
 *   - Leak A: an AMBIGUOUS amount rendered its own unconfirmed figure.
 *   - Leak B (worse): a pinned amount contradicted by a later meeting rendered the NEWER value verbatim
 *     — and mergeProvenant's pinned branch (store.ts's pushSuperseded call at ingest.ts:415-425) pushes
 *     any differing incoming value into `superseded` with NO verification gate, so that newer value can
 *     be a fabricated number the grounding check rejected.
 * Mirrors verified-numbers.test.ts's render-gate property test: a distinctive value, a digit-substring
 * (and comma-grouped) containment check, red before the fix / green after.
 */
describe('render-gate property — no unverified NUMBER ever reaches the Attention feed (MI-4 review fix)', () => {
  const AMBIGUOUS_AMOUNT = 7734562
  const PINNED_AMOUNT = 2_400_000
  const FABRICATED_SUPERSEDED_AMOUNT = 9_911_223 // the value the grounding check rejected — never verified
  const CLEAN_VERIFIED_AMOUNT = 3_100_000

  // Checks the raw digit run AND the comma-grouped rendering (toLocaleString, used by formatDeal) so a
  // reformatted-but-still-present figure can't slip past a naive contiguous-substring check.
  const containsValue = (text: string, n: number): boolean => text.includes(String(n)) || text.includes(n.toLocaleString())

  const baseDeal = (id: string, name: string, amount: DealEntity['amount']): DealEntity => ({
    schema_version: 2,
    id,
    aliases: [],
    name,
    account: 'Attention Gate Co',
    stage: 'negotiation',
    outcome: 'open',
    win_likelihood_band: null,
    band_evidence: '',
    velocity: { signal: 'no-hard-date-found', evidence: '' },
    amount,
    meetings: [],
    signals: [],
    missed_signals: [],
    commitments: [],
    feedback: []
  })

  let folder: string
  let s: Settings
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-attention-gate-'))
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
  it('Leak A: an AMBIGUOUS amount never puts its raw figure into the attention detail', async () => {
    const slug = slugify('Ambiguous Amount Deal')
    await writeDeal(
      s,
      slug,
      baseDeal(slug, 'Ambiguous Amount Deal', {
        value: { value: AMBIGUOUS_AMOUNT, currency: 'EUR' },
        source_file: 'm1.md',
        date: '2026-01-01',
        confidence: 'AMBIGUOUS',
        state: 'extracted',
        superseded: []
      })
    )

    const items = computeAttention(s)
    const ambiguous = items.find((i) => i.kind === 'ambiguous' && i.entityKind === 'deal' && i.id === slug)
    expect(ambiguous).toBeDefined()
    expect(containsValue(ambiguous!.detail, AMBIGUOUS_AMOUNT)).toBe(false)
    expect(ambiguous!.detail).not.toMatch(/\d/) // no digits at all — the whole figure is withheld
    expect(ambiguous!.detail).toContain('Amount')
  })

  it('Leak B: a pinned amount contradicted by a later FABRICATED superseded value never shows either figure', async () => {
    const slug = slugify('Contradicted Pin Deal')
    await writeDeal(
      s,
      slug,
      baseDeal(slug, 'Contradicted Pin Deal', {
        value: { value: PINNED_AMOUNT, currency: 'EUR' },
        source_file: '',
        date: '2026-01-01',
        confidence: 'EXTRACTED',
        state: 'pinned',
        superseded: [
          {
            value: { value: FABRICATED_SUPERSEDED_AMOUNT, currency: 'EUR' },
            date: '2030-01-01', // strictly after the pin's date — the newer contradicting sighting
            source_file: 'm2.md',
            confidence: 'AMBIGUOUS' // grounding check rejected it — fabricated, never independently verified
          }
        ]
      })
    )

    const items = computeAttention(s)
    const contradicted = items.find((i) => i.kind === 'contradicted_pin' && i.entityKind === 'deal' && i.id === slug)
    expect(contradicted).toBeDefined()
    expect(containsValue(contradicted!.detail, PINNED_AMOUNT)).toBe(false)
    expect(containsValue(contradicted!.detail, FABRICATED_SUPERSEDED_AMOUNT)).toBe(false)
    expect(contradicted!.detail).not.toMatch(/\d/)
    expect(contradicted!.detail.toLowerCase()).toContain('amount')
  })

  it('a genuinely verified, uncontradicted pinned amount produces NO attention item — and stays fully intact for legitimate display elsewhere (formatDeal)', async () => {
    const slug = slugify('Clean Verified Deal')
    await writeDeal(
      s,
      slug,
      baseDeal(slug, 'Clean Verified Deal', {
        value: { value: CLEAN_VERIFIED_AMOUNT, currency: 'EUR' },
        source_file: '',
        date: '2026-01-01',
        confidence: 'EXTRACTED',
        state: 'pinned',
        superseded: []
      })
    )

    const items = computeAttention(s)
    expect(items.filter((i) => i.entityKind === 'deal' && i.id === slug)).toEqual([]) // nothing contradicts it — not flagged

    // The redaction lives ONLY in the attention feed; every other reader of the record (money card,
    // Mars, formatDeal) still shows the real, legitimately-verified figure untouched.
    const stored = readDeal(s, slug)!
    expect(containsValue(formatDeal(stored), CLEAN_VERIFIED_AMOUNT)).toBe(true)
  })
})
