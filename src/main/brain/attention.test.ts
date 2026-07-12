import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Settings } from '@shared/ipc'
import { MeetingExtractionSchema } from '@shared/brain'
import { ingestExtraction } from './ingest'
import { updateEntityField } from './corrections'
import { slugify, setDealOutcome, readMeetingExtraction } from './store'
import { computeAttention } from './attention'

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
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

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
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

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
