import { describe, expect, it } from 'vitest'
import {
  METIS_PILL_HI,
  METIS_PILL_LISTENING,
  METIS_WAKE_WORD,
  foldSpeech,
  stripWakeWord,
  transcriptContainsEndPhrase,
  transcriptContainsWakeWord
} from './metis-wake'

describe('Cap2 wake word', () => {
  it('HARD: Hey Métis wakes; bare Métis does not', () => {
    expect(METIS_WAKE_WORD).toBe('Hey Métis')
    expect(transcriptContainsWakeWord('Hey Métis')).toBe(true)
    expect(transcriptContainsWakeWord('hey metis open notes')).toBe(true)
    expect(transcriptContainsWakeWord('Hey, Métis')).toBe(true)
    expect(transcriptContainsWakeWord('Hi Métis')).toBe(true)
    expect(transcriptContainsWakeWord('Métis')).toBe(false)
    expect(transcriptContainsWakeWord('metis open notes')).toBe(false)
    expect(transcriptContainsWakeWord('meeting about meta systems')).toBe(false)
  })

  it('detects thank-you end phrases', () => {
    expect(transcriptContainsEndPhrase('Thank you')).toBe(true)
    expect(transcriptContainsEndPhrase('thanks Metis')).toBe(true)
    expect(transcriptContainsEndPhrase('open notes')).toBe(false)
  })

  it('pill copy locks', () => {
    expect(METIS_PILL_HI).toBe('Hi Métis')
    expect(METIS_PILL_LISTENING).toBe("Hi Métis, I'm listening...")
  })

  it('stripWakeWord removes Hey Métis', () => {
    expect(foldSpeech(stripWakeWord('Hey Métis open notes'))).toBe('open notes')
  })
})
