import { createHash } from 'node:crypto'
import type { Confidence } from '@shared/brain'

// Windows reserved device basenames fail to open even for tmp files, regardless of extension.
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

export function slugify(s: string): string {
  const full = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics so "L'Oréal" and "L'Oreal" share a slug
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  // Disambiguate long shared prefixes with a short content hash.
  const base =
    full.length > 60 ? `${full.slice(0, 51)}-${createHash('sha256').update(full).digest('hex').slice(0, 8)}` : full
  // Bare Windows reserved names cannot be opened; suffix deterministically.
  if (base && WIN_RESERVED_NAMES.has(base)) return `${base}-x`
  if (base) return base
  // A non-Latin or blank name collapses the ASCII pass to '' — falling back to a fixed
  // 'unknown' would silently merge every such distinct entity into one shared file (a real
  // cross-account confidentiality bug for a tool whose job is per-account isolation). Instead, hash
  // the NFKC-normalized original name: deterministic (same name → same slug every time) and
  // collision-resistant (different names → different slugs) without ever touching the ASCII path above.
  const hash = createHash('sha256').update(s.normalize('NFKC')).digest('hex').slice(0, 8)
  return `x-${hash}`
}

/** Ledger identity for a commitment is its normalized TEXT — a promise re-spoken in a later meeting
 *  ("I'll send the deck", again) is the same obligation, not a second open row. The earliest-dated
 *  row wins (pushUnique keeps the first), so aging starts from when the promise was first made.
 *  Normalizes Unicode form (NFKC, so visually-identical composed/decomposed text matches), strips
 *  trailing sentence punctuation (a re-spoken "Send the deck." vs "send the deck" is one obligation),
 *  then case-folds and collapses whitespace. Lives here (beside slugify) rather than in ingest.ts so
 *  the correction engine (corrections.ts) can match commitments by the same key without a
 *  corrections.ts <-> ingest.ts import cycle (ingest.ts re-exports it for backward compatibility). */
export const commitmentKey = (text: string): string =>
  text
    .normalize('NFKC')
    .trim()
    .replace(/[.!?…]+$/u, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

/** Push `item` onto `arr` only if no existing element shares its `key` — the de-dup primitive every
 *  compounding entity array (meetings, commitments, signals, aliases, graph edges...) is built with.
 *  Exported for the same reason as commitmentKey above: corrections.ts's entity-merge logic reuses the
 *  exact same de-dup semantics ingest.ts's mergeExtraction uses, instead of a second implementation. */
export const pushUnique = <T>(arr: T[], item: T, key: (t: T) => string): void => {
  if (!arr.some((x) => key(x) === key(item))) arr.push(item)
}

/** One entry in a ProvenantField's `superseded` history — see the ProvenantField doc comment in
 *  shared/brain.ts. Lives here (not ingest.ts) for the same import-cycle reason as commitmentKey/
 *  pushUnique above: corrections.ts's human-pin logic needs the identical history bookkeeping
 *  ingest.ts's mergeProvenant uses, and ingest.ts itself needs applyCorrections/readAliasMap FROM
 *  corrections.ts — so this shared piece has to sit below both, not inside either. */
// MI-4 review (mixed-tier superseded permutation): `confidence` is OPTIONAL so every entry ever written
// to disk before this field existed still parses — see the INFERRED fallback in `confOf` below, not a
// migration. Threading it through means `laterEntry`'s ordering key can finally match `outranks`'s
// (confidence tier first, then date, then source_file) instead of silently ignoring confidence — see
// `laterEntry`'s own doc comment for why the mismatch was a real bug, not just an inconsistency.
export type SupersededEntry<T> = { value: T; date: string; source_file: string; confidence?: Confidence }

// Legacy entries written before this field existed (and any caller that still omits it) carry no
// confidence slot at all — treated as the WEAKEST tier (INFERRED) for ordering purposes, never assumed
// EXTRACTED. This is a read-time interpretation only (no on-disk migration): an old entry simply loses
// every ordering tie-break to a same-value entry that DOES carry an explicit EXTRACTED confidence, which
// is the conservative, fail-safe default.
const confOf = <T>(e: SupersededEntry<T>): Confidence => e.confidence ?? 'INFERRED'

// MI-4 review fix: previously ordered by (date, source_file) ALONE, ignoring confidence entirely — a
// total order that could disagree with `outranks` (the SAME-named winner-selection order every merge
// path uses), so a mixed-confidence, same-value superseded set could keep the WRONG (weaker-confidence)
// sighting depending on which one happened to have a later date. Delegating to `outranks` here makes
// this the same single ordering key everywhere: confidence tier first, then date, then source_file.
const laterEntry = <T>(a: SupersededEntry<T>, b: SupersededEntry<T>): boolean =>
  outranks(
    { date: a.date, source_file: a.source_file, confidence: confOf(a) },
    { date: b.date, source_file: b.source_file, confidence: confOf(b) }
  )

// Date-comparison caveat (applies to `outranks` and `laterEntry`): comparison is lexical — correct for
// same-precision ISO-8601 strings, but a bare date sorts BELOW a full timestamp of the same day
// ("2026-01-15" < "2026-01-15T10:00:00Z"). ingestExtraction stamps whatever precision the transcript
// frontmatter carries, so mixed-precision same-day meetings resolve deterministically, though not
// strictly chronologically within the day.
//
// `outranks` is a TOTAL order for every case merge ever hits EXCEPT one: two candidates tied on
// (confidence tier, date, source_file) but carrying DIFFERENT values. That can only happen via
// sequential, index-guarded re-ingestion of a changed extraction for the exact same source_file+date
// (never via shuffled/parallel backfill, which always sees distinct source_file values) — a case this
// codebase never actually produces, so the tie is unreachable in practice, not merely unhandled.
//
// Lives here (with laterEntry/pushSuperseded) rather than in ingest.ts for the same import-cycle reason
// as everything else in this block: ingest.ts's mergeProvenant AND corrections.ts's merge-time provenance
// fold both rank machine-extracted candidates by this one order, and corrections.ts cannot import from
// ingest.ts.
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

/** Append `entry` to a field's superseded history, deduped per value (keeping the max-(confidence tier,
 *  date, source_file) sighting — MI-4: the same `outranks` order winner selection uses, via `laterEntry`
 *  above), never containing the current value, sorted by that same key descending and capped at 10. Used
 *  by BOTH ingest.ts's mergeProvenant (rank-gated: the incoming candidate only wins if it `outranks` what's
 *  held) and corrections.ts's field-pin (unconditional: a human pin always wins) — the two are genuinely
 *  different operations that happen to share this one history primitive. */
export function pushSuperseded<T>(
  list: SupersededEntry<T>[],
  entry: SupersededEntry<T>,
  currentValue: T,
  valuesEqual: (a: T, b: T) => boolean
): SupersededEntry<T>[] {
  const out: SupersededEntry<T>[] = []
  for (const e of [...list, entry]) {
    if (valuesEqual(e.value, currentValue)) continue // superseded holds only values DIFFERENT from current
    const i = out.findIndex((x) => valuesEqual(x.value, e.value))
    if (i === -1) out.push(e)
    else if (laterEntry(e, out[i])) out[i] = e // one entry per value — its most recent sighting
  }
  return out.sort((a, b) => (laterEntry(a, b) ? -1 : laterEntry(b, a) ? 1 : 0)).slice(0, 10)
}

/** Default value-equality for provenant fields whose value is a plain string/enum/nullable-enum
 *  (role, org, sector, stage, win_likelihood_band, close_date). */
export const eqStrict = <T>(a: T, b: T): boolean => a === b
/** Value-equality for the `velocity` provenant field's {signal, evidence} object shape. */
export const eqVelocity = (a: { signal: string; evidence: string }, b: { signal: string; evidence: string }): boolean =>
  a.signal === b.signal && a.evidence === b.evidence
/** Value-equality for the deal `amount` provenant field's {value, currency} object shape (MI-4). Lives
 *  here (not duplicated in ingest.ts/corrections.ts) for the same reason eqStrict/eqVelocity do — both
 *  modules' amount merges (mergeProvenant's extraction-time merge, pinProvenant's human-pin) need the
 *  identical equality rule so a value-identical re-confirmation is never miscounted as a change. */
export const eqAmount = (a: { value: number; currency: string }, b: { value: number; currency: string }): boolean =>
  a.value === b.value && a.currency === b.currency

/** readJson's cache returns the SAME object reference on a repeat read of an unchanged file (keyed by
 *  path+mtime+size, not by caller) — mutating it in place silently edits every other holder of that
 *  reference, and leaves the cache advertising a value that was never persisted if the write then fails.
 *  Every read-modify-write below and in corrections.ts clones first, so it only ever owns the copy it
 *  writes. Lives here beside withEntityLock: the mutations that need it span store.ts, ingest.ts and
 *  corrections.ts, and corrections.ts cannot import from ingest.ts (see the lock's own note). */
export function cloneEntity<T>(entity: T): T {
  return JSON.parse(JSON.stringify(entity)) as T
}
