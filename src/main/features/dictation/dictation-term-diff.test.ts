import { describe, expect, it } from 'vitest'
import { extractTermCorrections } from './dictation-term-diff'

describe('extractTermCorrections (G26)', () => {
  it('learns a single replaced word as heard to preferred, keeping the preferred casing', () => {
    expect(extractTermCorrections('please ask Tota about the roadmap', 'please ask Toto about the roadmap')).toEqual([
      { heard: 'tota', preferred: 'Toto' }
    ])
  })

  it('learns a short phrase replaced by a short phrase', () => {
    expect(extractTermCorrections('we use mantis for notes today', 'we use Métis for notes today')).toEqual([
      { heard: 'mantis', preferred: 'Métis' }
    ])
    expect(extractTermCorrections('the meat is app is ready now', 'the Métis app is ready now')).toEqual([
      { heard: 'meat is', preferred: 'Métis' }
    ])
  })

  it('ignores punctuation attached to a word and learns a casing-only correction', () => {
    expect(extractTermCorrections('hello toto, how are you', 'hello Toto, how are you')).toEqual([
      { heard: 'toto', preferred: 'Toto' }
    ])
    expect(extractTermCorrections('it works, fine', 'it works. fine')).toEqual([])
  })

  it('learns nothing from pure insertions, pure deletions or an unchanged text', () => {
    expect(extractTermCorrections('one two three', 'one two three')).toEqual([])
    expect(extractTermCorrections('one two three', 'one two three four')).toEqual([])
    expect(extractTermCorrections('one two three four', 'one two four')).toEqual([])
  })

  it('treats a rewrite as an edit, not a spelling preference: nothing is learned', () => {
    expect(
      extractTermCorrections('we should meet on tuesday to review it', 'let us talk about something entirely different')
    ).toEqual([])
  })

  it('refuses a block longer than three words and any term over 64 characters', () => {
    expect(extractTermCorrections('a b c d e f g h i j', 'a b w x y z g h i j')).toEqual([])
    const long = 'x'.repeat(70)
    expect(extractTermCorrections(`say ${long} now ok`, 'say fine now ok')).toEqual([])
  })

  it('caps the pairs from one correction and never returns an empty term', () => {
    const original = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ')
    const corrected = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? `W${i}` : `w${i}`)).join(' ')
    expect(extractTermCorrections(original, corrected).length).toBeLessThanOrEqual(8)
    for (const pair of extractTermCorrections('foo , bar', 'foo bar')) {
      expect(pair.heard.length).toBeGreaterThan(0)
      expect(pair.preferred.length).toBeGreaterThan(0)
    }
  })

  it('never leaks a newline or control character into a term', () => {
    expect(extractTermCorrections('say tota please', 'say To\u0000to please')).toEqual([])
    expect(extractTermCorrections('say tota please', 'say Toto\nplease')).toEqual([
      { heard: 'tota', preferred: 'Toto' }
    ])
  })
})
