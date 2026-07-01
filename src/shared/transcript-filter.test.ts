import { describe, it, expect } from 'vitest'
import { isNonSpeechLine } from './transcript-filter'

describe('isNonSpeechLine', () => {
  it('drops bracketed sound-event captions', () => {
    expect(isNonSpeechLine('[BELL RINGS]')).toBe(true)
    expect(isNonSpeechLine('[MUSIC]')).toBe(true)
    expect(isNonSpeechLine('[BLANK_AUDIO]')).toBe(true)
    expect(isNonSpeechLine('[ Silence ]')).toBe(true)
  })

  it('drops parenthesised captions and musical notes', () => {
    expect(isNonSpeechLine('(applause)')).toBe(true)
    expect(isNonSpeechLine('(coughing)')).toBe(true)
    expect(isNonSpeechLine('♪♪♪')).toBe(true)
    expect(isNonSpeechLine('♪ la la la ♪')).toBe(true)
  })

  it('drops phantom phrases and blank lines', () => {
    expect(isNonSpeechLine('')).toBe(true)
    expect(isNonSpeechLine('   ')).toBe(true)
    expect(isNonSpeechLine('you')).toBe(true)
    expect(isNonSpeechLine('Thank you.')).toBe(true)
    expect(isNonSpeechLine('thanks for watching')).toBe(true)
  })

  it('keeps real speech, including lines that merely contain a parenthetical', () => {
    expect(isNonSpeechLine('What is the budget for Q3?')).toBe(false)
    expect(isNonSpeechLine('He said (loudly) we should ship it')).toBe(false)
    expect(isNonSpeechLine('Thanks for joining, let us start')).toBe(false)
    expect(isNonSpeechLine('I think [name] should own this')).toBe(false) // bracket mid-line, not whole-line
  })
})
