import { describe, expect, it } from 'vitest'
import { stripWakeWord, transcriptContainsWakeWord } from './metis-wake'

describe('R11 SRC-06: preserve source text after wake-token removal', () => {
  const payload = 'create "Résumé Q3 — Montréal 🚀" https://EXAMPLE.com/A/B?q=Été&X=1'
  for (const wake of ['Métis', 'MÉTIS', 'Me\u0301tis', 'Métis\u0301', 'Ｍｅｔｉｓ', 'ⓜⓔⓣⓘⓢ']) {
    it(`maps ${wake} to its original source span without rewriting the payload`, () => {
      expect(transcriptContainsWakeWord(`${wake} ${payload}`)).toBe(true)
      expect(stripWakeWord(`${wake} ${payload}`)).toBe(payload)
    })
  }
  it('does not strip a later occurrence or normalize content without a wake token', () => {
    expect(stripWakeWord('Métis create "Métis Roadmap"')).toBe('create "Métis Roadmap"')
    expect(stripWakeWord('  Résumé / A&B  ')).toBe('Résumé / A&B')
    expect(stripWakeWord('metisology')).toBe('metisology')
  })
  it('retains punctuation and whitespace inside note text', () => {
    expect(stripWakeWord('Métis note "Line 1\nLine 2\twith  spaces"')).toBe('note "Line 1\nLine 2\twith  spaces"')
  })
})
