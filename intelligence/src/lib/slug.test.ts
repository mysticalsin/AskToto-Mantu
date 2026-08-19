/// <reference types="node" />
// This test file runs under Vitest's node environment, so — unlike slug.ts itself, which ships in the
// browser bundle and must stay node:crypto-free — it may use node:crypto directly. The triple-slash
// reference pulls in @types/node's ambient module declarations for THIS FILE ONLY, without adding
// 'node' to tsconfig.app.json's global `types` (which intentionally stays browser-only for app code).
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { slug } from './slug.ts'

/**
 * MQA-174 — byte-for-byte parity against the host store's slugify (src/main/brain/store.ts) is proved in
 * src/main/brain/slug-parity.test.ts, which imports BOTH real functions. It used to be "proved" here by a
 * hand-written copy of slugify() — a copy that had itself drifted (no Windows-reserved-name branch, and a
 * plain 60-char truncation where the store truncates to 51 + an 8-hex hash), so it certified a parity that
 * did not exist and let slug() ship without the reserved-name branch for a month. A hand copy of the thing
 * under test is not an oracle; it is a second implementation that can drift with the first.
 *
 * What stays here is the dashboard-local behavior of slug() stated directly, with no mirror to drift from.
 */
describe('slug', () => {
  it('produces the expected ASCII slug for a plain latin name', () => {
    expect(slug('Acme Corp')).toBe('acme-corp')
  })

  it('MQA-174 — suffixes a bare Windows reserved device name, as the store does when it mints the node id', () => {
    expect(slug('AUX')).toBe('aux-x')
    expect(slug('con')).toBe('con-x')
    expect(slug('LPT9')).toBe('lpt9-x')
    // The check is on the WHOLE slug, not a prefix — these are ordinary names.
    expect(slug('Con Edison')).toBe('con-edison')
    expect(slug('Auxilium')).toBe('auxilium')
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
