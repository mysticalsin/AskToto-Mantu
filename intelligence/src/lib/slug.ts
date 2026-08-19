import { sha256Hex } from './sha256.ts'

// Windows reserved device names — a path whose basename (before the first '.') case-insensitively
// matches one of these fails to open at all, even for a tmp file, regardless of extension.
const WIN_RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
])

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
  // The store suffixes a slug that is a bare Windows reserved device name so the entity file can be
  // opened at all, and the node id it mints carries that suffix — so the mirror must suffix too or the
  // join misses (an account literally named "AUX" is ingested as account:aux-x, looked up as aux).
  if (base && WIN_RESERVED_NAMES.has(base)) return `${base}-x`
  if (base) return base
  const hash = sha256Hex(s.normalize('NFKC')).slice(0, 8)
  return `x-${hash}`
}
