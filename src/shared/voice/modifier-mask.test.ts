import { describe, expect, it } from 'vitest'
import {
  CHORD_PLATFORM_DEFAULTS,
  MODIFIER_BITS,
  MODIFIER_MASK_MAX,
  MODIFIER_SEQ_MAX,
  chordConflictsWithScreenReader,
  parseModifierLine
} from './modifier-mask'

describe('parseModifierLine', () => {
  it('parses the one documented shape', () => {
    expect(parseModifierLine('m 32 0')).toEqual({ mask: 32, seq: 0 })
    expect(parseModifierLine('m 0 4294967295')).toEqual({ mask: 0, seq: MODIFIER_SEQ_MAX })
    expect(parseModifierLine(`m ${MODIFIER_MASK_MAX} 7`)).toEqual({ mask: MODIFIER_MASK_MAX, seq: 7 })
  })

  it('tolerates exactly one trailing carriage return (Windows pipes), nothing else', () => {
    expect(parseModifierLine('m 2 3\r')).toEqual({ mask: 2, seq: 3 })
    expect(parseModifierLine('m 2 3\r\r')).toBeNull()
    expect(parseModifierLine('m 2 3 ')).toBeNull()
    expect(parseModifierLine(' m 2 3')).toBeNull()
  })

  it('rejects everything that is not `m <int> <int>` within range', () => {
    const rejected = [
      '',
      'm',
      'm 1',
      'm 1 2 3',
      'm  1 2',
      'm 1  2',
      'M 1 2',
      'k 1 2',
      'm -1 2',
      'm 1 -2',
      'm 1.5 2',
      'm 1 2.5',
      'm 0x1 2',
      'm 1e3 2',
      'm 01 2x',
      `m ${MODIFIER_MASK_MAX + 1} 0`,
      `m 0 ${MODIFIER_SEQ_MAX + 1}`,
      'm 99999999999999999999 0',
      'm 1 2\n',
      'm 1\t2',
      'key 55 down',
      '\u0000m 1 2'
    ]
    for (const line of rejected) expect(parseModifierLine(line), JSON.stringify(line)).toBeNull()
  })

  it('fuzz: only lines matching ^m \\d+ \\d+$ in range ever parse, and a parse carries no key identity', () => {
    let state = 0x2545f491
    const next = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state
    }
    const alphabet = 'm 0123456789\t\r\n-+.xXeE,kKdDwWnN'
    for (let i = 0; i < 4000; i += 1) {
      let line = ''
      const length = next() % 14
      for (let j = 0; j < length; j += 1) line += alphabet[next() % alphabet.length]
      const parsed = parseModifierLine(line)
      const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
      const shapeMatch = /^m (\d{1,4}) (\d{1,10})$/.exec(trimmed)
      const inRange =
        shapeMatch !== null && Number(shapeMatch[1]) <= MODIFIER_MASK_MAX && Number(shapeMatch[2]) <= MODIFIER_SEQ_MAX
      if (parsed) {
        expect(inRange, JSON.stringify(line)).toBe(true)
        expect(Object.keys(parsed).sort()).toEqual(['mask', 'seq'])
      } else {
        expect(inRange, JSON.stringify(line)).toBe(false)
      }
    }
  })
})

describe('modifier bits and defaults', () => {
  it('assigns each modifier its own bit within the documented mask range', () => {
    const values = Object.values(MODIFIER_BITS)
    expect(new Set(values).size).toBe(values.length)
    for (const bit of values) expect(bit & (bit - 1)).toBe(0)
    expect(values.reduce((all, bit) => all | bit, 0)).toBe(MODIFIER_MASK_MAX)
  })

  it('owner default chords: hold Right Command alone on macOS, Right Ctrl alone on Windows', () => {
    expect(CHORD_PLATFORM_DEFAULTS.darwin).toBe(MODIFIER_BITS.rightCommand)
    expect(CHORD_PLATFORM_DEFAULTS.win32).toBe(MODIFIER_BITS.rightControl)
  })

  it('flags a chord that collides with the VoiceOver modifier only while assistive technology is on', () => {
    const controlOption = MODIFIER_BITS.leftControl | MODIFIER_BITS.leftAlt
    expect(chordConflictsWithScreenReader(controlOption, true)).toBe(true)
    expect(chordConflictsWithScreenReader(controlOption, false)).toBe(false)
    expect(chordConflictsWithScreenReader(MODIFIER_BITS.rightControl | MODIFIER_BITS.rightAlt, true)).toBe(true)
    expect(chordConflictsWithScreenReader(MODIFIER_BITS.rightCommand, true)).toBe(false)
    expect(chordConflictsWithScreenReader(MODIFIER_BITS.rightControl, true)).toBe(false)
  })
})
