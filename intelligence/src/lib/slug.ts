import { sha256Hex } from './sha256.ts'

/**
 * MUST match the host store's slugify (src/main/brain/store.ts) byte-for-byte in behavior — these
 * slugs join adapter-side entities to graph node ids minted at ingest. The previous local slug()
 * skipped NFKD + diacritic stripping, so "José" became "jos" here but "jose" in the store and every
 * accented person/account silently fell out of the Going-Cold joins.
 *
 * The store's fallback for non-Latin names (Chinese, Cyrillic, Arabic, pure emoji) is a hash of the
 * NFKC-normalized name, NOT a fixed 'unknown' — a fixed fallback would silently merge every such
 * distinct entity into one shared file, a real cross-account confidentiality bug. store.ts hashes with
 * Node's `node:crypto`, which does not exist in this browser bundle, so `sha256.ts` reimplements the
 * same digest in pure TS (verified byte-for-byte against `node:crypto` in slug.test.ts).
 */
export function slug(s: string): string {
  const full = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics so "L'Oréal" and "L'Oreal" share a slug
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  // Two distinct long names that share an identical 60-char prefix would otherwise collide onto the
  // same slug and silently merge their entity files. Only truncate when needed, and disambiguate the
  // truncation with a short content hash so different long names still map to different slugs.
  const base = full.length > 60 ? `${full.slice(0, 51)}-${sha256Hex(full).slice(0, 8)}` : full
  if (base) return base
  const hash = sha256Hex(s.normalize('NFKC')).slice(0, 8)
  return `x-${hash}`
}
