import { join } from 'node:path'
import { z } from 'zod'
import type { Settings } from '@shared/ipc'
import {
  BRAIN_SCHEMA_VERSION,
  PersonEntitySchema,
  AccountEntitySchema,
  DealEntitySchema,
  SectorSchema,
  BandSchema,
  VelocitySchema,
  AmountValueSchema,
  CorrectionsJournalSchema,
  type EntityKind,
  type CorrectionEntry,
  type PersonEntity,
  type AccountEntity,
  type DealEntity,
  type MeetingExtraction,
  type ProvenantField
} from '@shared/brain'
import { readSavedFile } from '../transcripts'
import { mainLog } from '../logger'
import {
  brainDir,
  slugify,
  commitmentKey,
  pushUnique,
  pushSuperseded,
  outranks,
  eqStrict,
  eqVelocity,
  readJson,
  writeJson,
  ensureV1Backup,
  readPerson,
  writePerson,
  readAccount,
  writeAccount,
  readDeal,
  writeDeal,
  readGraph,
  writeGraph,
  listEntities
} from './store'

/**
 * Correction engine (Task MI-2) — journal, aliases, and the human-correction mutations themselves.
 *
 * SINGLE MUTATION IMPLEMENTATION (the whole point of this file): every correction — rename, merge,
 * unmerge, field pin, commitment reject — is implemented exactly ONCE, as a private `applyXxx` function
 * below. The public `xxxEntity`/`updateEntityField`/`rejectCommitment` wrappers call `applyXxx` and then
 * append a journal entry; `replayCorrections` (driven by `brain:rebuildAll`, see ingest.ts) calls the
 * SAME `applyXxx` functions directly, in journal order, without re-appending. If live and replay ever
 * diverged, a rebuild would resurrect a misheard/merged-away entity a human already fixed — that's the
 * property the rebuild-converges test guards.
 *
 * Only `field_update` writes anything time-sensitive into an entity file (a pin's `date`). Its `applyXxx`
 * therefore takes an explicit `at` timestamp: the live wrapper captures `new Date().toISOString()` once
 * and uses it for BOTH the journal entry and the mutation; replay passes the journal entry's own `at`
 * back in, so a rebuild reproduces byte-identical provenance dates instead of "now".
 */

const ENTITY_KINDS = ['person', 'account', 'deal'] as const
const CORRECTIONS_REL = 'corrections.json'

// ── Journal ──────────────────────────────────────────────────────────────────

/** Read `.brain/corrections.json` — tolerant of an absent/corrupt file (treated as an empty journal,
 *  the same "never block on a bad derived file" posture as every other brain read). */
export function readCorrectionsJournal(s: Settings): CorrectionEntry[] {
  const raw = readJson<unknown>(s, CORRECTIONS_REL, (v) => v)
  if (raw === null) return []
  const parsed = CorrectionsJournalSchema.safeParse(raw)
  return parsed.success ? parsed.data : []
}

/** Append one entry, assigning it the next `seq` (the journal's own length — append-only, so entries
 *  are always contiguous 0..n-1). `entry.seq` as passed in is a placeholder, always overwritten here. */
async function appendCorrectionEntry(s: Settings, entry: CorrectionEntry): Promise<CorrectionEntry> {
  const journal = readCorrectionsJournal(s)
  const withSeq = { ...entry, seq: journal.length } as CorrectionEntry
  journal.push(withSeq)
  await writeJson(s, CORRECTIONS_REL, journal)
  return withSeq
}

// ── Raw (schema-unchecked) entity file access — tombstones + the alias map ──────────────────────────
//
// A merged-away entity's file is replaced by a small {schema_version, id, merged_into} tombstone that
// does not fit PersonEntitySchema/AccountEntitySchema/DealEntitySchema (readPerson/readAccount/readDeal
// correctly treat it as "absent" — their zod .parse() throws, and store.ts's readJson catches that as
// null). Building the alias map needs to tell a tombstone apart from a live entity, which means reading
// the SAME file path through a DIFFERENT (schema-unchecked) parse than the typed readers use.
//
// That read deliberately BYPASSES store.ts's jsonCache rather than reusing the exported readJson: the
// cache is keyed by file path only (not by which parse function produced the cached value), so caching
// a raw parse here under a path a typed reader (readPerson etc.) reads moments later — e.g. readAliasMap
// scans every entity right before ingestExtraction's own mergeExtraction typed-reads the very same ones
// — would let whichever parse ran first silently satisfy the other, returning unmigrated/unvalidated
// data as if it were a real PersonEntity. Reading raw straight off disk every time avoids that entirely;
// it's not a hot path (once per meeting ingest, same order of cost as lintBrain's own full entity scan).
function rawEntityPath(s: Settings, kind: EntityKind, slug: string): string {
  return join(brainDir(s), 'entities', kind, `${slug}.json`)
}

function readRawEntityFile(s: Settings, kind: EntityKind, slug: string): unknown | null {
  try {
    return JSON.parse(readSavedFile(rawEntityPath(s, kind, slug)))
  } catch {
    return null
  }
}

/** Tombstone writes DO go through the shared writeJson (unlike the raw read above) — a write always
 *  invalidates store.ts's cache for this path, which is exactly what every later typed reader needs. */
function writeRawEntityFile(s: Settings, kind: EntityKind, slug: string, value: unknown): Promise<void> {
  ensureV1Backup(s)
  return writeJson(s, join('entities', kind, `${slug}.json`), value)
}

interface Tombstone {
  schema_version: number
  id: string
  merged_into: string
}

function asTombstone(v: unknown): Tombstone | null {
  if (
    v &&
    typeof v === 'object' &&
    typeof (v as Record<string, unknown>).merged_into === 'string' &&
    typeof (v as Record<string, unknown>).id === 'string'
  ) {
    return v as Tombstone
  }
  return null
}

/** Follow a chain of tombstones to the current live id, cycle-guarded. Merges only ever tombstone a
 *  LIVE entity (applyMerge refuses when either side is already merged away), so a chain longer than one
 *  hop only arises from a later, separate merge of the same target — still resolved iteratively here. */
function resolveTombstone(s: Settings, kind: EntityKind, id: string): string {
  const seen = new Set<string>([id])
  let current = id
  for (;;) {
    const tomb = asTombstone(readRawEntityFile(s, kind, current))
    if (!tomb) return current
    if (seen.has(tomb.merged_into)) return current // cycle guard — bail at the last good id
    seen.add(tomb.merged_into)
    current = tomb.merged_into
  }
}

export type AliasEntry = { kind: EntityKind; id: string; displayName: string }
export type AliasMap = Map<string, AliasEntry>

/**
 * Build the alias map from the ENTITY FILES on disk: every entity's `aliases[]` (which already includes
 * an old display name and id once a rename/merge has happened) plus a defensive redirect for each
 * tombstone's own id. Normalization mirrors slugify's own casefold/diacritic-strip, so "L'Oreal" and
 * "L'Oréal" collide onto the same key. Reads raw (see readRawEntityFile's doc comment) rather than
 * through the typed readPerson/readAccount/readDeal — deliberately: this function scans every entity,
 * and ingest calls it immediately before its own typed reads of some of the same files.
 *
 * Registers each entity's CURRENT name too, not just its old aliases: `id` is immutable (fixed at
 * creation to slugify(original name)) while mergeExtraction still routes new meetings to a file by
 * re-slugifying whatever name arrives. Once a rename makes `id` diverge from slugify(current name) (e.g.
 * id "acme-corp", renamed to display "Acme"), mergeExtraction MUST resolve through this map — including
 * for the current name itself — or it would silently create a second "acme" file instead of updating the
 * existing one.
 *
 * Also the base layer readAliasMap below unions with journal-derived aliases. Since the MI-2 review fix,
 * THAT union map is what both file routing and display rewriting use (see ingestExtraction's wiring
 * comment) — eagerly rewriting from the journal during a rebuild's re-ingest is safe because applyRename
 * retroactively repaints every already-baked dependent display string at rename time, live and replay
 * alike, so the two paths converge regardless of which one baked a given string first.
 */
export function readEntityAliasMap(s: Settings): AliasMap {
  const map: AliasMap = new Map()
  const set = (alias: string, entry: AliasEntry): void => {
    const key = slugify(alias)
    if (key) map.set(key, entry)
  }
  for (const kind of ENTITY_KINDS) {
    for (const slug of listEntities(s, kind)) {
      const raw = readRawEntityFile(s, kind, slug)
      const tomb = asTombstone(raw)
      if (tomb) {
        const liveId = resolveTombstone(s, kind, slug)
        const liveRaw = readRawEntityFile(s, kind, liveId) as { name?: unknown } | null
        const liveName = liveRaw && typeof liveRaw.name === 'string' ? liveRaw.name : null
        if (liveName) set(tomb.id, { kind, id: liveId, displayName: liveName })
        continue
      }
      const obj = raw as { id?: unknown; name?: unknown; aliases?: unknown } | null
      if (!obj || typeof obj.name !== 'string') continue
      const id = typeof obj.id === 'string' && obj.id ? obj.id : slug
      const aliases = Array.isArray(obj.aliases) ? obj.aliases.filter((a): a is string => typeof a === 'string') : []
      set(obj.name, { kind, id, displayName: obj.name })
      for (const alias of aliases) set(alias, { kind, id, displayName: obj.name })
    }
  }
  return map
}

/**
 * Build an alias map from the CORRECTION JOURNAL alone — pure function of the entries, no disk access.
 *
 * This exists because a rebuild re-ingests every meeting BEFORE replayCorrections runs: at re-ingest
 * time the freshly recreated entity files carry no aliases, so a meeting saved AFTER a rename (using
 * the corrected name, whose slug differs from the entity's immutable id) has no entity-file witness
 * that it belongs to the existing entity — re-ingest would fork a duplicate. The journal is that
 * witness. Processed in `seq` order:
 *   - entity_rename: the old display name (from the entry's snapshot), the entity's immutable id, and
 *     the new name all map to (id, newName). Chains resolve TRANSITIVELY — A→B then B→C leaves every
 *     surface form of the entity (A, B, C, id) pointing at displayName C — because each rename first
 *     repoints every existing map entry carrying this entity's id.
 *   - entity_merge: all of `from`'s surface forms (display name + aliases from the entry's snapshot,
 *     plus fromId itself) map to `into`'s canonical (intoId, into's display name as of this point in
 *     the journal). Existing entries pointing at fromId are repointed too, so rename-then-merge and
 *     merge-chain histories stay transitive.
 *   - entity_unmerge ANNULS its target merge: after an unmerge, `from` is a live entity again, so
 *     routing its surface forms into `into` would corrupt future ingests. Annulled merges are skipped
 *     entirely (pre-scanned), which also keeps replay-order semantics: renames of either side keyed by
 *     id still apply.
 */
export function aliasMapFromJournal(entries: CorrectionEntry[]): AliasMap {
  const map: AliasMap = new Map()
  const set = (alias: string, entry: AliasEntry): void => {
    const key = slugify(alias)
    if (key) map.set(key, entry)
  }
  /** Repoint every surface form currently resolving to (kind, id) — the transitivity workhorse. */
  const repoint = (kind: EntityKind, id: string, next: AliasEntry): void => {
    for (const [k, v] of map) if (v.kind === kind && v.id === id) map.set(k, next)
  }
  const annulled = new Set<number>()
  for (const e of entries) if (e.kind === 'entity_unmerge') annulled.add(e.payload.targetSeq)
  // Current display name per `${kind}:${id}` as of the entries processed so far.
  const displayNames = new Map<string, string>()
  for (const e of [...entries].sort((a, b) => a.seq - b.seq)) {
    if (e.kind === 'entity_rename') {
      const { kind, id, newName } = e.payload
      displayNames.set(`${kind}:${id}`, newName)
      const entry: AliasEntry = { kind, id, displayName: newName }
      repoint(kind, id, entry)
      if (e.snapshot?.oldName) set(e.snapshot.oldName, entry)
      set(id, entry)
      set(newName, entry)
    } else if (e.kind === 'entity_merge' && !annulled.has(e.seq)) {
      const { kind, fromId, intoId } = e.payload
      const snapInto = e.snapshot?.intoEntity as { name?: unknown } | null | undefined
      const displayName =
        displayNames.get(`${kind}:${intoId}`) ??
        (snapInto && typeof snapInto.name === 'string' ? snapInto.name : intoId)
      displayNames.set(`${kind}:${intoId}`, displayName)
      const entry: AliasEntry = { kind, id: intoId, displayName }
      repoint(kind, fromId, entry)
      const snapFrom = e.snapshot?.fromEntity as { name?: unknown; aliases?: unknown } | null | undefined
      if (snapFrom && typeof snapFrom.name === 'string') set(snapFrom.name, entry)
      if (snapFrom && Array.isArray(snapFrom.aliases)) {
        for (const a of snapFrom.aliases) if (typeof a === 'string') set(a, entry)
      }
      set(fromId, entry)
      set(intoId, entry)
    }
  }
  return map
}

/**
 * The full alias map: entity-file-derived aliases UNIONED with journal-derived aliases (journal wins on
 * a key conflict — it is the record of explicit human intent, and overlaying it also closes live-path
 * ordering holes where an entity file lags the journal). Used for BOTH file ROUTING and display
 * REWRITING (ingestExtraction's applyCorrections call) — see applyRename's own doc comment for the half
 * of the fix that makes a single union map safe for both.
 */
export function readAliasMap(s: Settings): AliasMap {
  const map = readEntityAliasMap(s)
  for (const [k, v] of aliasMapFromJournal(readCorrectionsJournal(s))) map.set(k, v)
  return map
}

/**
 * Rewrite a fresh extraction's names through the alias map BEFORE mergeExtraction runs, so a meeting
 * that (re)uses a corrected-away name (e.g. "Acme Corp" after a rename to "Acme") lands on the entity a
 * human already fixed, rather than quietly recreating the one they renamed away from. Exact-normalized
 * match only — no fuzzy matching. Mutates `x` in place (ingestExtraction already mutates it for the
 * source_file/date/source_mode stamps, so this matches the surrounding convention).
 */
export function applyCorrections(
  x: MeetingExtraction,
  aliasMap: Map<string, { kind: EntityKind; id: string; displayName: string }>
): void {
  const rewrite = (kind: EntityKind, name: string): string => {
    const hit = aliasMap.get(slugify(name))
    return hit && hit.kind === kind ? hit.displayName : name
  }
  if (x.account && x.account.name.trim()) x.account.name = rewrite('account', x.account.name)
  for (const p of x.people) {
    if (p.name.trim()) p.name = rewrite('person', p.name)
    if (p.org && p.org.trim()) p.org = rewrite('account', p.org)
  }
  if (x.deal && x.deal.name.trim()) x.deal.name = rewrite('deal', x.deal.name)
}

/** Resolve the file slug a name should route to: the alias map's id when a hit exists (an old alias OR
 *  the entity's own current name — see readAliasMap's doc comment for why the current name matters
 *  too), otherwise slugify(name) itself (a brand-new entity, or no aliasMap supplied at all — the exact
 *  pre-MI-2 behavior, so every call site that doesn't pass one is unaffected). */
export function resolveEntitySlug(
  aliasMap: Map<string, { kind: EntityKind; id: string; displayName: string }> | undefined,
  kind: EntityKind,
  name: string
): string {
  const hit = aliasMap?.get(slugify(name))
  return hit && hit.kind === kind ? hit.id : slugify(name)
}

// ── Shared entity dispatch + alias union ──────────────────────────────────────

function readTypedEntity(s: Settings, kind: EntityKind, slug: string): PersonEntity | AccountEntity | DealEntity | null {
  if (kind === 'person') return readPerson(s, slug)
  if (kind === 'account') return readAccount(s, slug)
  return readDeal(s, slug)
}

function writeTypedEntity(
  s: Settings,
  kind: EntityKind,
  slug: string,
  entity: PersonEntity | AccountEntity | DealEntity
): Promise<void> {
  if (kind === 'person') return writePerson(s, slug, entity as PersonEntity)
  if (kind === 'account') return writeAccount(s, slug, entity as AccountEntity)
  return writeDeal(s, slug, entity as DealEntity)
}

/** store.ts's readJson cache returns the SAME cached object reference on a repeat read of an unchanged
 *  file (keyed by path+mtime+size, not by caller) — mutating it in place would silently corrupt any
 *  other holder of that same reference (e.g. a caller that read the same entity moments earlier for its
 *  own purposes, or a snapshot object built from the pre-mutation read). Every correction below clones
 *  before mutating, so it only ever owns the copy it writes. */
function cloneEntity<T>(entity: T): T {
  return JSON.parse(JSON.stringify(entity)) as T
}

/** De-dups by slugify (case/diacritic-insensitive) while preserving whichever spelling was seen first —
 *  `existing` always wins over `additions`, matching "the current entity's own aliases stay put". */
function unionAliases(existing: string[], additions: string[]): string[] {
  const seen = new Set(existing.map((a) => slugify(a)))
  const out = [...existing]
  for (const a of additions) {
    const key = slugify(a)
    if (key && !seen.has(key)) {
      seen.add(key)
      out.push(a)
    }
  }
  return out
}

// ── entity_rename ────────────────────────────────────────────────────────────

/** Normalized "known surface forms" of an entity right before a rename mutates its own aliases: the old
 *  name plus every alias already on file (itself accumulated from earlier renames/merges). This is the
 *  match set the retroactive sweep below uses to decide whether an already-baked display string
 *  elsewhere is "about this entity" — slugify-normalized, matching every other alias lookup in this
 *  file, so an accented/cased variant still matches. */
function surfaceFormKeys(oldName: string, priorAliases: string[]): Set<string> {
  const keys = new Set<string>()
  for (const name of [oldName, ...priorAliases]) {
    const key = slugify(name)
    if (key) keys.add(key)
  }
  return keys
}

/** Account renamed: retroactively repaint every deal/person display string that named it under an old
 *  surface form (reviewer IMPORTANT: old-name-reuse-after-rename diverges live-vs-rebuild otherwise).
 *  `deal.account` is a plain (non-provenant) field populated once at deal creation from whatever the
 *  account was called then — nothing else ever refreshes it, so without this it would cite a pre-rename
 *  name forever. `person.org_provenance.value` (+ its plain `.account` mirror) is the CURRENT org; its
 *  `superseded` history is the org's past sightings — both name this same account and get the same
 *  treatment, via the existing pushSuperseded bookkeeping (dedupe/sort/cap unchanged), so a rebuilt
 *  history reads exactly like the live one instead of citing a name that exists nowhere else anymore. */
async function sweepAccountRenameDependents(s: Settings, newName: string, surfaceForms: Set<string>): Promise<void> {
  for (const slug of listEntities(s, 'deal')) {
    const deal = readDeal(s, slug)
    if (!deal || !surfaceForms.has(slugify(deal.account))) continue
    const working = cloneEntity(deal)
    working.account = newName
    await writeDeal(s, slug, working)
  }
  for (const slug of listEntities(s, 'person')) {
    const person = readPerson(s, slug)
    const prov = person?.org_provenance
    if (!person || !prov) continue
    const currentHit = surfaceForms.has(slugify(prov.value))
    const supersededHit = prov.superseded.some((e) => surfaceForms.has(slugify(e.value)))
    if (!currentHit && !supersededHit) continue
    const working = cloneEntity(person)
    const workingProv = working.org_provenance!
    if (currentHit) workingProv.value = newName
    let superseded: typeof workingProv.superseded = []
    for (const e of workingProv.superseded) {
      const value = surfaceForms.has(slugify(e.value)) ? newName : e.value
      superseded = pushSuperseded(superseded, { value, date: e.date, source_file: e.source_file }, workingProv.value, eqStrict)
    }
    workingProv.superseded = superseded
    working.org_provenance = workingProv
    working.account = workingProv.value
    await writePerson(s, slug, working)
  }
}

/** A person's identity changed (renamed, OR merged into another person — both callers below): retroactively
 *  repaint the bare display-name strings every account's `.people[]` holds (a plain array of names, not
 *  slugs — mergeExtraction pushes `p.name` verbatim, so a stale entry never self-corrects). Rewritten
 *  entries are re-deduped with the same exact-string `pushUnique` key mergeExtraction itself uses for
 *  this array, so a name change that makes two entries collide collapses them exactly like a fresh
 *  ingest would. `newName` is the entity's own new name for a rename, or the SURVIVING entity's
 *  (unchanged) current name for a merge. */
async function sweepPersonNameDependents(s: Settings, newName: string, surfaceForms: Set<string>): Promise<void> {
  for (const slug of listEntities(s, 'account')) {
    const account = readAccount(s, slug)
    if (!account || !account.people.some((n) => surfaceForms.has(slugify(n)))) continue
    const working = cloneEntity(account)
    const deduped: string[] = []
    for (const n of working.people) pushUnique(deduped, surfaceForms.has(slugify(n)) ? newName : n, (x) => x)
    working.people = deduped
    await writeAccount(s, slug, working)
  }
}

/** Every renamed entity has ONE graph node (`${kind}:${id}`, id immutable) whose `label` mergeExtraction
 *  only ever sets on FIRST sight (`addNode` dedupes by id) — so without this the node would go on
 *  showing the pre-rename name forever even though every other trace of the old name has been repainted. */
async function sweepGraphNodeLabel(s: Settings, kind: EntityKind, id: string, newName: string): Promise<void> {
  const graph = readGraph(s)
  const node = graph.nodes.find((n) => n.id === `${kind}:${id}`)
  if (!node || node.label === newName) return
  node.label = newName
  await writeGraph(s, graph)
}

async function applyRename(
  s: Settings,
  payload: { kind: EntityKind; id: string; newName: string },
  // Replay-only (mirrors applyMerge's own snapshotHint below): the journal entry's own recorded
  // pre-rename name. During a rebuild, applyCorrections' union-map display rewrite (readAliasMap) can
  // have ALREADY baked payload.newName into this very entity at re-ingest time — the journal knows the
  // rename before replay ever reaches it — so `entity.name` read here may no longer be the TRUE
  // historical old name. Using the journal's own snapshot instead keeps the alias this rename records
  // (and the surface-form set the sweep below matches against) correct regardless of what re-ingest
  // already baked. Never passed on the live path (renameEntity), where `entity.name` is always still
  // genuinely the old name — so live behavior is unchanged when this is omitted.
  snapshotHint?: { oldName: string }
): Promise<{ ok: boolean; error?: string; snapshot?: { oldName: string } }> {
  const entity = readTypedEntity(s, payload.kind, payload.id)
  if (!entity) return { ok: false, error: 'Entity not found.' }
  const working = cloneEntity(entity)
  const oldName = snapshotHint?.oldName ?? working.name
  const surfaceForms = surfaceFormKeys(oldName, working.aliases)
  working.aliases = unionAliases(working.aliases, [oldName])
  working.name = payload.newName
  await writeTypedEntity(s, payload.kind, payload.id, working)

  // Retroactive rewrite of every already-baked display string elsewhere that names this entity under an
  // old surface form. Lives INSIDE applyRename, so it is automatically journaled (the same single
  // entity_rename entry, nothing new) and automatically replayed (the very same call, live or replay) —
  // never a second, parallel implementation of the rename.
  if (payload.kind === 'account') await sweepAccountRenameDependents(s, payload.newName, surfaceForms)
  else if (payload.kind === 'person') await sweepPersonNameDependents(s, payload.newName, surfaceForms)
  await sweepGraphNodeLabel(s, payload.kind, payload.id, payload.newName)

  return { ok: true, snapshot: { oldName } }
}

/** Rename an entity's display name, pushing the old name into `aliases[]` (deduped, case-preserving).
 *  `id` (the slug) never changes. */
export async function renameEntity(
  s: Settings,
  payload: { kind: EntityKind; id: string; newName: string }
): Promise<{ ok: boolean; error?: string }> {
  const at = new Date().toISOString()
  const r = await applyRename(s, payload)
  if (!r.ok) return { ok: false, error: r.error }
  await appendCorrectionEntry(s, { seq: 0, at, kind: 'entity_rename', payload, snapshot: r.snapshot })
  return { ok: true }
}

// ── entity_merge / entity_unmerge ────────────────────────────────────────────

/**
 * Fold one provenant field at merge time — the deterministic winner between the two sides' candidates
 * (reviewer IMPORTANT 2: without this, a source-only field like from.role='CFO' silently vanished into
 * the snapshot). Precedence, in order:
 *   1. A side with no candidate loses to a side with one (source-only fields survive the merge).
 *   2. pinned/edited beats extracted/verified — a human's judgement beats the machine's.
 *   3. BOTH pinned/edited → `into` wins: the human chose the merge direction, so the surviving
 *      entity's own pin is the one they kept.
 *   4. Otherwise (both machine): the existing `outranks` total order (confidence tier, date,
 *      source_file) — the same winner a rebuild's per-meeting mergeProvenant would elect, which is
 *      what keeps rebuild + replay convergent with a live merge.
 * The loser's value (when different) and both sides' superseded histories fold into the winner's
 * `superseded` via pushSuperseded — the existing dedupe/cap/sort semantics, unchanged.
 */
function foldProvenant<T>(
  fromField: ProvenantField<T> | undefined,
  intoField: ProvenantField<T> | undefined,
  valuesEqual: (a: T, b: T) => boolean
): ProvenantField<T> | undefined {
  if (!fromField) return intoField
  if (!intoField) return fromField
  const humanFrom = fromField.state === 'pinned' || fromField.state === 'edited'
  const humanInto = intoField.state === 'pinned' || intoField.state === 'edited'
  const intoWins = humanFrom === humanInto ? (humanInto ? true : !outranks(fromField, intoField)) : humanInto
  const winner = intoWins ? intoField : fromField
  const loser = intoWins ? fromField : intoField
  let superseded = winner.superseded
  for (const e of loser.superseded) superseded = pushSuperseded(superseded, e, winner.value, valuesEqual)
  if (!valuesEqual(loser.value, winner.value)) {
    superseded = pushSuperseded(
      superseded,
      { value: loser.value, date: loser.date, source_file: loser.source_file },
      winner.value,
      valuesEqual
    )
  }
  return { ...winner, superseded }
}

async function applyMerge(
  s: Settings,
  payload: { kind: EntityKind; fromId: string; intoId: string },
  // Replay-only (see replayCorrections): the journal entry's own pre-merge snapshot. During a rebuild
  // the journal-derived alias map has already routed every one of `from`'s meetings straight into
  // `into` at re-ingest, so `from`'s file never exists when the merge replays — the snapshot then
  // stands in as the source, restoring exactly what the live merge moved (aliases, arrays — deduped
  // no-ops for whatever re-ingest already routed — the provenance fold, and the tombstone). Never
  // passed on the live path, so live behavior is unchanged: a genuinely missing source still refuses.
  snapshotHint?: { fromEntity?: unknown; intoEntity?: unknown }
): Promise<{ ok: boolean; error?: string; snapshot?: { fromEntity: unknown; intoEntity: unknown } }> {
  if (payload.fromId === payload.intoId) return { ok: false, error: 'Cannot merge an entity into itself.' }
  // readTypedEntity returns null for a tombstone (fails its strict schema parse) exactly like it does
  // for a genuinely absent file — so both sides are guaranteed LIVE entities once this passes, and a
  // chained re-merge of an already-merged-away id is refused rather than silently walking the chain.
  let from = readTypedEntity(s, payload.kind, payload.fromId)
  if (!from && snapshotHint) {
    const parsed = ENTITY_SCHEMA_BY_KIND[payload.kind].safeParse(snapshotHint.fromEntity)
    if (parsed.success) from = parsed.data
  }
  const into = readTypedEntity(s, payload.kind, payload.intoId)
  if (!from) return { ok: false, error: 'Source entity not found (already merged or does not exist).' }
  if (!into) return { ok: false, error: 'Target entity not found.' }

  // Full pre-merge snapshot of BOTH files, captured before any mutation — unmergeEntities restores from
  // this (on the live path; a replay's returned snapshot is never journaled).
  const snapshot = { fromEntity: JSON.parse(JSON.stringify(from)), intoEntity: JSON.parse(JSON.stringify(into)) }
  // Mutate a clone, never `into` itself — see cloneEntity's doc comment (readTypedEntity can return the
  // SAME cached reference as an earlier, unrelated read of this same file).
  const target = cloneEntity(into)

  target.aliases = unionAliases(target.aliases, [...from.aliases, from.name, from.id])

  if (payload.kind === 'person') {
    const f = from as PersonEntity
    const t = target as PersonEntity
    for (const m of f.meetings) pushUnique(t.meetings, m, (x) => x.file)
    for (const c of f.commitments) pushUnique(t.commitments, c, (x) => commitmentKey(x.text))
    for (const q of f.quotes) pushUnique(t.quotes, q, (x) => `${x.quote}|${x.meeting}`)
    for (const st of f.stance_trail) pushUnique(t.stance_trail, st, (x) => x.meeting + x.statement)
    // Provenance fold + plain-field mirror (the sidecar sync invariant holds through a merge too).
    t.role_provenance = foldProvenant(f.role_provenance, t.role_provenance, eqStrict)
    if (t.role_provenance) t.role = t.role_provenance.value
    t.org_provenance = foldProvenant(f.org_provenance, t.org_provenance, eqStrict)
    if (t.org_provenance) t.account = t.org_provenance.value
  } else if (payload.kind === 'account') {
    const f = from as AccountEntity
    const t = target as AccountEntity
    for (const m of f.meetings) pushUnique(t.meetings, m, (x) => x.file)
    for (const p of f.people) pushUnique(t.people, p, (x) => x)
    for (const d of f.deals) pushUnique(t.deals, d, (x) => x)
    for (const w of f.win_reasons) pushUnique(t.win_reasons, w, (x) => x.statement + x.meeting)
    for (const l of f.loss_reasons) pushUnique(t.loss_reasons, l, (x) => x.statement + x.meeting)
    t.sector_provenance = foldProvenant(f.sector_provenance, t.sector_provenance, eqStrict)
    if (t.sector_provenance) {
      t.sector = t.sector_provenance.value
      t.sector_confidence = t.sector_provenance.confidence
    }
  } else {
    const f = from as DealEntity
    const t = target as DealEntity
    for (const m of f.meetings) pushUnique(t.meetings, m, (x) => x.file)
    for (const c of f.commitments) pushUnique(t.commitments, c, (x) => commitmentKey(x.text))
    for (const sig of f.signals) pushUnique(t.signals, sig, (x) => x.meeting + x.statement)
    for (const ms of f.missed_signals) pushUnique(t.missed_signals, ms, (x) => x.meeting + x.statement)
    for (const fb of f.feedback) pushUnique(t.feedback, fb, (x) => x.meeting + x.note)
    t.stage_provenance = foldProvenant(f.stage_provenance, t.stage_provenance, eqStrict)
    if (t.stage_provenance) t.stage = t.stage_provenance.value
    t.win_likelihood_band_provenance = foldProvenant(
      f.win_likelihood_band_provenance,
      t.win_likelihood_band_provenance,
      eqStrict
    )
    if (t.win_likelihood_band_provenance) {
      t.win_likelihood_band = t.win_likelihood_band_provenance.value
      t.band_evidence = t.win_likelihood_band_provenance.quote ?? ''
    }
    t.velocity_provenance = foldProvenant(f.velocity_provenance, t.velocity_provenance, eqVelocity)
    if (t.velocity_provenance) t.velocity = t.velocity_provenance.value
    t.amount = foldProvenant(f.amount, t.amount, eqAmount)
    t.close_date = foldProvenant(f.close_date, t.close_date, eqStrict)
  }

  await writeTypedEntity(s, payload.kind, payload.intoId, target)
  // Tombstone the source file LAST — after into's write has succeeded — so a mid-merge failure never
  // leaves a merged-away source pointing at a target that didn't actually absorb its data.
  await writeRawEntityFile(s, payload.kind, payload.fromId, {
    schema_version: BRAIN_SCHEMA_VERSION,
    id: payload.fromId,
    merged_into: payload.intoId
  })

  // A merged-away PERSON's old display name can already be baked into an unrelated account's
  // `.people[]` (a meeting mentioning them was ingested before this merge ever ran). Display rewrite
  // now uses the UNION alias map (readAliasMap), which already knows about a merge via the journal — so
  // a REBUILD's re-ingest of that same meeting bakes the SURVIVING name directly, while the original
  // live ingest baked the pre-merge name (nothing knew about the merge yet). Without this sweep the two
  // paths would diverge (live: both old and new names present; rebuild: new name only) — the same
  // repaint-at-correction-time treatment applyRename gives its dependents, just triggered by a merge.
  if (payload.kind === 'person') {
    await sweepPersonNameDependents(s, target.name, surfaceFormKeys(from.name, [...from.aliases, from.id]))
  }

  // Rewrite graph edges fromId -> intoId (never touches nodes — an orphaned fromId node is harmless and
  // out of this task's scope), dropping any resulting self-loop and de-duping exactly like ingest.ts's
  // own addEdge does.
  const graph = readGraph(s)
  const fromNode = `${payload.kind}:${payload.fromId}`
  const intoNode = `${payload.kind}:${payload.intoId}`
  const rewritten = graph.edges
    .map((e) => ({ ...e, from: e.from === fromNode ? intoNode : e.from, to: e.to === fromNode ? intoNode : e.to }))
    .filter((e) => e.from !== e.to)
  const deduped: typeof rewritten = []
  for (const e of rewritten) pushUnique(deduped, e, (x) => `${x.from}|${x.to}|${x.rel}`)
  graph.edges = deduped
  await writeGraph(s, graph)

  return { ok: true, snapshot }
}

/** Merge `fromId` into `intoId`: unions aliases (adding fromId's old display name + id as new aliases
 *  of intoId), moves meetings/commitments/kind-specific history, folds provenant fields (see
 *  foldProvenant's precedence — a source-only value like from.role='CFO' survives the merge instead of
 *  living only in the snapshot), rewrites graph edges, and tombstones the source file so stale
 *  references resolve to the target. */
export async function mergeEntities(
  s: Settings,
  payload: { kind: EntityKind; fromId: string; intoId: string }
): Promise<{ ok: boolean; error?: string }> {
  const at = new Date().toISOString()
  const r = await applyMerge(s, payload)
  if (!r.ok) return { ok: false, error: r.error }
  await appendCorrectionEntry(s, { seq: 0, at, kind: 'entity_merge', payload, snapshot: r.snapshot })
  return { ok: true }
}

const ENTITY_SCHEMA_BY_KIND = {
  person: PersonEntitySchema,
  account: AccountEntitySchema,
  deal: DealEntitySchema
} as const

async function applyUnmerge(
  s: Settings,
  payload: { targetSeq: number },
  journal: CorrectionEntry[]
): Promise<{ ok: boolean; error?: string }> {
  const entry = journal.find(
    (e): e is Extract<CorrectionEntry, { kind: 'entity_merge' }> => e.seq === payload.targetSeq && e.kind === 'entity_merge'
  )
  if (!entry) return { ok: false, error: 'Correction not found.' }
  if (!entry.snapshot) return { ok: false, error: 'No snapshot to restore from — this merge cannot be undone.' }
  const schema = ENTITY_SCHEMA_BY_KIND[entry.payload.kind]
  const fromParsed = schema.safeParse(entry.snapshot.fromEntity)
  const intoParsed = schema.safeParse(entry.snapshot.intoEntity)
  if (!fromParsed.success || !intoParsed.success) return { ok: false, error: 'Snapshot is corrupt.' }
  await writeTypedEntity(s, entry.payload.kind, entry.payload.fromId, fromParsed.data)
  await writeTypedEntity(s, entry.payload.kind, entry.payload.intoId, intoParsed.data)
  return { ok: true }
}

/** Restore both entity files from the `entity_merge` journal entry at `targetSeq`, exactly as they were
 *  before that merge — un-tombstoning the source. Refuses (never partially applies) when the target
 *  entry doesn't exist or carries no snapshot. Graph edges rewritten by the original merge are NOT
 *  reverted (out of scope here — a rebuild re-derives a clean graph from the meetings themselves).
 *
 *  These are POINT-IN-TIME snapshots: unmerge restores both sides exactly as they were at merge time,
 *  so any correction applied to EITHER side between the merge and the unmerge (a field pin on the
 *  target, a rename, meetings ingested into the merged entity) is intentionally discarded by the
 *  restore — undoing a merge means returning to the world as it was, not surgically extracting one
 *  entity's rows out of the blended state. */
export async function unmergeEntities(
  s: Settings,
  payload: { targetSeq: number }
): Promise<{ ok: boolean; error?: string }> {
  const at = new Date().toISOString()
  const journal = readCorrectionsJournal(s)
  const r = await applyUnmerge(s, payload, journal)
  if (!r.ok) return { ok: false, error: r.error }
  await appendCorrectionEntry(s, { seq: 0, at, kind: 'entity_unmerge', payload })
  return { ok: true }
}

// ── field_update ─────────────────────────────────────────────────────────────

const eqAmount = (a: { value: number; currency: string }, b: { value: number; currency: string }): boolean =>
  a.value === b.value && a.currency === b.currency

/** Build a "human pin" ProvenantField: unconditionally wins (unlike mergeExtraction's rank-gated
 *  mergeProvenant), always transitions to `state: 'pinned'`, `source_file: ''` (the honest "human-
 *  entered, no meeting source" marker), and the strongest confidence tier. The old value (if any and if
 *  different) is pushed into `superseded` via the exact same history bookkeeping mergeProvenant uses. */
function pinProvenant<T>(
  current: ProvenantField<T> | undefined,
  value: T,
  at: string,
  valuesEqual: (a: T, b: T) => boolean
): ProvenantField<T> {
  const superseded = current
    ? pushSuperseded(current.superseded, { value: current.value, date: current.date, source_file: current.source_file }, value, valuesEqual)
    : []
  return { value, source_file: '', date: at, quote: undefined, confidence: 'EXTRACTED', state: 'pinned', superseded }
}

async function applyFieldUpdate(
  s: Settings,
  payload: { kind: EntityKind; id: string; field: string; value?: unknown },
  at: string
): Promise<{ ok: boolean; error?: string; snapshot?: { oldField: unknown } }> {
  if (payload.kind === 'person') {
    const found = readPerson(s, payload.id)
    if (!found) return { ok: false, error: 'Person not found.' }
    const person = cloneEntity(found)
    if (payload.field === 'role') {
      const parsed = z.string().safeParse(payload.value)
      if (!parsed.success) return { ok: false, error: 'Invalid value for role.' }
      const old = person.role_provenance
      person.role_provenance = pinProvenant(old, parsed.data, at, eqStrict)
      person.role = person.role_provenance.value
      await writePerson(s, payload.id, person)
      return { ok: true, snapshot: { oldField: old } }
    }
    if (payload.field === 'org') {
      const parsed = z.string().safeParse(payload.value)
      if (!parsed.success) return { ok: false, error: 'Invalid value for org.' }
      const old = person.org_provenance
      person.org_provenance = pinProvenant(old, parsed.data, at, eqStrict)
      person.account = person.org_provenance.value
      await writePerson(s, payload.id, person)
      return { ok: true, snapshot: { oldField: old } }
    }
    return { ok: false, error: `Unsupported field "${payload.field}" for person.` }
  }

  if (payload.kind === 'account') {
    const found = readAccount(s, payload.id)
    if (!found) return { ok: false, error: 'Account not found.' }
    const account = cloneEntity(found)
    if (payload.field === 'sector') {
      const parsed = SectorSchema.safeParse(payload.value)
      if (!parsed.success) return { ok: false, error: 'Invalid value for sector.' }
      const old = account.sector_provenance
      account.sector_provenance = pinProvenant(old, parsed.data, at, eqStrict)
      account.sector = account.sector_provenance.value
      account.sector_confidence = account.sector_provenance.confidence
      await writeAccount(s, payload.id, account)
      return { ok: true, snapshot: { oldField: old } }
    }
    return { ok: false, error: `Unsupported field "${payload.field}" for account.` }
  }

  // deal
  const foundDeal = readDeal(s, payload.id)
  if (!foundDeal) return { ok: false, error: 'Deal not found.' }
  const deal = cloneEntity(foundDeal)
  if (payload.field === 'stage') {
    const parsed = z.string().safeParse(payload.value)
    if (!parsed.success) return { ok: false, error: 'Invalid value for stage.' }
    const old = deal.stage_provenance
    deal.stage_provenance = pinProvenant(old, parsed.data, at, eqStrict)
    deal.stage = deal.stage_provenance.value
    await writeDeal(s, payload.id, deal)
    return { ok: true, snapshot: { oldField: old } }
  }
  if (payload.field === 'win_likelihood_band') {
    const parsed = BandSchema.nullable().safeParse(payload.value)
    if (!parsed.success) return { ok: false, error: 'Invalid value for win_likelihood_band.' }
    const old = deal.win_likelihood_band_provenance
    deal.win_likelihood_band_provenance = pinProvenant(old, parsed.data, at, eqStrict)
    deal.win_likelihood_band = deal.win_likelihood_band_provenance.value
    deal.band_evidence = deal.win_likelihood_band_provenance.quote ?? ''
    await writeDeal(s, payload.id, deal)
    return { ok: true, snapshot: { oldField: old } }
  }
  if (payload.field === 'velocity') {
    const parsed = VelocitySchema.safeParse(payload.value)
    if (!parsed.success) return { ok: false, error: 'Invalid value for velocity.' }
    const old = deal.velocity_provenance
    deal.velocity_provenance = pinProvenant(old, parsed.data, at, eqVelocity)
    deal.velocity = deal.velocity_provenance.value
    await writeDeal(s, payload.id, deal)
    return { ok: true, snapshot: { oldField: old } }
  }
  if (payload.field === 'amount') {
    const parsed = AmountValueSchema.safeParse(payload.value)
    if (!parsed.success) return { ok: false, error: 'Invalid value for amount.' }
    const old = deal.amount
    deal.amount = pinProvenant(old, parsed.data, at, eqAmount)
    await writeDeal(s, payload.id, deal)
    return { ok: true, snapshot: { oldField: old } }
  }
  if (payload.field === 'close_date') {
    const parsed = z.string().safeParse(payload.value)
    if (!parsed.success) return { ok: false, error: 'Invalid value for close_date.' }
    const old = deal.close_date
    deal.close_date = pinProvenant(old, parsed.data, at, eqStrict)
    await writeDeal(s, payload.id, deal)
    return { ok: true, snapshot: { oldField: old } }
  }
  return { ok: false, error: `Unsupported field "${payload.field}" for deal.` }
}

/** Pin a MI-1 provenant field to a human-entered value: person role/org, account sector, deal
 *  stage/win_likelihood_band/velocity/amount/close_date. Sets `state: 'pinned'` (mergeExtraction's
 *  existing mergeProvenant already refuses to overwrite a pinned/edited field, so no later meeting can
 *  silently reopen it) with `source_file: ''` — the honest marker for "human-entered, no meeting
 *  source". The prior value (if different) is preserved in `superseded`. */
export async function updateEntityField(
  s: Settings,
  payload: { kind: EntityKind; id: string; field: string; value?: unknown }
): Promise<{ ok: boolean; error?: string }> {
  const at = new Date().toISOString()
  const r = await applyFieldUpdate(s, payload, at)
  if (!r.ok) return { ok: false, error: r.error }
  await appendCorrectionEntry(s, { seq: 0, at, kind: 'field_update', payload, snapshot: r.snapshot })
  return { ok: true }
}

// ── commitment_reject ────────────────────────────────────────────────────────

async function applyRejectCommitment(
  s: Settings,
  payload: { personSlug: string; dealSlug?: string; text: string }
): Promise<{ ok: boolean; error?: string }> {
  const key = commitmentKey(payload.text)
  let matched = false

  const foundPerson = readPerson(s, payload.personSlug)
  if (foundPerson) {
    const person = cloneEntity(foundPerson)
    const row = person.commitments?.find((c) => commitmentKey(c.text) === key)
    if (row) {
      row.status = 'rejected'
      await writePerson(s, payload.personSlug, person)
      matched = true
    }
  }

  if (payload.dealSlug) {
    const foundDeal = readDeal(s, payload.dealSlug)
    if (foundDeal) {
      const deal = cloneEntity(foundDeal)
      const row = deal.commitments.find((c) => commitmentKey(c.text) === key)
      if (row) {
        row.status = 'rejected'
        await writeDeal(s, payload.dealSlug, deal)
        matched = true
      }
    }
  }

  if (!matched) return { ok: false, error: 'Commitment not found.' }
  return { ok: true }
}

/** Mark a misheard/never-actually-made commitment 'rejected' on the person's ledger and, when
 *  `dealSlug` is given, the deal's ledger too — mirroring settleCommitment's two-ledger convention.
 *  Every existing `status === 'open'` filter excludes a rejected commitment for free by construction
 *  (see the LedgerCommitmentSchema doc comment in shared/brain.ts). */
export async function rejectCommitment(
  s: Settings,
  payload: { personSlug: string; dealSlug?: string; text: string }
): Promise<{ ok: boolean; error?: string }> {
  const at = new Date().toISOString()
  const r = await applyRejectCommitment(s, payload)
  if (!r.ok) return { ok: false, error: r.error }
  await appendCorrectionEntry(s, { seq: 0, at, kind: 'commitment_reject', payload })
  return { ok: true }
}

// ── Replay ───────────────────────────────────────────────────────────────────

/**
 * Re-apply every journal entry in `seq` order through the SAME `applyXxx` functions the live IPC
 * handlers call — never a parallel reimplementation. Tolerant: an entry whose target no longer exists
 * (or otherwise fails) logs a warning and continues; it never throws mid-replay, so one bad/stale entry
 * can't abort the rest of a rebuild.
 */
export async function replayCorrections(s: Settings): Promise<{ applied: number; warnings: string[] }> {
  const journal = readCorrectionsJournal(s)
  // Built once from the FULL journal (every entry, not just ones already replayed) — a field_update's
  // target can be merged away by a LATER entry in seq order; resolving through the complete alias/merge
  // map is what lets a pin-then-merge-away rebuild apply the pin against the surviving entity (see the
  // field_update case below) instead of spuriously warning "not found".
  const journalAliases = aliasMapFromJournal(journal)
  const warnings: string[] = []
  let applied = 0
  for (const entry of journal) {
    try {
      let r: { ok: boolean; error?: string }
      switch (entry.kind) {
        case 'entity_rename':
          // The entry's snapshot carries the TRUE pre-rename name — see applyRename's snapshotHint doc
          // comment for why entity.name alone can no longer be trusted for this during a rebuild.
          r = await applyRename(s, entry.payload, entry.snapshot)
          break
        case 'entity_merge':
          // The entry's snapshot stands in for the source when re-ingest already routed it away —
          // see applyMerge's snapshotHint doc comment.
          r = await applyMerge(s, entry.payload, entry.snapshot)
          break
        case 'entity_unmerge':
          r = await applyUnmerge(s, entry.payload, journal)
          break
        case 'field_update': {
          // A rebuild's re-ingest routes a since-merged-away target's meetings straight to the merge
          // survivor (see readAliasMap's doc comment) — so `entry.payload.id` may never materialize as
          // its own file during replay, even though the pin it carries genuinely survives: the LATER
          // entity_merge entry's own replay folds it into the survivor via foldProvenant, from that
          // entry's own snapshot. Resolving the id through the journal map applies the pin directly
          // against the survivor instead — matching where it ends up anyway. A target that was only ever
          // renamed resolves to the SAME id (renames never change id), and a target never touched by any
          // rename/merge has no hit at all — both fall through to the original id unchanged, so this is
          // a no-op for every case except the one it exists to fix.
          const hit = journalAliases.get(slugify(entry.payload.id))
          const resolvedId = hit && hit.kind === entry.payload.kind ? hit.id : entry.payload.id
          r = await applyFieldUpdate(s, { ...entry.payload, id: resolvedId }, entry.at)
          break
        }
        case 'commitment_reject':
          r = await applyRejectCommitment(s, entry.payload)
          break
      }
      if (r.ok) {
        applied++
      } else {
        const msg = `entry seq=${entry.seq} (${entry.kind}) could not be applied: ${r.error}`
        mainLog.warn(`[brain] replayCorrections: ${msg}`)
        warnings.push(msg)
      }
    } catch (e) {
      const msg = `entry seq=${entry.seq} (${entry.kind}) threw: ${e instanceof Error ? e.message : String(e)}`
      mainLog.warn(`[brain] replayCorrections: ${msg}`)
      warnings.push(msg)
    }
  }
  return { applied, warnings }
}
