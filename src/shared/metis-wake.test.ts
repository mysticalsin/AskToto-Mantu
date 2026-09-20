import { describe, expect, it } from 'vitest'
import {
  METIS_PILL_HI,
  METIS_PILL_LISTENING,
  foldSpeech,
  stripWakeWord,
  transcriptContainsEndPhrase,
  transcriptContainsWakeWord
} from './metis-wake'

describe('Cap2 wake word', () => {
  it('matches Métis with accent folding', () => {
    expect(transcriptContainsWakeWord('Hey Métis')).toBe(true)
    expect(transcriptContainsWakeWord('metis open notes')).toBe(true)
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

  it('stripWakeWord removes the name call', () => {
    expect(foldSpeech(stripWakeWord('Métis open notes'))).toContain('open notes')
  })
})
