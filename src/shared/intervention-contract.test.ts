import { describe, expect, it } from 'vitest'
import {
  DEFAULT_INTERVENTION_THRESHOLDS,
  INTERVENTION_CLASSIFIER_TIMEOUT_MS,
  INTERVENTION_DUPLICATE_THRESHOLD,
  INTERVENTION_HELP_THRESHOLD,
  INTERVENTION_INPUT_MAX_UTF8_BYTES,
  INTERVENTION_MIN_REQUEST_INTERVAL_MS,
  INTERVENTION_PARTIAL_DEBOUNCE_MS,
  INTERVENTION_RESPONSE_THRESHOLD,
  InterventionError,
  assertSameScope,
  canonicalJson,
  clipUtf8,
  interventionDecisionSchema,
  interventionInputBytes,
  parseInterventionInput,
  utf8ByteLength,
  validateInterventionScores
} from './intervention-contract'

const SCOPE = { tenantId: 'synthetic-tenant', userId: 'synthetic-user', sessionId: 'synthetic-session' }
const code = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (error) {
    return error instanceof InterventionError ? error.code : `other:${String(error)}`
  }
  return undefined
}

const validInput = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  scope: SCOPE,
  generation: 1,
  contextRevision: 1,
  objective: 'Synthetic objective',
  finalMessages: [
    {
      streamId: 'microphone',
      streamEpoch: 1,
      utteranceId: 'synthetic-utterance-0',
      revision: 1,
      speakerId: 'YOU',
      text: 'Synthetic text'
    }
  ],
  liveFragment: '',
  currentCard: null,
  ...overrides
})

describe('named constants (guide values, ASSUMED/PROPOSED)', () => {
  it('pins the thresholds, timeout, interval, debounce and the single byte budget', () => {
    expect(INTERVENTION_RESPONSE_THRESHOLD).toBe(0.85)
    expect(INTERVENTION_HELP_THRESHOLD).toBe(0.9)
    expect(INTERVENTION_DUPLICATE_THRESHOLD).toBe(0.75)
    expect(INTERVENTION_CLASSIFIER_TIMEOUT_MS).toBe(3_000)
    expect(INTERVENTION_MIN_REQUEST_INTERVAL_MS).toBe(1_100)
    expect(INTERVENTION_PARTIAL_DEBOUNCE_MS).toBe(275)
    expect(INTERVENTION_INPUT_MAX_UTF8_BYTES).toBe(8_192)
    expect(DEFAULT_INTERVENTION_THRESHOLDS).toEqual({
      question: 0.85,
      objection: 0.85,
      hesitation: 0.9,
      decision: 0.85,
      shortHesitation: 0.7
    })
    expect(Object.isFrozen(DEFAULT_INTERVENTION_THRESHOLDS)).toBe(true)
  })
})

describe('byte helpers', () => {
  it('counts UTF-8 bytes, not string units, and clips on a code point boundary', () => {
    expect(utf8ByteLength('🙂')).toBe(4)
    expect('🙂'.length).toBe(2)
    const clipped = clipUtf8('a🙂🙂', 6)
    expect(clipped).toBe('a🙂')
    expect(clipped.includes('�')).toBe(false)
  })

  it('serializes with sorted keys so byte counts agree across processes', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
    expect(interventionInputBytes({ b: '🙂', a: 1 })).toBe(utf8ByteLength('{"a":1,"b":"🙂"}'))
  })
})

describe('scope', () => {
  it('requires all three fields to match, including the tenant', () => {
    expect(() => assertSameScope(SCOPE, { ...SCOPE })).not.toThrow()
    expect(code(() => assertSameScope(SCOPE, { ...SCOPE, tenantId: 'other-tenant' }))).toBe('SCOPE_MISMATCH')
    expect(code(() => assertSameScope(SCOPE, { userId: 'x', sessionId: 'y' }))).toBe('SCOPE_SHAPE')
  })
})

describe('parseInterventionInput (receiving side of the one byte budget)', () => {
  it('accepts a valid input and returns it', () => {
    expect(parseInterventionInput(validInput()).objective).toBe('Synthetic objective')
  })

  it('rejects extra keys at every level', () => {
    expect(code(() => parseInterventionInput(validInput({ answer: 'x' })))).toBe('INTERVENTION_INPUT')
    expect(code(() => parseInterventionInput(validInput({ scope: { ...SCOPE, extra: 'x' } })))).toBe(
      'INTERVENTION_INPUT'
    )
  })

  it('enforces per-field caps in UTF-8 bytes (not string length)', () => {
    // 129 four-byte code points are 516 bytes (258 string units): over the 512-byte cap.
    expect(code(() => parseInterventionInput(validInput({ objective: '🙂'.repeat(129) })))).toBe('INTERVENTION_INPUT')
    expect(() => parseInterventionInput(validInput({ objective: '🙂'.repeat(128) }))).not.toThrow()
    expect(code(() => parseInterventionInput(validInput({ liveFragment: 'x'.repeat(513) })))).toBe('INTERVENTION_INPUT')
    expect(
      code(() => parseInterventionInput(validInput({ currentCard: { id: 'card-1', text: 'x'.repeat(641) } })))
    ).toBe('INTERVENTION_INPUT')
  })

  it('rejects more than eight final messages', () => {
    const message = validInput().finalMessages[0]
    expect(code(() => parseInterventionInput(validInput({ finalMessages: Array(9).fill(message) })))).toBe(
      'INTERVENTION_INPUT'
    )
  })

  it('enforces the total byte budget and refuses an out-of-range configured budget', () => {
    const message = { ...validInput().finalMessages[0], text: 'x'.repeat(640) }
    const big = validInput({ finalMessages: Array(8).fill(message), objective: 'x'.repeat(512) })
    expect(interventionInputBytes(big)).toBeGreaterThan(5_000)
    expect(() => parseInterventionInput(big)).not.toThrow()
    expect(code(() => parseInterventionInput(big, 4_096))).toBe('INTERVENTION_BYTE_LIMIT')
    expect(code(() => parseInterventionInput(validInput(), 100))).toBe('INTERVENTION_BYTE_LIMIT')
    expect(code(() => parseInterventionInput(validInput(), 40_000))).toBe('INTERVENTION_BYTE_LIMIT')
  })
})

describe('validateInterventionScores', () => {
  const scores = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    scores: { question: 0, objection: 0, hesitation: 0, decision: 0, ...overrides }
  })

  it('accepts only the four declared scores in the closed 0..1 range', () => {
    expect(validateInterventionScores(scores({ question: 1, hesitation: 0.7 }))).toEqual({
      question: 1,
      objection: 0,
      hesitation: 0.7,
      decision: 0
    })
    for (const value of [-0.1, 1.1, '0.9', null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(code(() => validateInterventionScores(scores({ question: value })))).toBe('SCORE_RANGE')
    }
    expect(code(() => validateInterventionScores(scores({ executeDesktopAction: 1 })))).toBe('SCORE_SCHEMA')
    expect(code(() => validateInterventionScores({ ...scores(), answer: 'Unrequested' }))).toBe('SCORE_SCHEMA')
    expect(code(() => validateInterventionScores({ schemaVersion: 2, scores: scores().scores }))).toBe('SCORE_SCHEMA')
    expect(code(() => validateInterventionScores(null))).toBe('SCORE_SCHEMA')
  })

  it('returns a frozen copy', () => {
    expect(Object.isFrozen(validateInterventionScores(scores()))).toBe(true)
  })
})

describe('decision schema', () => {
  it('has no answer or action field and rejects extras', () => {
    const base = {
      stage: 'intervention-classification',
      status: 'held',
      shouldGenerate: false,
      reason: 'PARTIAL_NOT_STABLE',
      scope: SCOPE,
      generation: 1,
      contextRevision: 1
    }
    expect(interventionDecisionSchema.safeParse(base).success).toBe(true)
    expect(interventionDecisionSchema.safeParse({ ...base, answer: 'x' }).success).toBe(false)
    expect(interventionDecisionSchema.safeParse({ ...base, action: 'x' }).success).toBe(false)
  })
})
