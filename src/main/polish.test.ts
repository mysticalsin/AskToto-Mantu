import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildPolishPrompt, parsePolishResponse, polishBatches, type PolishLine } from './polish'

const lines: PolishLine[] = [
  { speaker: 'THEM', t: '00:00:01', text: 'so so I think- I think we should ship it' },
  { speaker: 'YOU', t: '00:00:05', text: 'je je pense que oui' },
  { speaker: 'THEM', t: '00:00:09', text: 'on est le 12 mars 2026, ça fait 45 pourcent' }
]

describe('buildPolishPrompt', () => {
  it('includes every line text and speaker in the prompt', () => {
    const prompt = buildPolishPrompt(lines)
    for (const l of lines) {
      expect(prompt).toContain(l.text)
      expect(prompt).toContain(l.speaker)
    }
  })

  it('states the never-translate rule and that French stays French', () => {
    const prompt = buildPolishPrompt(lines)
    expect(prompt).toMatch(/NEVER translates/i)
    expect(prompt).toMatch(/French line stays French/i)
  })

  it('states the verbatim-numbers rule', () => {
    const prompt = buildPolishPrompt(lines)
    expect(prompt).toMatch(/VERBATIM/)
    expect(prompt.toLowerCase()).toContain('digit-for-digit')
  })

  it('states never-paraphrase and never-merge/split/reorder rules', () => {
    const prompt = buildPolishPrompt(lines)
    expect(prompt).toMatch(/NEVER paraphrases/i)
    expect(prompt).toMatch(/NEVER merges/i)
  })

  it('frames the transcript content as untrusted data, not instructions to follow', () => {
    const prompt = buildPolishPrompt(lines)
    expect(prompt.toLowerCase()).toContain('untrusted data')
    expect(prompt.toLowerCase()).toContain('never instructions to follow')
  })

  it('demands a strict JSON array of the exact expected length', () => {
    const prompt = buildPolishPrompt(lines)
    expect(prompt).toMatch(/STRICT JSON/)
    expect(prompt).toContain(`exactly ${lines.length} strings`)
    expect(prompt).toContain(`exactly ${lines.length} lines`)
  })

  it('handles an empty line list without throwing', () => {
    expect(() => buildPolishPrompt([])).not.toThrow()
    const prompt = buildPolishPrompt([])
    expect(prompt).toContain('exactly 0 lines')
  })
})

describe('parsePolishResponse', () => {
  it('parses a plain JSON array', () => {
    const raw = JSON.stringify(['a', 'b', 'c'])
    expect(parsePolishResponse(raw, 3)).toEqual(['a', 'b', 'c'])
  })

  it('parses a JSON array wrapped in a ```json fence', () => {
    const raw = '```json\n' + JSON.stringify(['a', 'b']) + '\n```'
    expect(parsePolishResponse(raw, 2)).toEqual(['a', 'b'])
  })

  it('parses a JSON array wrapped in a bare ``` fence', () => {
    const raw = '```\n' + JSON.stringify(['x', 'y']) + '\n```'
    expect(parsePolishResponse(raw, 2)).toEqual(['x', 'y'])
  })

  it('preserves accents and UTF-8 French text through the fence + parse round trip', () => {
    const french = ['Je pense que ça va être compliqué.', 'On se voit à Genève, d\'accord ?', 'Numéro: 45%']
    const raw = '```json\n' + JSON.stringify(french) + '\n```'
    expect(parsePolishResponse(raw, 3)).toEqual(french)
  })

  it('returns null for wrong array length', () => {
    const raw = JSON.stringify(['a', 'b'])
    expect(parsePolishResponse(raw, 3)).toBeNull()
  })

  it('returns null for a non-array (object) response', () => {
    const raw = JSON.stringify({ lines: ['a', 'b'] })
    expect(parsePolishResponse(raw, 2)).toBeNull()
  })

  it('returns null for an array containing a non-string element', () => {
    const raw = JSON.stringify(['a', 42, 'c'])
    expect(parsePolishResponse(raw, 3)).toBeNull()
  })

  it('returns null (never throws) on malformed JSON', () => {
    expect(() => parsePolishResponse('not json at all {{{', 2)).not.toThrow()
    expect(parsePolishResponse('not json at all {{{', 2)).toBeNull()
  })

  it('returns null on empty string input', () => {
    expect(parsePolishResponse('', 1)).toBeNull()
  })

  it('accepts an array containing empty-after-trim strings (caller falls back, this function does not)', () => {
    const raw = JSON.stringify(['a', '   ', ''])
    expect(parsePolishResponse(raw, 3)).toEqual(['a', '   ', ''])
  })
})

describe('polishBatches', () => {
  it('produces one batch when lines fit within batchSize', () => {
    const batches = polishBatches(lines, 24)
    expect(batches).toHaveLength(1)
    expect(batches[0]).toEqual(lines)
  })

  it('splits into stable fixed-size batches with the last one shorter', () => {
    const many: PolishLine[] = Array.from({ length: 50 }, (_, i) => ({
      speaker: i % 2 === 0 ? 'THEM' : 'YOU',
      t: `00:00:${String(i).padStart(2, '0')}`,
      text: `line ${i}`
    }))
    const batches = polishBatches(many, 24)
    expect(batches).toHaveLength(3)
    expect(batches[0]).toHaveLength(24)
    expect(batches[1]).toHaveLength(24)
    expect(batches[2]).toHaveLength(2)
    // Order preserved, nothing dropped or duplicated.
    expect(batches.flat()).toEqual(many)
  })

  it('uses batchSize=24 as the default', () => {
    const many: PolishLine[] = Array.from({ length: 25 }, (_, i) => ({ speaker: 'X', t: '0', text: `${i}` }))
    const batches = polishBatches(many)
    expect(batches).toHaveLength(2)
    expect(batches[0]).toHaveLength(24)
    expect(batches[1]).toHaveLength(1)
  })

  it('returns an empty array for an empty input', () => {
    expect(polishBatches([])).toEqual([])
  })

  it('is deterministic/stable across repeated calls on the same input', () => {
    const a = polishBatches(lines, 2)
    const b = polishBatches(lines, 2)
    expect(a).toEqual(b)
  })
})

describe('contract: polish.ts is pure — no network/provider imports', () => {
  const src = readFileSync(join(__dirname, 'polish.ts'), 'utf8')

  it('contains no fetch, https, ipcRenderer, or openai imports/usages', () => {
    expect(src).not.toMatch(/\bfetch\s*\(/)
    expect(src).not.toMatch(/require\(['"]https?['"]\)/)
    expect(src).not.toMatch(/from ['"]node:https?['"]/)
    expect(src).not.toMatch(/ipcRenderer/)
    expect(src).not.toMatch(/openai/i)
  })
})
