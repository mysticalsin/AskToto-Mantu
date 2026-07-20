import { describe, expect, it } from 'vitest'
import { MeetingExtractionSchema, classifyMeetingSourceUse } from './brain'
import {
  BRAIN_ANALYZE_DISCLOSURE,
  BrainAnalyzeRequestSchema,
  BrainAnalyzeResultSchema
} from './brain-analyze'

const MODEL_SHA = 'a'.repeat(64)
const TRANSCRIPT_ID = 'b'.repeat(64)
const DERIVED_ID = 'c'.repeat(64)

describe('BrainAnalyzeRequestSchema', () => {
  it.each([
    ['briefing', { kind: 'brain' }],
    ['account-summary', { kind: 'account', id: 'acme' }],
    ['deal-summary', { kind: 'deal', id: 'renewal' }],
    ['meeting-summary', { kind: 'meeting', id: 'meeting.md' }]
  ])('accepts %s only with its matching scope', (task, scope) => {
    expect(BrainAnalyzeRequestSchema.safeParse({ version: 1, task, scope, language: 'en' }).success).toBe(true)
  })

  it('rejects mismatched scopes, wrong versions, oversized IDs, and extra keys', () => {
    expect(
      BrainAnalyzeRequestSchema.safeParse({
        version: 1,
        task: 'account-summary',
        scope: { kind: 'deal', id: 'x' },
        language: 'en'
      }).success
    ).toBe(false)
    expect(
      BrainAnalyzeRequestSchema.safeParse({ version: 2, task: 'briefing', scope: { kind: 'brain' }, language: 'en' })
        .success
    ).toBe(false)
    expect(
      BrainAnalyzeRequestSchema.safeParse({
        version: 1,
        task: 'account-summary',
        scope: { kind: 'account', id: 'x'.repeat(201) },
        language: 'en'
      }).success
    ).toBe(false)
    expect(
      BrainAnalyzeRequestSchema.safeParse({
        version: 1,
        task: 'briefing',
        scope: { kind: 'brain' },
        language: 'en',
        extra: true
      }).success
    ).toBe(false)
  })

  it('accepts a 1..500 character question against every typed scope', () => {
    const scopes = [
      { kind: 'brain' },
      { kind: 'account', id: 'acme' },
      { kind: 'deal', id: 'renewal' },
      { kind: 'meeting', id: 'meeting.md' }
    ]
    for (const scope of scopes) {
      expect(
        BrainAnalyzeRequestSchema.safeParse({ version: 1, task: 'question', scope, question: 'x'.repeat(500), language: 'fr' })
          .success
      ).toBe(true)
    }
    const base = { version: 1, task: 'question', scope: { kind: 'brain' }, language: 'en' }
    expect(BrainAnalyzeRequestSchema.safeParse({ ...base, question: '' }).success).toBe(false)
    expect(BrainAnalyzeRequestSchema.safeParse({ ...base, question: 'x'.repeat(501) }).success).toBe(false)
    expect(BrainAnalyzeRequestSchema.safeParse({ ...base, question: 'why', language: 'de' }).success).toBe(false)
  })
})

const transcriptEvidence = (overrides: Record<string, unknown> = {}) => ({
  id: TRANSCRIPT_ID,
  grounding: 'transcript',
  file: 'meeting.md',
  lineStart: 10,
  lineEnd: 12,
  quote: 'We are expanding scope.',
  ...overrides
})

const derivedEvidence = (overrides: Record<string, unknown> = {}) => ({
  id: DERIVED_ID,
  grounding: 'derived',
  file: 'meeting.md',
  lineStart: null,
  lineEnd: null,
  quote: '',
  derivedText: 'Scope expansion appears in the derived extraction.',
  ...overrides
})

const result = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  status: 'ok',
  disclosure: BRAIN_ANALYZE_DISCLOSURE,
  answer: 'The account expanded scope.',
  points: [{ text: 'Scope expanded.', evidenceIds: [TRANSCRIPT_ID] }],
  evidence: [transcriptEvidence()],
  model: { id: 'qwen3-1.7b', sha256: MODEL_SHA },
  timing: { loadMs: 0, prefillMs: 12, generateMs: 340, totalMs: 352 },
  ...overrides
})

describe('BrainAnalyzeResultSchema', () => {
  it.each(['ok', 'insufficient-evidence', 'blocked'])('accepts the %s status and exact disclosure', (status) => {
    const empty = status === 'ok' ? {} : { answer: '', points: [], evidence: [] }
    expect(BrainAnalyzeResultSchema.safeParse(result({ status, ...empty })).success).toBe(true)
    expect(BrainAnalyzeResultSchema.safeParse(result({ disclosure: 'AI output' })).success).toBe(false)
    expect(BRAIN_ANALYZE_DISCLOSURE).toBe('Local AI-generated analysis. Verify against cited meetings.')
  })

  it('enforces answer, point, evidence, model, timing, and lowercase-hash bounds', () => {
    expect(BrainAnalyzeResultSchema.safeParse(result({ answer: 'x'.repeat(4001) })).success).toBe(false)
    expect(
      BrainAnalyzeResultSchema.safeParse(result({ points: Array.from({ length: 51 }, () => ({ text: 'x', evidenceIds: [TRANSCRIPT_ID] })) })).success
    ).toBe(false)
    const tooMuchEvidence = Array.from({ length: 101 }, (_, index) =>
      transcriptEvidence({ id: index.toString(16).padStart(64, '0') })
    )
    expect(
      BrainAnalyzeResultSchema.safeParse(
        result({
          evidence: tooMuchEvidence,
          points: [{ text: 'x', evidenceIds: [tooMuchEvidence[0].id] }]
        })
      ).success
    ).toBe(false)
    expect(BrainAnalyzeResultSchema.safeParse(result({ model: { id: 'qwen', sha256: 'bad' } })).success).toBe(false)
    expect(
      BrainAnalyzeResultSchema.safeParse(result({ timing: { loadMs: -1, prefillMs: 1, generateMs: 1, totalMs: 1 } })).success
    ).toBe(false)
    expect(BrainAnalyzeResultSchema.safeParse(result({ evidence: [transcriptEvidence({ id: 'A'.repeat(64) })] })).success).toBe(false)
  })

  it('requires valid transcript ranges/quotes and derived null ranges/empty quotes', () => {
    expect(BrainAnalyzeResultSchema.safeParse(result({ evidence: [transcriptEvidence({ lineStart: 0 })] })).success).toBe(false)
    expect(
      BrainAnalyzeResultSchema.safeParse(result({ evidence: [transcriptEvidence({ lineStart: 5, lineEnd: 4 })] })).success
    ).toBe(false)
    expect(BrainAnalyzeResultSchema.safeParse(result({ evidence: [transcriptEvidence({ quote: '' })] })).success).toBe(false)
    expect(
      BrainAnalyzeResultSchema.safeParse(
        result({ evidence: [derivedEvidence()], points: [{ text: 'Derived.', evidenceIds: [DERIVED_ID] }] })
      ).success
    ).toBe(true)
    expect(
      BrainAnalyzeResultSchema.safeParse(
        result({ evidence: [derivedEvidence({ quote: 'not verbatim' })], points: [{ text: 'x', evidenceIds: [DERIVED_ID] }] })
      ).success
    ).toBe(false)
  })

  it('rejects duplicate/dangling evidence IDs and duplicate point IDs', () => {
    expect(
      BrainAnalyzeResultSchema.safeParse(result({ points: [{ text: 'x', evidenceIds: ['d'.repeat(64)] }] })).success
    ).toBe(false)
    expect(BrainAnalyzeResultSchema.safeParse(result({ evidence: [transcriptEvidence(), transcriptEvidence()] })).success).toBe(false)
    expect(
      BrainAnalyzeResultSchema.safeParse(result({ points: [{ text: 'x', evidenceIds: [TRANSCRIPT_ID, TRANSCRIPT_ID] }] })).success
    ).toBe(false)
  })
})

describe('meeting source provenance', () => {
  it('defaults legacy extractions to empty/unknown', () => {
    const parsed = MeetingExtractionSchema.parse({})
    expect(parsed.source_mode).toBe('')
    expect(parsed.source_use).toBe('unknown')
  })

  it('classifies only built-in modes and never content', () => {
    expect(classifyMeetingSourceUse('interview')).toBe('employment')
    for (const mode of ['general', 'meeting', 'sales', 'negotiation', 'presentation', 'support']) {
      expect(classifyMeetingSourceUse(mode)).toBe('eligible')
    }
    expect(classifyMeetingSourceUse('custom-sales')).toBe('unknown')
    expect(classifyMeetingSourceUse('Interview')).toBe('unknown')
    expect(classifyMeetingSourceUse('interview-notes-about-sales')).toBe('unknown')
  })
})
