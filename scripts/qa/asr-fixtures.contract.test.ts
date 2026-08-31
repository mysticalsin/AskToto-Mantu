import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Wave 0 — ASR golden fixture manifest must stay coherent.
 * Audio files are optional in CI; ground-truth text + lang tags are required.
 */
const ROOT = join(__dirname, 'asr-fixtures')
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')) as {
  version: number
  clips: Array<{ id: string; lang: string; path: string; expected: string; tags: string[] }>
}

describe('Wave 0 — ASR fixture manifest', () => {
  it('has a versioned manifest with at least EN and FR clips', () => {
    expect(MANIFEST.version).toBe(1)
    expect(MANIFEST.clips.length).toBeGreaterThanOrEqual(4)
    const langs = new Set(MANIFEST.clips.map((c) => c.lang))
    expect(langs.has('en')).toBe(true)
    expect(langs.has('fr')).toBe(true)
  })

  it('every clip has id, lang, path, expected text, and tags', () => {
    for (const clip of MANIFEST.clips) {
      expect(clip.id.length).toBeGreaterThan(0)
      expect(['en', 'fr', 'de', 'es', 'pt', 'it']).toContain(clip.lang)
      expect(clip.expected.trim().length).toBeGreaterThan(10)
      expect(Array.isArray(clip.tags)).toBe(true)
      expect(clip.tags.length).toBeGreaterThan(0)
      const abs = join(ROOT, clip.path)
      expect(existsSync(abs), `missing ${clip.path}`).toBe(true)
      const body = readFileSync(abs, 'utf8').trim()
      expect(body).toBe(clip.expected.trim())
    }
  })

  it('FR clips are not English-only (guards Whisper auto→en trap regressions)', () => {
    const fr = MANIFEST.clips.filter((c) => c.lang === 'fr')
    expect(fr.length).toBeGreaterThanOrEqual(1)
    for (const clip of fr) {
      // At least one accented or clearly French token
      expect(/[àâäéèêëïîôùûüçœ]|bonjour|nous|contrat|montant|euros/i.test(clip.expected)).toBe(true)
    }
  })

  it('name/number fixtures include tokens brain + ASR corrections care about', () => {
    const names = MANIFEST.clips.find((c) => c.id === 'en-names')
    expect(names?.expected).toMatch(/Jane Doe/)
    expect(names?.expected).toMatch(/Acme/)
    const nums = MANIFEST.clips.find((c) => c.id === 'en-numbers')
    expect(nums?.expected).toMatch(/million|euros|Friday/i)
  })
})

/** Simple word-level WER for offline eval harnesses (not run against live ASR in CI). */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const ref = reference.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean)
  const hyp = hypothesis.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean)
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1
  const rows = ref.length + 1
  const cols = hyp.length + 1
  const d: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0))
  for (let i = 0; i < rows; i++) d[i]![0] = i
  for (let j = 0; j < cols; j++) d[0]![j] = j
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost)
    }
  }
  return d[ref.length]![hyp.length]! / ref.length
}

describe('Wave 0 — WER helper', () => {
  it('is 0 for identical strings', () => {
    expect(wordErrorRate('hello world', 'hello world')).toBe(0)
  })
  it('counts substitutions', () => {
    expect(wordErrorRate('hello world', 'hello earth')).toBeCloseTo(0.5)
  })
})
