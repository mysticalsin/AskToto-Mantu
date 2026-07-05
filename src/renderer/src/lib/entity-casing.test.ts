import { describe, it, expect } from 'vitest'
import { applyEntityCasing } from './entity-casing'

// Guards ASR entity-casing bias: transcripts should render names the brain already knows with their
// canonical spelling, but ONLY via exact (diacritic/case-folded) matches — never a phonetic guess, which
// could corrupt the transcript (e.g. rewriting the verb "mark" into a person named "Marc").
describe('applyEntityCasing — canonical name casing (safe, exact-match only)', () => {
  it('corrects a diacritic-stripped name to its accented canonical form', () => {
    expect(applyEntityCasing(["L'Oréal"], "we work with l'oreal on this deal")).toBe(
      "we work with L'Oréal on this deal"
    )
  })

  it('corrects a simple case mismatch', () => {
    expect(applyEntityCasing(['Mantu'], 'I joined mantu last year')).toBe('I joined Mantu last year')
  })

  it('matches a multi-word name only as the full contiguous phrase', () => {
    expect(applyEntityCasing(['Marc Bisiou'], 'talk to marc bisiou about this')).toBe(
      'talk to Marc Bisiou about this'
    )
    // A lone occurrence of just the first word must NOT be corrected against a multi-word entity.
    expect(applyEntityCasing(['Marc Bisiou'], 'marc said he would follow up')).toBe(
      'marc said he would follow up'
    )
  })

  it('longer names win over a shorter name they contain', () => {
    const names = ['Example', 'Example Account Alpha']
    expect(applyEntityCasing(names, 'talked to example account alpha yesterday')).toBe(
      'talked to Example Account Alpha yesterday'
    )
    // A standalone occurrence of the shorter name elsewhere in the same line still gets corrected.
    expect(applyEntityCasing(names, 'example account alpha called; example rang back too')).toBe(
      'Example Account Alpha called; Example rang back too'
    )
  })

  it('never auto-corrects names shorter than 3 characters', () => {
    expect(applyEntityCasing(['Al'], 'al said hi')).toBe('al said hi')
    expect(applyEntityCasing(['Bo'], 'bo is on the call')).toBe('bo is on the call')
  })

  it('is a no-op when the text already matches the canonical casing exactly', () => {
    expect(applyEntityCasing(['Mantu'], 'I joined Mantu last year')).toBe('I joined Mantu last year')
  })

  it('is whole-word only — never fires inside a longer word', () => {
    expect(applyEntityCasing(['Mark'], 'we marked the box as done')).toBe('we marked the box as done')
    expect(applyEntityCasing(['Ann'], 'the annual review is next week')).toBe(
      'the annual review is next week'
    )
  })

  // Verb-collision safety: no fuzzy/phonetic matching. "mark" (the verb) and "Marc" (the entity) are
  // different letters after folding (k vs c) — an exact-match engine must never conflate them.
  it('never corrupts an unrelated word that merely sounds like an entity name', () => {
    expect(applyEntityCasing(['Marc'], 'mark the date on the calendar')).toBe(
      'mark the date on the calendar'
    )
  })

  it('is case-insensitive on the match but preserves the canonical form on replace', () => {
    expect(applyEntityCasing(['Mantu'], 'MANTU is hiring')).toBe('Mantu is hiring')
  })

  it('handles an empty candidate list or empty text without throwing', () => {
    expect(applyEntityCasing([], 'hello world')).toBe('hello world')
    expect(applyEntityCasing(['Mantu'], '')).toBe('')
  })
})
