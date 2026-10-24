import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LEXICON } from './turn-trigger-lexicon'
import { classifyTurn, normalizeTurn, phraseRegex } from './turn-triggers'

interface Case {
  id: string
  text: string
  expect: { kind: string; lang: string | null } | null
}
interface FixtureFile {
  synthetic: boolean
  cases: Case[]
}

const FILES = ['en', 'fr', 'pt-BR', 'es', 'code-switch'] as const
const load = (name: string): FixtureFile =>
  JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'turn-triggers', name + '.json'), 'utf8')) as FixtureFile
const loaded = new Map(FILES.map((f) => [f, load(f)]))

for (const name of FILES) {
  describe(`fixtures: ${name}`, () => {
    it.each(loaded.get(name)!.cases.map((c) => [c.id, c] as const))('%s', (_id, c) => {
      const r = classifyTurn(c.text)
      if (c.expect === null) expect(r, c.text).toBeNull()
      else expect(r && { kind: r.kind, lang: r.lang }, c.text).toEqual(c.expect)
    })
  })
}

describe('fixture files', () => {
  it('every file is marked synthetic and has ≥ 12 positives and ≥ 8 negatives', () => {
    for (const name of FILES) {
      const f = loaded.get(name)!
      expect(f.synthetic, name).toBe(true)
      const pos = f.cases.filter((c) => c.expect).length
      const neg = f.cases.length - pos
      if (name === 'code-switch') {
        expect(f.cases.length, name).toBeGreaterThanOrEqual(12)
        expect(neg, name).toBeGreaterThanOrEqual(4)
      } else {
        expect(pos, name).toBeGreaterThanOrEqual(12)
        expect(neg, name).toBeGreaterThanOrEqual(8)
      }
    }
  })

  it('every lexicon objection and tag phrase is covered by a fixture', () => {
    const texts = [...loaded.values()].flatMap((f) => f.cases.map((c) => normalizeTurn(c.text)))
    const missing: string[] = []
    for (const [lang, lex] of Object.entries(LEXICON)) {
      const phrases = [...Object.values(lex.objections).flat(), ...lex.tags]
      for (const p of phrases) {
        const re = phraseRegex(p, false)
        if (!texts.some((t) => re.test(t))) missing.push(`${lang}: ${p}`)
      }
    }
    expect(missing).toEqual([])
  })
})
