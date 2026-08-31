import { describe, expect, it } from 'vitest'
import {
  ANSWER_FIRST_RAIL,
  AnswerFirstFilter,
  stripLeadingFiller,
  stripRestatedQuestion,
  wordCount
} from './answer-first'

describe('ANSWER_FIRST_RAIL', () => {
  it('forbids the politeness openers Tony called out, with no em dash', () => {
    expect(ANSWER_FIRST_RAIL).toMatch(/ANSWER FIRST/)
    expect(ANSWER_FIRST_RAIL).toMatch(/Sure/)
    expect(ANSWER_FIRST_RAIL).toMatch(/Let's/)
    expect(ANSWER_FIRST_RAIL).toMatch(/restate the question/)
    expect(ANSWER_FIRST_RAIL).not.toMatch(/—/)
    expect(ANSWER_FIRST_RAIL).not.toMatch(/\bAI\b/)
  })
})

describe('stripLeadingFiller', () => {
  it('drops Sure / Of course / Let me / Let\'s openers', () => {
    expect(stripLeadingFiller('Sure, 68')).toBe('68')
    expect(stripLeadingFiller('Sure. 68')).toBe('68')
    expect(stripLeadingFiller('Of course, use the 4B.')).toBe('use the 4B.')
    expect(stripLeadingFiller("Let's look at the numbers.\n42")).toBe('42')
    expect(stripLeadingFiller('Let me explain. Ship Friday.')).toBe('Ship Friday.')
    expect(stripLeadingFiller('Great question! Paris.')).toBe('Paris.')
    expect(stripLeadingFiller("Here's the answer: 12")).toBe('12')
  })

  it('is idempotent and leaves a clean answer alone', () => {
    expect(stripLeadingFiller('68')).toBe('68')
    expect(stripLeadingFiller('Ship the 4B on Friday.')).toBe('Ship the 4B on Friday.')
    expect(stripLeadingFiller(stripLeadingFiller('Sure, 68'))).toBe('68')
  })

  it('does not strip a later sure that is part of the answer', () => {
    expect(stripLeadingFiller('I am not sure about the date.')).toBe('I am not sure about the date.')
  })

  it('strips a restated question when one is supplied', () => {
    expect(stripLeadingFiller('What is 17 times 4? 68', 'What is 17 times 4?')).toBe('68')
  })
})

describe('stripRestatedQuestion', () => {
  it('drops a first sentence that echoes the question', () => {
    expect(stripRestatedQuestion('What is the capital of France? Paris.', 'What is the capital of France?')).toBe(
      'Paris.'
    )
  })

  it('leaves a short or unrelated first sentence', () => {
    expect(stripRestatedQuestion('Paris.', 'What is the capital of France?')).toBe('Paris.')
    expect(stripRestatedQuestion('No.', 'ok')).toBe('No.')
  })
})

describe('AnswerFirstFilter — streaming', () => {
  it('holds a split Sure, then emits the answer', () => {
    const f = new AnswerFirstFilter()
    expect(f.push('Su')).toBe('')
    expect(f.push('re, 6')).toBe('')
    expect(f.push('8.')).toBe('68.')
    expect(f.push(' done')).toBe(' done')
  })

  it('flushes a one-token numeric answer immediately once complete', () => {
    const f = new AnswerFirstFilter()
    expect(f.push('68')).toBe('')
    expect(f.flush()).toBe('68')
  })

  it('uses the question to drop an echoed opener across chunks', () => {
    const f = new AnswerFirstFilter('What is 17 times 4?')
    expect(f.push('What is 17 times 4? ')).toBe('')
    expect(f.flush()).toBe('')
    // After flush the filter has released; a late answer token still passes.
  })
})

describe('wordCount', () => {
  it('splits on whitespace and ignores empties', () => {
    expect(wordCount('  twelve angry  men ')).toBe(3)
    expect(wordCount('')).toBe(0)
  })
})
