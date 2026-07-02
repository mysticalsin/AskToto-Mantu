/**
 * MUST match the host store's slugify (src/main/brain/store.ts) byte-for-byte in behavior — these
 * slugs join adapter-side entities to graph node ids minted at ingest. The previous local slug()
 * skipped NFKD + diacritic stripping, so "José" became "jos" here but "jose" in the store and every
 * accented person/account silently fell out of the Going-Cold joins.
 */
export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '') // strip diacritics so "L'Oréal" and "L'Oreal" share a slug
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'unknown'
  )
}
