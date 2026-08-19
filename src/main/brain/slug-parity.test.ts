import { describe, it, expect, vi } from 'vitest'
import { slugify } from './store'
import { slug } from '../../../intelligence/src/lib/slug'

vi.mock('electron')

/**
 * MQA-174 — the Mantu Intelligence dashboard carries its own slug() (intelligence/src/lib/slug.ts)
 * because intelligence/ is a separate build graph (own tsconfig, own vite, own bundle) and cannot
 * import main-process code. Its doc comment promises byte-for-byte parity with slugify() here, and the
 * app depends on that promise: ingest mints graph node ids as `account:${slugify(name)}` and the
 * dashboard joins its entities back onto those ids with slug(name). Any divergence silently drops the
 * entity out of the Going-Cold / freshness joins.
 *
 * This test lives on the main side, next to the source of truth, because it must import BOTH real
 * implementations. The dashboard's own slug.test.ts cannot: intelligence's `tsc -b` typechecks
 * everything under intelligence/src with a browser-only tsconfig that has no `node` types and no
 * `@shared/*` path mapping, so importing store.ts from there would break `npm run build:intelligence`.
 * The parity check it used to carry compared slug() against a hand-written copy of slugify() — a copy
 * that had itself drifted, so it certified a parity that did not exist.
 */
describe('slug parity — dashboard mirror vs store slugify', () => {
  const names = [
    'Acme Corp',
    "L'Oréal",
    '株式会社アクメ',
    '🎉🚀',
    '',
    // Windows reserved device names: slugify suffixes these so the entity file can be opened at all.
    'AUX',
    'CON',
    'nul',
    'com1',
    'LPT9',
    // Near-misses that must NOT be suffixed — the reserved check is on the whole slug, not a prefix.
    'Con Edison',
    'Auxilium',
    // Past the 60-char truncation boundary, where the slug is a prefix plus a content hash.
    `Verylongenterpriseaccountname ${'x'.repeat(80)}`
  ]

  it.each(names)('MQA-174 — dashboard slug() matches store slugify() for %j', (name) => {
    expect(slug(name)).toBe(slugify(name))
  })

  it('MQA-174 — a bare Windows reserved name is suffixed on both sides, not just in the store', () => {
    expect(slugify('AUX')).toBe('aux-x')
    expect(slug('AUX')).toBe('aux-x')
  })
})
