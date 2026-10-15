import { createHash } from 'node:crypto'
import type { Confidence } from '@shared/brain'

const WIN_RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9'
])

/** Deterministic safe filename identity for brain entities. */
export function slugify(s: string): string {
  const full = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const base =
    full.length > 60 ? `${full.slice(0, 51)}-${createHash('sha256').update(full).digest('hex').slice(0, 8)}` : full
  if (base && WIN_RESERVED_NAMES.has(base)) return `${base}-x`
  if (base) return base
  const hash = createHash('sha256').update(s.normalize('NFKC')).digest('hex').slice(0, 8)
  return `x-${hash}`
}

/** Stable identity for a re-spoken commitment. */
export const commitmentKey = (text: string): string =>
  text
    .normalize('NFKC')
    .trim()
    .replace(/[.!?…]+$/u, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

export const pushUnique = <T>(arr: T[], item: T, key: (t: T) => string): void => {
  if (!arr.some((x) => key(x) === key(item))) arr.push(item)
}

export type SupersededEntry<T> = { value: T; date: string; source_file: string; confidence?: Confidence }
const confOf = <T>(entry: SupersededEntry<T>): Confidence => entry.confidence ?? 'INFERRED'
const laterEntry = <T>(a: SupersededEntry<T>, b: SupersededEntry<T>): boolean =>
  outranks(
    { date: a.date, source_file: a.source_file, confidence: confOf(a) },
    { date: b.date, source_file: b.source_file, confidence: confOf(b) }
  )

export function outranks(
  a: { date: string; source_file: string; confidence: Confidence },
  b: { date: string; source_file: string; confidence: Confidence }
): boolean {
  const at = a.confidence === 'EXTRACTED' ? 1 : 0
  const bt = b.confidence === 'EXTRACTED' ? 1 : 0
  if (at !== bt) return at > bt
  if (a.date !== b.date) return a.date > b.date
  return a.source_file > b.source_file
}

export function pushSuperseded<T>(
  list: SupersededEntry<T>[],
  entry: SupersededEntry<T>,
  currentValue: T,
  valuesEqual: (a: T, b: T) => boolean
): SupersededEntry<T>[] {
  const out: SupersededEntry<T>[] = []
  for (const candidate of [...list, entry]) {
    if (valuesEqual(candidate.value, currentValue)) continue
    const i = out.findIndex((existing) => valuesEqual(existing.value, candidate.value))
    if (i === -1) out.push(candidate)
    else if (laterEntry(candidate, out[i])) out[i] = candidate
  }
  return out.sort((a, b) => (laterEntry(a, b) ? -1 : laterEntry(b, a) ? 1 : 0)).slice(0, 10)
}

export const eqStrict = <T>(a: T, b: T): boolean => a === b
export const eqVelocity = (a: { signal: string; evidence: string }, b: { signal: string; evidence: string }): boolean =>
  a.signal === b.signal && a.evidence === b.evidence
export const eqAmount = (a: { value: number; currency: string }, b: { value: number; currency: string }): boolean =>
  a.value === b.value && a.currency === b.currency
