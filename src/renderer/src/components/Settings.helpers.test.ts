import { describe, it, expect } from 'vitest'
import { serializeAsrCorrections, parseAsrCorrections, sameAsrCorrections } from './Settings'

describe('vocabulary-corrections helpers', () => {
  it('serializes one "heard => correct" line per correction, in order', () => {
    expect(serializeAsrCorrections([{ from: 'Mantoo', to: 'Mantu' }, { from: 'Bizioux', to: 'Bisiou' }]))
      .toBe('Mantoo => Mantu\nBizioux => Bisiou')
    expect(serializeAsrCorrections([])).toBe('')
  })

  it('round-trips serialize → parse', () => {
    const items = [{ from: 'Acme Corp', to: 'Acme' }, { from: 'L Oreal', to: 'L’Oréal' }]
    expect(parseAsrCorrections(serializeAsrCorrections(items))).toEqual(items)
  })

  it('parse tolerates in-progress edits (blank lines, lines with no "=>" yet, empty "from")', () => {
    // This is the crux of the fix: typing Enter (a trailing blank line) or a half-typed line must not
    // corrupt the committed set — those lines are simply "not a correction yet" and are dropped.
    expect(parseAsrCorrections('a => b\n\nnotyet\n => c\nx => y')).toEqual([{ from: 'a', to: 'b' }, { from: 'x', to: 'y' }])
    expect(parseAsrCorrections('a => b\n')).toEqual([{ from: 'a', to: 'b' }]) // trailing newline mid-typing
    expect(parseAsrCorrections('   =>   ')).toEqual([]) // whitespace-only from → not a correction
  })

  it('parse trims and allows an empty replacement (delete a word)', () => {
    expect(parseAsrCorrections('  uh  =>  ')).toEqual([{ from: 'uh', to: '' }])
  })

  it('parse caps at 100 corrections', () => {
    const raw = Array.from({ length: 150 }, (_, i) => `f${i} => t${i}`).join('\n')
    expect(parseAsrCorrections(raw)).toHaveLength(100)
  })

  it('sameAsrCorrections is value-equal and order-sensitive', () => {
    const a = [{ from: 'a', to: 'b' }, { from: 'c', to: 'd' }]
    expect(sameAsrCorrections(a, [{ from: 'a', to: 'b' }, { from: 'c', to: 'd' }])).toBe(true)
    expect(sameAsrCorrections(a, [{ from: 'c', to: 'd' }, { from: 'a', to: 'b' }])).toBe(false) // order matters
    expect(sameAsrCorrections(a, [{ from: 'a', to: 'b' }])).toBe(false)
  })
})
