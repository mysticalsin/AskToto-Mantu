import { describe, it, expect } from 'vitest'
import { collapseRepeatedPhrase, isNonSpeechLine, repeatKey } from './transcript-filter'

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

  it('keeps short real reactions that carry intonation ("?"/"!"), even when the bare word is a phantom', () => {
    // A trailing "?" or "!" signals a genuine short reaction (an answer or an emphatic acknowledgment),
    // unlike the flat, punctuation-less (or period-terminated) filler a hallucinating model emits on
    // silence — so these must survive the filter and reach talkStats.
    expect(isNonSpeechLine('OK?')).toBe(false)
    expect(isNonSpeechLine('Bye?')).toBe(false)
    expect(isNonSpeechLine('Okay!')).toBe(false)
    expect(isNonSpeechLine('Thanks!')).toBe(false)
  })

  it('still drops the flat/period-terminated phantom shapes that are true ASR hallucinations', () => {
    expect(isNonSpeechLine('ok')).toBe(true)
    expect(isNonSpeechLine('Okay.')).toBe(true)
    expect(isNonSpeechLine('bye')).toBe(true)
    expect(isNonSpeechLine('Thank you.')).toBe(true) // repeated hallucination on silence
    expect(isNonSpeechLine('thanks')).toBe(true)
  })
})

describe('collapseRepeatedPhrase', () => {
  it('collapses a single-word decoder loop to two occurrences', () => {
    expect(collapseRepeatedPhrase('sim sim sim sim sim sim')).toBe('sim sim')
  })

  it('collapses a multi-word phrase loop, keeping the surrounding speech', () => {
    expect(collapseRepeatedPhrase('então vamos ver vamos ver vamos ver vamos ver o contrato')).toBe(
      'então vamos ver vamos ver o contrato'
    )
  })

  it('ignores trailing punctuation and case when detecting the loop, but keeps the kept words verbatim', () => {
    expect(collapseRepeatedPhrase('Obrigado. obrigado, obrigado obrigado')).toBe('Obrigado. obrigado,')
  })

  it('collapses two independent loops in the same line', () => {
    expect(collapseRepeatedPhrase('ok ok ok ok well thank you thank you thank you')).toBe(
      'ok ok well thank you thank you'
    )
  })

  it('leaves genuine speech untouched, including a natural double ("no, no")', () => {
    expect(collapseRepeatedPhrase('no, no that is not what I meant')).toBe('no, no that is not what I meant')
    expect(collapseRepeatedPhrase('the budget for the budget review')).toBe('the budget for the budget review')
    expect(collapseRepeatedPhrase('a very very good point')).toBe('a very very good point')
    expect(collapseRepeatedPhrase('')).toBe('')
  })
})

describe('repeatKey', () => {
  it('normalizes case, whitespace runs, and trailing punctuation so looping variants share one key', () => {
    expect(repeatKey('E aí a gente  fecha o contrato.')).toBe('e aí a gente fecha o contrato')
    expect(repeatKey('e aí a gente fecha o contrato!')).toBe('e aí a gente fecha o contrato')
  })

  it('keeps genuinely different lines apart', () => {
    expect(repeatKey('vamos ver o contrato')).not.toBe(repeatKey('vamos ver o seguro'))
  })
})
