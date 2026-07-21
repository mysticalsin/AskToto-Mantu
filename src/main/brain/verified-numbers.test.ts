import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import type { Settings } from '@shared/ipc'
import type { StreamHandlers, StreamOptions, StreamHandle } from '../llm/shared'
import { setSettings, setApiKey } from '../store'
import { MeetingExtractionSchema, type MeetingExtraction, type DealEntity } from '@shared/brain'
import { buildMarsWeek, renderMarsMarkdown } from '@shared/mars'
import {
  splitIntoWindows,
  combineWindowExtractions,
  verifyExtraction,
  mergeExtraction,
  enqueueIngest
} from './ingest'
import { readDeal, readMeetingExtraction, slugify } from './store'
import { formatDeal } from './context'

/**
 * Task MI-4 — the verified numbers lane. Three surfaces under test:
 *  1. splitIntoWindows / combineWindowExtractions — the windowed-extraction combiner (kills D2).
 *  2. verifyExtraction — post-parse, pre-merge demotion of fabricated numeric_facts/commitment quotes.
 *  3. mergeExtraction's deal amount/close_date/band merge, verification-gated.
 * Plus one true end-to-end proof (mocked createStream, real queue/pump/merge) that a fact stated only
 * in the FINAL window of a >24k transcript survives windowing all the way into the stored extraction.
 */

vi.mock('electron')

// Default: every completion resolves instantly with an empty-but-schema-valid extraction (every
// MeetingExtractionSchema field has a zod .default()) — matches ingest-progress.test.ts's own mock.
// Wrapped in vi.fn() so individual tests can override via mockImplementation/mockImplementationOnce.
vi.mock('../llm', () => ({
  createStream: vi.fn((opts: StreamOptions & { handlers: StreamHandlers }): StreamHandle => {
    queueMicrotask(() => {
      opts.handlers.onDelta('{}')
      opts.handlers.onDone({})
    })
    return { abort: () => {} }
  })
}))

describe('splitIntoWindows', () => {
  it('returns the text UNCHANGED (single-element array) at or under the threshold — byte-identical to the old single-slice behavior', () => {
    const short = 'hello world'
    expect(splitIntoWindows(short, 100, 10)).toEqual([short])
    const exact = 'x'.repeat(100)
    expect(splitIntoWindows(exact, 100, 10)).toEqual([exact])
  })

  it('splits text over the threshold at line boundaries, never truncating mid-line', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i} ${'y'.repeat(10)}`)
    const text = lines.join('\n')
    const windows = splitIntoWindows(text, 50, 5)
    expect(windows.length).toBeGreaterThan(1)
    for (const w of windows) {
      // every window is composed of whole lines from the original text — never a fragment of one
      for (const l of w.split('\n')) expect(lines.includes(l) || l === '').toBe(true)
    }
  })

  it('carries trailing context (overlap) from one window into the next', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `L${i}`.padEnd(10, '.'))
    const text = lines.join('\n')
    const windows = splitIntoWindows(text, 60, 20)
    expect(windows.length).toBeGreaterThan(1)
    // the last line of window[0] should reappear somewhere in window[1] (the overlap)
    const w0Lines = windows[0].split('\n')
    const lastOfW0 = w0Lines[w0Lines.length - 1]
    expect(windows[1].includes(lastOfW0)).toBe(true)
  })
})

describe('combineWindowExtractions', () => {
  const win = (overrides: Partial<MeetingExtraction>): MeetingExtraction => MeetingExtractionSchema.parse(overrides)

  it('a single window passes through unchanged', () => {
    const x = win({ title24: 'Solo window' })
    expect(combineWindowExtractions([x])).toBe(x)
  })

  it('anchors title/topics/sentiment/account on the first window with an EXTRACTED account, else the first non-null', () => {
    const w1 = win({ title24: 'w1', account: { name: 'Acme', sector: 'banking', sector_confidence: 'INFERRED', confidence: 'INFERRED' } })
    const w2 = win({ title24: 'w2', account: { name: 'Acme Corp', sector: 'banking', sector_confidence: 'EXTRACTED', confidence: 'EXTRACTED' } })
    const w3 = win({ title24: 'w3' })
    const combined = combineWindowExtractions([w1, w2, w3])
    expect(combined.title24).toBe('w2') // w2 is the first (and only) EXTRACTED account
    expect(combined.account?.name).toBe('Acme Corp')

    // No window has an EXTRACTED account: fall back to the first non-null account.
    const w1b = win({ title24: 'a', account: { name: 'Weak Co', sector: 'other', sector_confidence: 'INFERRED', confidence: 'INFERRED' } })
    const w2b = win({ title24: 'b' })
    const combined2 = combineWindowExtractions([w1b, w2b])
    expect(combined2.title24).toBe('a')
  })

  it('unions people/commitments/numeric_facts across windows, deduping repeats from the overlap region', () => {
    const w1 = win({
      people: [{ name: 'Sarah Chen', role: 'CFO', org: null, confidence: 'EXTRACTED' }],
      commitments: [{ text: 'send the deck', by: 'you', quote: 'I will send the deck', confidence: 'EXTRACTED' }],
      numeric_facts: [{ kind: 'amount', value: 100, unit: 'EUR', quote: 'we agreed on 100 EUR', confidence: 'EXTRACTED' }]
    })
    // w2 restates the SAME commitment/fact (they fell inside the window overlap) plus one genuinely new person.
    const w2 = win({
      people: [
        { name: 'Sarah Chen', role: 'CFO', org: null, confidence: 'EXTRACTED' },
        { name: 'James Walsh', role: 'IT', org: null, confidence: 'EXTRACTED' }
      ],
      commitments: [{ text: 'send the deck', by: 'you', quote: 'I will send the deck', confidence: 'EXTRACTED' }],
      numeric_facts: [{ kind: 'amount', value: 100, unit: 'EUR', quote: 'we agreed on 100 EUR', confidence: 'EXTRACTED' }]
    })
    const combined = combineWindowExtractions([w1, w2])
    expect(combined.people.map((p) => p.name)).toEqual(['Sarah Chen', 'James Walsh'])
    expect(combined.commitments).toHaveLength(1)
    expect(combined.numeric_facts).toHaveLength(1)
  })

  it('deal stage/band/velocity: the LAST window with a non-null value wins (meeting-final state)', () => {
    const w1 = win({ deal: { name: 'Big Deal', stage: 'discovery', win_likelihood_band: 'mixed', band_evidence: 'early signal', velocity: { signal: 'no-hard-date-found', evidence: '' } } })
    const w2 = win({ deal: { name: '', stage: '', win_likelihood_band: null, band_evidence: '', velocity: { signal: 'no-hard-date-found', evidence: '' } } })
    const w3 = win({ deal: { name: '', stage: 'negotiation', win_likelihood_band: 'good', band_evidence: 'final signal', velocity: { signal: 'hard-calendar-gate', evidence: 'closes Friday' } } })
    const combined = combineWindowExtractions([w1, w2, w3])
    expect(combined.deal?.name).toBe('Big Deal') // identity from the first window that names it
    expect(combined.deal?.stage).toBe('negotiation') // w3's non-null value is the LAST one — wins
    expect(combined.deal?.win_likelihood_band).toBe('good')
    expect(combined.deal?.band_evidence).toBe('final signal')
    expect(combined.deal?.velocity).toEqual({ signal: 'hard-calendar-gate', evidence: 'closes Friday' })
  })

  it('a deal null in every window stays null', () => {
    const combined = combineWindowExtractions([win({}), win({})])
    expect(combined.deal).toBeNull()
  })
})

describe('verifyExtraction — fabricated-quote demotion (TDD: red against pre-verification code)', () => {
  const transcript = 'Them: The total contract value comes in at 2.4M EUR for the first phase, we confirmed.'

  it('a numeric_fact whose quote is genuinely in the transcript keeps its confidence', () => {
    const x = MeetingExtractionSchema.parse({
      numeric_facts: [{ kind: 'amount', value: 2_400_000, unit: 'EUR', quote: 'the total contract value comes in at 2.4M EUR', confidence: 'EXTRACTED' }]
    })
    const verified = verifyExtraction(x, transcript)
    expect(verified.numeric_facts[0].confidence).toBe('EXTRACTED')
  })

  it('a FABRICATED numeric_fact quote (never said in the prepared text) is demoted to AMBIGUOUS, not stripped', () => {
    const x = MeetingExtractionSchema.parse({
      numeric_facts: [{ kind: 'amount', value: 9_999_999, unit: 'EUR', quote: 'we agreed on nine point nine nine nine million', confidence: 'EXTRACTED' }]
    })
    const verified = verifyExtraction(x, transcript)
    expect(verified.numeric_facts).toHaveLength(1) // quarantined, never dropped
    expect(verified.numeric_facts[0].confidence).toBe('AMBIGUOUS')
    expect(verified.numeric_facts[0].value).toBe(9_999_999) // value/quote retained verbatim
    expect(verified.numeric_facts[0].quote).toBe('we agreed on nine point nine nine nine million')
  })

  it('a real quote but a value that drifted from what was actually said is demoted', () => {
    const x = MeetingExtractionSchema.parse({
      numeric_facts: [{ kind: 'amount', value: 3_000_000, unit: 'EUR', quote: 'the total contract value comes in at 2.4M EUR', confidence: 'EXTRACTED' }]
    })
    expect(verifyExtraction(x, transcript).numeric_facts[0].confidence).toBe('AMBIGUOUS')
  })

  it('a fabricated COMMITMENT quote is demoted to AMBIGUOUS; a genuine one is untouched; an empty quote (paraphrase-only) is untouched', () => {
    const x = MeetingExtractionSchema.parse({
      commitments: [
        { text: 'send the pack', by: 'you', quote: 'I will send the updated pack over', confidence: 'EXTRACTED' }, // fabricated
        { text: 'confirm the value', by: 'you', quote: 'we confirmed', confidence: 'EXTRACTED' }, // genuine (matches transcript)
        { text: 'intro Claire', by: 'you', quote: '', confidence: 'INFERRED' } // paraphrase-only
      ]
    })
    const verified = verifyExtraction(x, transcript)
    expect(verified.commitments).toHaveLength(3) // never dropped
    expect(verified.commitments[0].confidence).toBe('AMBIGUOUS')
    expect(verified.commitments[1].confidence).toBe('EXTRACTED')
    expect(verified.commitments[2].confidence).toBe('INFERRED') // untouched — nothing to verify
  })

  it('never verifies a quote against a language-switch marker (renderer prose, not speech)', () => {
    const marked = 'Them: Vamos fechar o contrato.\n_[conversation switches to English]_\nThem: About the budget.'
    const x = MeetingExtractionSchema.parse({
      commitments: [
        // Quote lifted verbatim from the marker paragraph — grounding must refuse it.
        { text: 'switch languages', by: 'them', quote: 'conversation switches to English', confidence: 'EXTRACTED' },
        // A genuine spoken quote from the same transcript still verifies.
        { text: 'close the contract', by: 'them', quote: 'Vamos fechar o contrato', confidence: 'EXTRACTED' }
      ]
    })
    const verified = verifyExtraction(x, marked)
    expect(verified.commitments[0].confidence).toBe('AMBIGUOUS')
    expect(verified.commitments[1].confidence).toBe('EXTRACTED')
  })
})

describe('mergeExtraction — deal amount/close_date/band, verification-gated (Task MI-4)', () => {
  let folder: string
  let s: Settings
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-verified-numbers-'))
    s = { meetingsFolder: folder } as Settings
  })
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

  const dealExtraction = (overrides: Partial<NonNullable<MeetingExtraction['deal']>>): MeetingExtraction =>
    MeetingExtractionSchema.parse({
      account: { name: 'Acme Bank', sector: 'banking', confidence: 'EXTRACTED' },
      deal: {
        name: 'Acme Core Banking',
        stage: 'negotiation',
        velocity: { signal: 'no-hard-date-found', evidence: '' },
        ...overrides
      }
    })

  it('a verified amount lands in state "verified" with EXTRACTED confidence', async () => {
    const transcript = 'Them: the total contract value comes in at 2.4M EUR for the first phase.'
    const x = dealExtraction({ amount: { value: 2_400_000, currency: 'EUR', quote: 'the total contract value comes in at 2.4M EUR' } })
    await mergeExtraction(s, x, { file: 'm1.md', date: '2026-01-01', title: 't' }, undefined, transcript)
    const deal = readDeal(s, slugify('Acme Core Banking'))!
    expect(deal.amount?.state).toBe('verified')
    expect(deal.amount?.confidence).toBe('EXTRACTED')
    expect(deal.amount?.value).toEqual({ value: 2_400_000, currency: 'EUR' })
  })

  it('an amount whose quote never appears in the prepared text lands in state "extracted" with AMBIGUOUS confidence — never stripped', async () => {
    const transcript = 'Them: we are still finalizing scope, nothing about money yet.'
    const x = dealExtraction({ amount: { value: 2_400_000, currency: 'EUR', quote: 'the total contract value comes in at 2.4M EUR' } })
    await mergeExtraction(s, x, { file: 'm1.md', date: '2026-01-01', title: 't' }, undefined, transcript)
    const deal = readDeal(s, slugify('Acme Core Banking'))!
    expect(deal.amount?.state).toBe('extracted')
    expect(deal.amount?.confidence).toBe('AMBIGUOUS')
    expect(deal.amount?.value).toEqual({ value: 2_400_000, currency: 'EUR' }) // quarantined, not dropped
  })

  it('a verified close_date lands in state "verified"; an unverified one lands "extracted"/AMBIGUOUS', async () => {
    const transcript = 'Them: we are targeting a close date of 2026-09-30 for this deal.'
    const good = dealExtraction({ close_date: { value: '2026-09-30', quote: 'a close date of 2026-09-30' } })
    await mergeExtraction(s, good, { file: 'm1.md', date: '2026-01-01', title: 't' }, undefined, transcript)
    const dealGood = readDeal(s, slugify('Acme Core Banking'))!
    expect(dealGood.close_date?.state).toBe('verified')
    expect(dealGood.close_date?.confidence).toBe('EXTRACTED')

    const folder2 = mkdtempSync(join(tmpdir(), 'asktoto-verified-numbers-2-'))
    try {
      const s2 = { meetingsFolder: folder2 } as Settings
      const bad = dealExtraction({ close_date: { value: '2026-09-30', quote: 'a close date of 2026-09-30' } })
      await mergeExtraction(s2, bad, { file: 'm1.md', date: '2026-01-01', title: 't' }, undefined, 'Them: nothing about dates was discussed today.')
      const dealBad = readDeal(s2, slugify('Acme Core Banking'))!
      expect(dealBad.close_date?.state).toBe('extracted')
      expect(dealBad.close_date?.confidence).toBe('AMBIGUOUS')
    } finally {
      rmSync(folder2, { recursive: true, force: true })
    }
  })

  it('band_evidence and close_date never verify against a language-switch marker (renderer prose)', async () => {
    // The saved-transcript marker paragraph, verbatim — the grounding reference must refuse alignment
    // against it in EVERY check, not only verifyExtraction/verifyDealAmount (re-review finding).
    const transcript =
      'Them: Vamos fechar em setembro.\n\n_[conversation switches to English]_\n\n**[09:00:02] Them:** ok.'
    const x = dealExtraction({
      win_likelihood_band: 'good',
      band_evidence: 'conversation switches to English',
      close_date: { value: '2026-09-30', quote: 'conversation switches to English' }
    })
    await mergeExtraction(s, x, { file: 'm1.md', date: '2026-01-01', title: 't' }, undefined, transcript)
    const deal = readDeal(s, slugify('Acme Core Banking'))!
    expect(deal.win_likelihood_band_provenance?.confidence).toBe('AMBIGUOUS')
    expect(deal.close_date?.state).toBe('extracted')
    expect(deal.close_date?.confidence).toBe('AMBIGUOUS')
  })

  it('band_evidence confidence is computed from alignment when preparedText is supplied, and stays the old hardcoded EXTRACTED when omitted (backward compat)', async () => {
    const x = dealExtraction({ win_likelihood_band: 'concerning', band_evidence: 'a fabricated evidence string never actually said' })
    await mergeExtraction(s, x, { file: 'm1.md', date: '2026-01-01', title: 't' }, undefined, 'Them: totally unrelated content about scheduling.')
    const deal = readDeal(s, slugify('Acme Core Banking'))!
    expect(deal.win_likelihood_band_provenance?.confidence).toBe('AMBIGUOUS')

    const folder2 = mkdtempSync(join(tmpdir(), 'asktoto-verified-numbers-band-'))
    try {
      const s2 = { meetingsFolder: folder2 } as Settings
      const x2 = dealExtraction({ win_likelihood_band: 'concerning', band_evidence: 'a fabricated evidence string never actually said' })
      await mergeExtraction(s2, x2, { file: 'm1.md', date: '2026-01-01', title: 't' }) // preparedText omitted — legacy behavior
      const deal2 = readDeal(s2, slugify('Acme Core Banking'))!
      expect(deal2.win_likelihood_band_provenance?.confidence).toBe('EXTRACTED')
    } finally {
      rmSync(folder2, { recursive: true, force: true })
    }
  })
})

describe('windowed extraction end-to-end (Task MI-4, kills D2 — mocked createStream, real queue/pump/merge)', () => {
  let userData: string
  let meetingsFolder: string

  const waitForStoredExtraction = async (file: string): Promise<void> => {
    await vi.waitFor(() => {
      expect(readMeetingExtraction({ meetingsFolder } as Settings, slugify(basename(file)))).not.toBeNull()
    })
  }

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'asktoto-d2-userdata-'))
    meetingsFolder = mkdtempSync(join(tmpdir(), 'asktoto-d2-meetings-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'userData') return userData
      return join(userData, name)
    })
    setSettings({ meetingsFolder })
    setApiKey('anthropic', 'fake-test-key-not-real')
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
    rmSync(meetingsFolder, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const FINAL_COMMITMENT_QUOTE = 'Sarah: I will send you the updated security pack by Friday, as promised.'

  function buildOversizedTranscript(): string {
    const filler = (label: string, n: number): string =>
      Array.from({ length: n }, (_, i) => `${label}-${i}: We discussed routine agenda item number ${i} in today's call.`).join('\n')
    const part1 = filler('P1', 420) // comfortably over 24000 chars on its own
    const part2 = filler('P2', 420) // pushes well past a second window's worth
    const part3tail = filler('P3', 30)
    const body = [part1, part2, FINAL_COMMITMENT_QUOTE, part3tail].join('\n')
    return `---\ndate: 2026-04-01\n---\n${body}`
  }

  it('a commitment stated only in the FINAL third of a >24k transcript survives windowing into the stored extraction', async () => {
    const transcript = buildOversizedTranscript()
    expect(transcript.length).toBeGreaterThan(48000) // sanity: guarantees at least 2 windows at the 24k/1k defaults

    const { createStream } = await import('../llm')
    vi.mocked(createStream).mockImplementation((opts: StreamOptions & { handlers: StreamHandlers }): StreamHandle => {
      const prompt = (opts.req as { prompt?: string })?.prompt ?? ''
      const hasCommitment = prompt.includes('security pack')
      const payload = hasCommitment
        ? {
            commitments: [
              { text: 'send the updated security pack', by: 'Sarah Chen', quote: FINAL_COMMITMENT_QUOTE, confidence: 'EXTRACTED' }
            ]
          }
        : {}
      queueMicrotask(() => {
        opts.handlers.onDelta(JSON.stringify(payload))
        opts.handlers.onDone({})
      })
      return { abort: () => {} }
    })

    const file = join(meetingsFolder, 'big-meeting.md')
    writeFileSync(file, transcript, 'utf8')
    const callsBefore = vi.mocked(createStream).mock.calls.length
    enqueueIngest(file)
    await waitForStoredExtraction(file)

    expect(vi.mocked(createStream).mock.calls.length - callsBefore).toBeGreaterThan(1) // proves windowing actually ran multiple completion calls

    const stored = readMeetingExtraction({ meetingsFolder } as Settings, slugify(basename(file)))
    expect(stored).not.toBeNull()
    expect(stored!.commitments.some((c) => c.text.toLowerCase().includes('security pack'))).toBe(true)
  })

  it('a ≤24k transcript still drives exactly ONE completion call with the full text — byte-identical to the pre-windowing single-slice path', async () => {
    const transcript = '---\ndate: 2026-01-01\n---\nSarah: Hello there.\nJames: Good morning, thanks for joining.'
    expect(transcript.length).toBeLessThan(24000)

    const { createStream } = await import('../llm')
    const seenPrompts: string[] = []
    vi.mocked(createStream).mockImplementation((opts: StreamOptions & { handlers: StreamHandlers }): StreamHandle => {
      seenPrompts.push((opts.req as { prompt?: string })?.prompt ?? '')
      queueMicrotask(() => {
        opts.handlers.onDelta('{}')
        opts.handlers.onDone({})
      })
      return { abort: () => {} }
    })

    const file = join(meetingsFolder, 'short-meeting.md')
    writeFileSync(file, transcript, 'utf8')
    enqueueIngest(file)
    await waitForStoredExtraction(file)

    expect(seenPrompts).toHaveLength(1) // exactly one completion call — no windowing overhead below the threshold
    const expectedPrompt = `Meeting transcript (file: ${basename(file)}):\n\n"""\n${transcript}\n"""`
    expect(seenPrompts[0]).toBe(expectedPrompt) // byte-identical to today's (pre-MI-4) single-slice prompt format
  })
})

describe('render-gate property — no unverified figure ever shown (Task MI-4 headline CI gate)', () => {
  // A distinctive value unlikely to collide with anything else the fixture happens to render (dates,
  // counts, etc.) — makes "does this digit-substring appear ANYWHERE in the output" an unambiguous check.
  const DISTINCTIVE_AMOUNT = 7734562

  function dealWithAmount(state: 'extracted' | 'verified' | 'pinned' | 'edited'): DealEntity {
    return {
      schema_version: 2,
      id: 'render-gate-deal',
      aliases: [],
      name: 'Render Gate Deal',
      account: 'Render Gate Co',
      stage: 'negotiation',
      outcome: 'open',
      win_likelihood_band: null,
      band_evidence: '',
      velocity: { signal: 'no-hard-date-found', evidence: '' },
      amount: {
        value: { value: DISTINCTIVE_AMOUNT, currency: 'EUR' },
        source_file: 'm1.md',
        date: '2026-01-01',
        confidence: state === 'extracted' ? 'AMBIGUOUS' : 'EXTRACTED',
        state,
        superseded: []
      },
      meetings: [],
      signals: [],
      missed_signals: [],
      commitments: [],
      feedback: []
    }
  }

  // Checks the raw digit run AND the comma-grouped rendering (toLocaleString inserts thousands commas,
  // which would otherwise defeat a naive contiguous-substring check by breaking the digits apart).
  const containsDistinctiveValue = (text: string): boolean =>
    text.includes(String(DISTINCTIVE_AMOUNT)) || text.includes(DISTINCTIVE_AMOUNT.toLocaleString())

  it('an unverified (AMBIGUOUS/extracted) amount never appears in formatDeal or the rendered Mars markdown; pinning it makes it appear', () => {
    const unverified = dealWithAmount('extracted')
    expect(containsDistinctiveValue(formatDeal(unverified))).toBe(false)
    const weekUnverified = buildMarsWeek([], [unverified], Date.now())
    expect(containsDistinctiveValue(renderMarsMarkdown(weekUnverified))).toBe(false)
    expect(weekUnverified.pipelineValue).toEqual([]) // no qualifying amount — the line itself is omitted

    const pinned = dealWithAmount('pinned')
    expect(containsDistinctiveValue(formatDeal(pinned))).toBe(true)
    const weekPinned = buildMarsWeek([], [pinned], Date.now())
    expect(containsDistinctiveValue(renderMarsMarkdown(weekPinned))).toBe(true)
    expect(weekPinned.pipelineValue).toEqual([{ currency: 'EUR', total: DISTINCTIVE_AMOUNT }])
  })

  it('verified and edited states also render (the full renderable set, not just pinned)', () => {
    for (const state of ['verified', 'edited'] as const) {
      const deal = dealWithAmount(state)
      expect(containsDistinctiveValue(formatDeal(deal))).toBe(true)
      expect(containsDistinctiveValue(renderMarsMarkdown(buildMarsWeek([], [deal], Date.now())))).toBe(true)
    }
  })
})
