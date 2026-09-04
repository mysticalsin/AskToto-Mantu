/** Allowlisted Métis client products that may appear on Operator Realtime. */

export const METIS_PRODUCTS = [
  'metis-desktop',
  'metis-overlay',
  'metis-ios',
  'metis-macos',
  'metis-windows'
] as const

export type MetisProduct = (typeof METIS_PRODUCTS)[number]

const LABELS: Record<MetisProduct, string> = {
  'metis-desktop': 'Desktop',
  'metis-overlay': 'Overlay',
  'metis-ios': 'iOS',
  'metis-macos': 'Mac',
  'metis-windows': 'Windows'
}

const ALLOWED = new Set<string>(METIS_PRODUCTS)

/** Parse a client-supplied product id. Unknown → null (do not invent). */
export function parseMetisProduct(raw: unknown): MetisProduct | null {
  if (typeof raw !== 'string') return null
  const id = raw.trim().toLowerCase()
  if (!ALLOWED.has(id)) return null
  return id as MetisProduct
}

export function productLabel(id: string | null | undefined): string {
  if (!id) return 'Unknown'
  const parsed = parseMetisProduct(id)
  return parsed ? LABELS[parsed] : 'Unknown'
}
