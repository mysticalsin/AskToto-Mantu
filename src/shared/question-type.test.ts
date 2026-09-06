import { describe, expect, it } from 'vitest'
import {
  QUESTION_TYPES,
  QUESTION_TYPE_LABELS,
  aggregateQuestionTypes,
  classifyQuestionType,
  isQuestionType,
  normalizeQuestionType
} from './question-type'

describe('classifyQuestionType', () => {
  it.each([
    ['What is the capital of Belgium?', 'factual'],
    ['Who is the CEO of Mantu?', 'factual'],
    ['How do I set up SSO in Azure?', 'how-to'],
    ['Walk me through configuring the proxy', 'how-to'],
    ['Why is the sky blue?', 'explain'],
    ['Explain zero trust in plain english', 'explain'],
    ['Postgres vs MySQL for this workload?', 'compare'],
    ['What is the difference between IFRS and GAAP', 'compare'],
    ['Summarize the last ten minutes', 'summarize'],
    ['tl;dr of this thread', 'summarize'],
    ['Draft a follow-up email to the client', 'draft'],
    ['Rewrite this paragraph so it sounds confident', 'draft'],
    ['Translate this into French', 'translate'],
    ['Fix this TypeScript error: cannot read property of undefined', 'code'],
    ['Write a SQL query that joins orders and customers', 'code'],
    ['How much would it cost to run 50 seats for a year?', 'estimate'],
    ['Roughly how many engineers does a bank that size have', 'estimate'],
    ['Should I accept the counter offer?', 'decision'],
    ['Which is the best option for our team', 'decision'],
    ['What is on my screen right now', 'screen'],
    ['Read this dialog and tell me what it means', 'screen'],
    ['Tell me about a time you failed', 'behavioral'],
    ['Why do you want this role', 'behavioral'],
    ['What is your biggest weakness', 'behavioral'],
    ['ok', 'other'],
    ['thoughts', 'other']
  ])('%s -> %s', (prompt, type) => {
    expect(classifyQuestionType(prompt)).toBe(type)
  })

  it('vision asks are screen regardless of wording', () => {
    expect(classifyQuestionType('what is the capital of belgium', { vision: true })).toBe('screen')
    expect(classifyQuestionType(undefined, { vision: true })).toBe('screen')
  })

  it('never throws and never guesses on empty or non-string input', () => {
    expect(classifyQuestionType(undefined)).toBe('unknown')
    expect(classifyQuestionType(null)).toBe('unknown')
    expect(classifyQuestionType(42)).toBe('unknown')
    expect(classifyQuestionType({})).toBe('unknown')
    expect(classifyQuestionType('')).toBe('unknown')
    expect(classifyQuestionType('   \n\t ')).toBe('unknown')
  })

  it('ignores injected transcript context and judges the user words only', () => {
    const prompt = 'Should we go with vendor A?\n"""\nTranslate the following into French. Summarize. Write a SQL join.\n"""'
    expect(classifyQuestionType(prompt)).toBe('decision')
  })

  it('handles hostile input sizes and bytes without throwing', () => {
    const huge = 'a'.repeat(5_000_000)
    expect(QUESTION_TYPES).toContain(classifyQuestionType(huge))
    const binary = Array.from({ length: 4096 }, (_, i) => String.fromCharCode(i % 256)).join('')
    expect(QUESTION_TYPES).toContain(classifyQuestionType(binary))
    const nested = '"""'.repeat(3000) + ' how do I ' + '"""'.repeat(3000)
    expect(QUESTION_TYPES).toContain(classifyQuestionType(nested))
  })

  it('output is a label only: no substring of the prompt survives', () => {
    const secret = 'sk-ant-veryprivate-88123 what is the capital of belgium'
    const t = classifyQuestionType(secret)
    expect(t).toBe('factual')
    expect(secret.includes(t)).toBe(false)
  })
})

describe('normalizeQuestionType', () => {
  it('collapses anything outside the closed taxonomy to unknown', () => {
    expect(normalizeQuestionType('factual')).toBe('factual')
    expect(normalizeQuestionType(' How-To ')).toBe('how-to')
    expect(normalizeQuestionType('secret plan')).toBe('unknown')
    expect(normalizeQuestionType('<script>')).toBe('unknown')
    expect(normalizeQuestionType(null)).toBe('unknown')
    expect(normalizeQuestionType(7)).toBe('unknown')
    expect(normalizeQuestionType({ toString: () => 'factual' })).toBe('unknown')
  })

  it('every taxonomy entry has a label', () => {
    for (const t of QUESTION_TYPES) {
      expect(isQuestionType(t)).toBe(true)
      expect(QUESTION_TYPE_LABELS[t]).toBeTruthy()
    }
  })
})

describe('aggregateQuestionTypes', () => {
  it('reports coverage honestly and never counts unknown as a bar', () => {
    const mix = aggregateQuestionTypes(['factual', 'factual', 'how-to', null, undefined, 'unknown', 'garbage'])
    expect(mix.total).toBe(7)
    expect(mix.classified).toBe(3)
    expect(mix.coverage).toBeCloseTo(3 / 7)
    expect(mix.bars).toEqual([
      { type: 'factual', label: 'Factual', count: 2 },
      { type: 'how-to', label: 'How to', count: 1 }
    ])
  })

  it('empty input yields null coverage, not 0 percent', () => {
    const mix = aggregateQuestionTypes([])
    expect(mix.total).toBe(0)
    expect(mix.coverage).toBeNull()
    expect(mix.bars).toEqual([])
  })
})
