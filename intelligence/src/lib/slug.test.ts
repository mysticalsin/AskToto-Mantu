/// <reference types="node" />
// This test file runs under Vitest's node environment, so — unlike slug.ts itself, which ships in the
// browser bundle and must stay node:crypto-free — it may use node:crypto directly. The triple-slash
// reference pulls in @types/node's ambient module declarations for THIS FILE ONLY, without adding
// 'node' to tsconfig.app.json's global `types` (which intentionally stays browser-only for app code).
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { slug } from './slug.ts'

/**
 * Parity test against the host store's slugify (src/main/brain/store.ts). This file runs under Vitest's
 * node environment, so it's allowed to import `node:crypto` directly to compute the SAME expected hash
 * store.ts would produce — slug.ts itself must stay node:crypto-free (see slug.ts's doc comment) because
 * it ships in the browser bundle.
 */
function storeSlugify(s: string): string {
  const base = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  if (base) return base
  const hash = createHash('sha256').update(s.normalize('NFKC')).digest('hex').slice(0, 8)
  return `x-${hash}`
}

describe('slug', () => {
  const cases = [
    'Acme Corp',
    "L'Oréal",
    '株式会社アクメ',
    '🎉🚀',
    ''
  ]

  it.each(cases)('matches store.ts slugify byte-for-byte for %j', (name) => {
    expect(slug(name)).toBe(storeSlugify(name))
  })

  it('produces the expected ASCII slug for a plain latin name', () => {
    expect(slug('Acme Corp')).toBe('acme-corp')
  })

  it('strips diacritics so accented and unaccented names collide on purpose', () => {
    expect(slug("L'Oréal")).toBe('l-oreal')
    expect(slug("L'Oreal")).toBe('l-oreal')
    // Both forms of "José" must land on the same slug.
    expect(slug('José')).toBe(slug('Jose'))
  })

  it('hashes a fully non-Latin name instead of collapsing it to a shared "unknown"', () => {
    const s = slug('株式会社アクメ')
    expect(s).toMatch(/^x-[0-9a-f]{8}$/)
    const expectedHash = createHash('sha256').update('株式会社アクメ'.normalize('NFKC')).digest('hex').slice(0, 8)
    expect(s).toBe(`x-${expectedHash}`)
  })

  it('hashes an emoji-only name deterministically and distinctly from other emoji', () => {
    const s = slug('🎉🚀')
    expect(s).toMatch(/^x-[0-9a-f]{8}$/)
    expect(slug('🎉🚀')).toBe(s) // deterministic — same input, same slug every time
    expect(slug('🔥💧')).not.toBe(s) // different input, different slug
  })

  it('hashes an empty string rather than falling back to a fixed value', () => {
    const s = slug('')
    expect(s).toMatch(/^x-[0-9a-f]{8}$/)
    const expectedHash = createHash('sha256').update(''.normalize('NFKC')).digest('hex').slice(0, 8)
    expect(s).toBe(`x-${expectedHash}`)
  })
})
