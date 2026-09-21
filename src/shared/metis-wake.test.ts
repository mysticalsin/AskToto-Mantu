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

  it('HARD: ASR mis-hearings of Hey Métis still arm (greeting required)', () => {
    // Verbatim Parakeet for spoken Hey Métis — silent aliases, not product branding.
    expect(transcriptContainsWakeWord('Hey Midas.')).toBe(true)
    expect(transcriptContainsWakeWord('Hey Metus, open notes.')).toBe(true)
    expect(transcriptContainsWakeWord('Hey meet us, open notes and Google Norbert Wiener.')).toBe(true)
    // Additional near-neighbour ASR spellings (silent).
    expect(transcriptContainsWakeWord('Hey Matisse')).toBe(true)
    expect(transcriptContainsWakeWord('hey matisse open notes')).toBe(true)
    expect(transcriptContainsWakeWord('hey mattis')).toBe(true)
    expect(transcriptContainsWakeWord('Hi Mateus, open notes')).toBe(true)
    expect(transcriptContainsWakeWord('hey met is')).toBe(true)
    // …and the greeting is still mandatory for every one of them. "Meet us." is verbatim Parakeet
    // output for a bare spoken "Métis" — the Ultron HARD rule survives the widened spelling.
    expect(transcriptContainsWakeWord('Meet us.')).toBe(false)
    expect(transcriptContainsWakeWord('Matisse')).toBe(false)
    expect(transcriptContainsWakeWord('matisse open notes')).toBe(false)
    expect(transcriptContainsWakeWord('let us meet us there')).toBe(false)
    expect(transcriptContainsWakeWord('say hi to matthew')).toBe(false)
    expect(transcriptContainsWakeWord('hi matt')).toBe(false)
    expect(transcriptContainsWakeWord('hey man')).toBe(false)
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
