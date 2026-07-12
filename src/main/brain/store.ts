import { existsSync, mkdirSync, readdirSync, rmSync, renameSync, statSync, cpSync } from 'node:fs'
import { join, basename } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import type { Settings } from '@shared/ipc'
import {
  BrainIndexSchema,
  BrainGraphSchema,
  PersonEntitySchema,
  AccountEntitySchema,
  DealEntitySchema,
  MeetingExtractionSchema,
  type BrainIndex,
  type BrainGraph,
  type PersonEntity,
  type AccountEntity,
  type DealEntity,
  type MeetingExtraction,
  type Confidence,
  type ProvenantField
} from '@shared/brain'
import { resolveMeetingsFolder, readSavedFile, writeSaved } from '../transcripts'

/**
 * Brain store — plain JSON files under `<meetings folder>/.brain/`.
 *
 * Lives NEXT TO the transcripts on purpose: it inherits the user's folder choice, OneDrive sync (so
 * Dust agents can read it as vault context), and — critically — the same at-rest encryption setting.
 * When encryptTranscripts is on, every brain file is written through the same ATKENC envelope as the
 * transcripts themselves (writeSaved/readSavedFile handle both forms transparently).
 */

export function brainDir(settings: Settings): string {
  return join(resolveMeetingsFolder(settings), '.brain')
}

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

export function slugify(s: string): string {
  const full = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics so "L'Oréal" and "L'Oreal" share a slug
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  // Two distinct long names that share an identical 60-char prefix would otherwise collide onto the
  // same slug and silently merge their entity files. Only truncate when needed, and disambiguate the
  // truncation with a short content hash so different long names still map to different slugs.
  const base =
    full.length > 60
      ? `${full.slice(0, 51)}-${createHash('sha256').update(full).digest('hex').slice(0, 8)}`
      : full
  // A slug that's a bare Windows reserved device name (CON, AUX, NUL, COM1-9, LPT1-9) can't be opened
  // as a file on Windows — not even the intermediate .tmp writeSaved creates, since the reserved check
  // is on the basename before the first '.'. Suffix deterministically so the slug stays stable.
  if (base && WIN_RESERVED_NAMES.has(base)) return `${base}-x`
  if (base) return base
  // A name written entirely in a non-Latin script (Chinese, Cyrillic, Arabic, pure emoji) or one
  // that's blank/whitespace-only collapses the ASCII pass above to '' — falling back to a fixed
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

function ensureDirs(settings: Settings): string {
  const root = brainDir(settings)
  for (const d of [root, join(root, 'meetings'), join(root, 'entities', 'person'), join(root, 'entities', 'account'), join(root, 'entities', 'deal')]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
  }
  return root
}

// Per-file parse cache validated by (mtimeMs, size), mirroring the proven pattern in recall.ts (readCache).
// Three independent pollers (Mantu Intelligence dashboard status, RecallView's brain badge, the full
// brainRead dataset) hit these same index/graph/entity files every 3-10s — without this, every poll
// re-read + decrypted + JSON.parsed + zod-validated every file from scratch. A stat() replaces that full
// round trip when the file is unchanged; any mtime/size change (including our own writes, see writeJson
// below) re-reads. Corrupt/absent files cache `null` too, so they stop costing repeated reads.
const jsonCache = new Map<string, { mtimeMs: number; size: number; value: unknown }>()
const JSON_CACHE_MAX = 2000 // safety valve — see recall.ts's identical guard

// Exported (unchanged otherwise) so the correction engine (src/main/brain/corrections.ts) can read/write
// brain-relative JSON that doesn't fit a strict entity schema — a merged-away entity's tombstone
// ({schema_version, id, merged_into}) and the `.brain/corrections.json` journal itself both go through
// these, inheriting the exact same cache/encryption semantics as every typed accessor below.
export function readJson<T>(settings: Settings, rel: string, parse: (v: unknown) => T): T | null {
  const p = join(brainDir(settings), rel)
  let mtimeMs: number
  let size: number
  try {
    const st = statSync(p)
    mtimeMs = st.mtimeMs
    size = st.size
  } catch {
    jsonCache.delete(p)
    return null
  }
  const hit = jsonCache.get(p)
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.value as T
  let value: T | null
  try {
    value = parse(JSON.parse(readSavedFile(p)))
  } catch {
    value = null // corrupt/undecryptable file — callers treat as absent; ingest will rewrite it
  }
  if (jsonCache.size >= JSON_CACHE_MAX) jsonCache.clear()
  jsonCache.set(p, { mtimeMs, size, value })
  return value
}

export async function writeJson(settings: Settings, rel: string, value: unknown): Promise<void> {
  ensureDirs(settings)
  const p = join(brainDir(settings), rel)
  await writeSaved(p, JSON.stringify(value, null, 2), !!settings.encryptTranscripts)
  // Invalidate rather than pre-populate: `value` here is the pre-serialize object, not necessarily
  // byte-identical to what a fresh parse() of the written JSON would yield (zod defaults/transforms) —
  // and relying on mtime alone risks a same-mtime rapid write-then-read on low-resolution filesystems.
  jsonCache.delete(p)
}

// MI-2.5 Fix C: the ONE serialization lane every read-modify-write mutation of `.brain/` entity files
// (account/person/deal/graph — none of which have their own per-file lock the way index.json has via
// ingest.ts's own indexLock) must go through. Before this fix, ingest.ts's in-flight backfill/ingest jobs
// serialized against a PRIVATE module-level `ingestChain` promise that corrections.ts's five correction
// mutations (rename/merge/unmerge/field-pin/commitment-reject) never joined — a correction running
// concurrently with an in-flight backfill could lose an update or resurrect a tombstoned entity (a
// backfill job that captured its alias map before a merge writing the pre-merge entity back over it).
// Lives here, not in ingest.ts, for the same import-cycle reason as commitmentKey/pushUnique/outranks
// above: corrections.ts cannot import from ingest.ts (ingest.ts already imports FROM corrections.ts), so
// the ONE primitive both files' mutations must share has to sit below both, not inside either.
let entityMutationLock: Promise<void> = Promise.resolve()
export function withEntityLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = entityMutationLock.then(fn)
  // Never let a rejection wedge the lane for the next caller — mirrors ingest.ts's own indexLock
  // (`indexLock = run.catch(() => {})`), which this replaces as the ingest side's own serialization lane.
  entityMutationLock = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

// ── v1 → v2 lazy migration (B2) ──────────────────────────────────────────────
//
// A v1 entity file has role/org/sector/stage/win_likelihood_band/velocity as plain values with zero
// per-field provenance. Rather than replacing those fields in place (see the ProvenantField doc comment
// in shared/brain.ts for why that would break buildBrainContext/mars.ts/BrainView.tsx), v2 keeps them
// exactly as they are and adds a `<field>_provenance` sidecar the first time each file is read. The
// sidecar is synthesized HONESTLY, never fabricated:
//   - source_file: '' — we genuinely don't know which meeting first asserted the value; inventing one
//     would be a fabricated citation, so it stays empty (an honest "unknown" sentinel).
//   - date: the entity's EARLIEST known meeting date — the best available lower bound for when this
//     value could first have been true — or '' if the entity has no dated meetings at all.
//   - confidence: reuses the field's own REAL historical confidence where one already existed on disk
//     (AccountEntity.sector_confidence); everything else (role/org/stage/band/velocity) never had a
//     per-field confidence in v1, so it gets 'INFERRED' — honest because we cannot claim EXTRACTED-grade
//     provenance for a value that was never tagged as such.
//   - state: 'extracted' — the normal merge/date-gate rules apply to it going forward.
// Migration never fires for a field whose plain value is absent (null/''/the bland velocity default) —
// there is nothing to attach honest provenance to.

function earliestDate(meetings: Array<{ date: string }>): string {
  const dates = meetings.map((m) => m.date).filter(Boolean).sort()
  return dates[0] ?? ''
}

function migrateField<T>(
  value: T,
  meetings: Array<{ date: string }>,
  confidence: Confidence = 'INFERRED',
  quote?: string
): ProvenantField<T> {
  return { value, source_file: '', date: earliestDate(meetings), quote, confidence, state: 'extracted', superseded: [] }
}

function migratePerson(p: PersonEntity, slug: string): PersonEntity {
  p.id = p.id || slug
  p.aliases ??= []
  if (!p.role_provenance && p.role) p.role_provenance = migrateField(p.role, p.meetings)
  if (!p.org_provenance && p.account) p.org_provenance = migrateField(p.account, p.meetings)
  return p
}

function migrateAccount(a: AccountEntity, slug: string): AccountEntity {
  a.id = a.id || slug
  a.aliases ??= []
  if (!a.sector_provenance) a.sector_provenance = migrateField(a.sector, a.meetings, a.sector_confidence)
  return a
}

function migrateDeal(d: DealEntity, slug: string): DealEntity {
  d.id = d.id || slug
  d.aliases ??= []
  if (!d.stage_provenance && d.stage) d.stage_provenance = migrateField(d.stage, d.meetings)
  if (!d.win_likelihood_band_provenance && d.win_likelihood_band) {
    d.win_likelihood_band_provenance = migrateField(d.win_likelihood_band, d.meetings, 'INFERRED', d.band_evidence || undefined)
  }
  if (!d.velocity_provenance && d.velocity.signal !== 'no-hard-date-found') {
    d.velocity_provenance = migrateField(d.velocity, d.meetings)
  }
  return d
}

// ── One-time backup before the first v2 write into a brain that still has v1 files ──────────────────
//
// Belt-and-suspenders for the migration above: before ANY v2-shaped entity file lands in a `.brain/`
// directory that currently holds v1 files, the whole directory is snapshotted to `.brain.backup-v1`
// once. Copies files exactly as they sit on disk (respects encryption — an encrypted file's ATKENC
// envelope is copied verbatim, never decrypted/re-encrypted). Memoized per brainDir so a long backfill
// (many sequential entity writes) only pays for the existence check once it knows the answer.
const backupHandled = new Set<string>()

function isV1EntityFile(path: string): boolean {
  try {
    const raw = JSON.parse(readSavedFile(path)) as { schema_version?: number }
    return raw.schema_version !== 2
  } catch {
    return true // unreadable/corrupt — can't prove it's v2, so err toward including it in the safety copy
  }
}

function brainHasV1Entities(settings: Settings): boolean {
  const root = brainDir(settings)
  for (const kind of ['person', 'account', 'deal'] as const) {
    const dir = join(root, 'entities', kind)
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.json') && isV1EntityFile(join(dir, f))) return true
    }
  }
  return false
}

// Exported so corrections.ts's raw (schema-unchecked) tombstone writes get the same one-time v1 safety
// copy as writePerson/writeAccount/writeDeal below — a merge can tombstone an entity file in a brain
// that still has other not-yet-migrated v1 files sitting alongside it.
export function ensureV1Backup(settings: Settings): void {
  const root = brainDir(settings)
  if (backupHandled.has(root)) return
  const backup = `${root}.backup-v1`
  if (existsSync(backup)) {
    backupHandled.add(root) // a complete backup already exists (see the atomic tmp+rename below)
    return
  }
  if (!brainHasV1Entities(settings)) {
    backupHandled.add(root) // nothing to back up — also memoize, so this scan isn't repeated on every write
    return
  }
  // MI-2.5 Fix H: copy to a TEMP sibling dir first, then rename atomically into the final `.backup-v1`
  // name — mirrors writeSaved's own tmp+rename convention. This is what makes `existsSync(backup)` above
  // a trustworthy "the backup is complete" signal: a cpSync that throws partway (a dataless OneDrive
  // Files-On-Demand placeholder, an AV lock) never leaves anything at the FINAL name, so the next write's
  // retry sees no backup and tries again from scratch — instead of the pre-fix bug, where a half-copied
  // `.backup-v1` DIRECTORY already existing at the final name was silently treated as "done", hiding an
  // incomplete safety copy forever (backupHandled was also marked BEFORE the attempt, compounding it).
  const tmp = `${backup}.tmp-${randomBytes(6).toString('hex')}`
  try {
    cpSync(root, tmp, { recursive: true })
    renameSync(tmp, backup)
    backupHandled.add(root) // memoize success only now — never before the backup is verifiably complete
  } catch (e) {
    try {
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true }) // no orphaned partial copy left behind
    } catch {
      /* best-effort cleanup of the failed partial copy */
    }
    console.warn('[brain] could not create .brain.backup-v1 safety copy before v2 migration — will retry on the next write:', e)
    // Deliberately NOT memoized and NOT re-thrown: a v1 safety net failing must not permanently block
    // every future correction/entity write until a human intervenes (a hard-refuse would do exactly
    // that, since OneDrive/AV holds are often transient) — the next write's own ensureV1Backup call
    // retries the copy from scratch instead.
  }
}

// ── Typed accessors ──────────────────────────────────────────────────────────

export const readIndex = (s: Settings): BrainIndex =>
  readJson(s, 'index.json', (v) => BrainIndexSchema.parse(v)) ?? BrainIndexSchema.parse({})
export const writeIndex = (s: Settings, v: BrainIndex): Promise<void> => writeJson(s, 'index.json', v)

export const readGraph = (s: Settings): BrainGraph =>
  readJson(s, 'graph.json', (v) => BrainGraphSchema.parse(v)) ?? BrainGraphSchema.parse({})
export const writeGraph = (s: Settings, v: BrainGraph): Promise<void> => writeJson(s, 'graph.json', v)

export const readMeetingExtraction = (s: Settings, fileSlug: string): MeetingExtraction | null =>
  readJson(s, join('meetings', `${fileSlug}.json`), (v) => MeetingExtractionSchema.parse(v))
export const writeMeetingExtraction = (s: Settings, fileSlug: string, v: MeetingExtraction): Promise<void> =>
  writeJson(s, join('meetings', `${fileSlug}.json`), v)

export const readPerson = (s: Settings, slug: string): PersonEntity | null =>
  readJson(s, join('entities', 'person', `${slug}.json`), (v) => migratePerson(PersonEntitySchema.parse(v), slug))
export const writePerson = (s: Settings, slug: string, v: PersonEntity): Promise<void> => {
  ensureV1Backup(s)
  return writeJson(s, join('entities', 'person', `${slug}.json`), v)
}

export const readAccount = (s: Settings, slug: string): AccountEntity | null =>
  readJson(s, join('entities', 'account', `${slug}.json`), (v) => migrateAccount(AccountEntitySchema.parse(v), slug))
export const writeAccount = (s: Settings, slug: string, v: AccountEntity): Promise<void> => {
  ensureV1Backup(s)
  return writeJson(s, join('entities', 'account', `${slug}.json`), v)
}

export const readDeal = (s: Settings, slug: string): DealEntity | null =>
  readJson(s, join('entities', 'deal', `${slug}.json`), (v) => migrateDeal(DealEntitySchema.parse(v), slug))
export const writeDeal = (s: Settings, slug: string, v: DealEntity): Promise<void> => {
  ensureV1Backup(s)
  return writeJson(s, join('entities', 'deal', `${slug}.json`), v)
}

/**
 * Set a deal's outcome (open/won/lost) — the human closes the loop the LLM never may (see the
 * DealEntitySchema.outcome doc comment in shared/brain.ts). Returns the updated entity, or null when
 * the slug doesn't match any deal on disk (deleted, mistyped, or never ingested).
 */
export async function setDealOutcome(
  s: Settings,
  dealSlug: string,
  outcome: DealEntity['outcome']
): Promise<DealEntity | null> {
  const deal = readDeal(s, dealSlug)
  if (!deal) return null
  deal.outcome = outcome
  await writeDeal(s, dealSlug, deal)
  return deal
}

/** List entity slugs of a kind (file basenames sans .json). Sorted: readdirSync order is
 *  platform/filesystem-dependent, and readAliasMap iterates this — a stable order makes alias-key
 *  collision resolution (last write wins) deterministic across machines and runs. */
export function listEntities(s: Settings, kind: 'person' | 'account' | 'deal'): string[] {
  const dir = join(brainDir(s), 'entities', kind)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => basename(f, '.json'))
    .sort()
}

export function listMeetingExtractions(s: Settings): string[] {
  const dir = join(brainDir(s), 'meetings')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => basename(f, '.json'))
}

/**
 * Erase the entire `.brain/` store — every meeting extraction, entity file, the graph, and the index.
 *
 * Part of "Delete all Métis data": the brain IS the knowledge graph now (the old userData/graph
 * artifacts are legacy), and it holds the most sensitive derived data — named people, verbatim
 * commitment quotes, stance trails. A wipe that leaves it on disk would break the dialog's promise
 * that "every transcript, note, and the knowledge graph" is removed. Best-effort: never throws, so a
 * locked file can't abort the surrounding meeting wipe. Returns whether the directory is gone.
 *
 * `preserveCorrections` (Task MI-2): brain:rebuildAll purges the DERIVED store and re-extracts
 * everything, but the human correction journal (`.brain/corrections.json`) is not derived data — it's
 * the record of explicit human actions the rebuild's own replayCorrections() step depends on to
 * reproduce the live-corrected state. A rebuild that let this wipe destroy the journal would replay
 * nothing and resurrect every misheard/merged-away entity the journal had already fixed — exactly the
 * divergence the correction engine exists to prevent. recallDeleteAll's full-erasure call site leaves
 * this false on purpose: that flow's explicit promise is "every transcript, note, and the knowledge
 * graph" gone, corrections included. Copies the journal's raw on-disk bytes (respects encryption,
 * mirroring ensureV1Backup's cpSync convention above) rather than decrypting/re-encrypting it.
 */
export function purgeBrain(settings: Settings, opts: { preserveCorrections?: boolean } = {}): { ok: boolean } {
  const root = brainDir(settings)
  const journalPath = join(root, 'corrections.json')
  const preserveTo = `${root}.corrections-preserve.json`
  let preserve = false
  try {
    preserve = !!opts.preserveCorrections && existsSync(journalPath)
    if (preserve) cpSync(journalPath, preserveTo)
    if (existsSync(root)) rmSync(root, { recursive: true, force: true })
    if (preserve) {
      mkdirSync(root, { recursive: true })
      cpSync(preserveTo, journalPath)
      rmSync(preserveTo, { force: true })
      // Everything except the restored journal is confirmed gone; the journal's presence here is
      // deliberate, not a failed wipe — success means "nothing but the preserved file remains".
      const remaining = readdirSync(root)
      return { ok: remaining.length === 1 && remaining[0] === 'corrections.json' }
    }
    return { ok: !existsSync(root) }
  } catch (e) {
    console.warn('[brain] purgeBrain: could not remove', root, e)
    // MI-2.5 Fix F: a mid-wipe failure (OneDrive/AV holding a file open partway through the recursive
    // delete) must never leave the correction journal recoverable ONLY under the escrow sibling name —
    // restore it into `root` here regardless of how far the failed wipe got (root may be fully gone,
    // partially emptied, or untouched). Best-effort and never throws out of this already-failing path;
    // the caller still gets `ok: false` either way and must abort rather than proceed with a rebuild atop
    // an unverified store.
    if (preserve) {
      try {
        if (existsSync(preserveTo)) {
          if (!existsSync(root)) mkdirSync(root, { recursive: true })
          cpSync(preserveTo, journalPath)
          rmSync(preserveTo, { force: true })
        }
      } catch (restoreErr) {
        console.warn('[brain] purgeBrain: could not restore preserved journal after failed wipe', restoreErr)
      }
    }
    return { ok: false }
  }
}
