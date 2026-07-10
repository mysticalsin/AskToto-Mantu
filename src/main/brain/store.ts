import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'
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
  type MeetingExtraction
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

function readJson<T>(settings: Settings, rel: string, parse: (v: unknown) => T): T | null {
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

async function writeJson(settings: Settings, rel: string, value: unknown): Promise<void> {
  ensureDirs(settings)
  const p = join(brainDir(settings), rel)
  await writeSaved(p, JSON.stringify(value, null, 2), !!settings.encryptTranscripts)
  // Invalidate rather than pre-populate: `value` here is the pre-serialize object, not necessarily
  // byte-identical to what a fresh parse() of the written JSON would yield (zod defaults/transforms) —
  // and relying on mtime alone risks a same-mtime rapid write-then-read on low-resolution filesystems.
  jsonCache.delete(p)
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
  readJson(s, join('entities', 'person', `${slug}.json`), (v) => PersonEntitySchema.parse(v))
export const writePerson = (s: Settings, slug: string, v: PersonEntity): Promise<void> =>
  writeJson(s, join('entities', 'person', `${slug}.json`), v)

export const readAccount = (s: Settings, slug: string): AccountEntity | null =>
  readJson(s, join('entities', 'account', `${slug}.json`), (v) => AccountEntitySchema.parse(v))
export const writeAccount = (s: Settings, slug: string, v: AccountEntity): Promise<void> =>
  writeJson(s, join('entities', 'account', `${slug}.json`), v)

export const readDeal = (s: Settings, slug: string): DealEntity | null =>
  readJson(s, join('entities', 'deal', `${slug}.json`), (v) => DealEntitySchema.parse(v))
export const writeDeal = (s: Settings, slug: string, v: DealEntity): Promise<void> =>
  writeJson(s, join('entities', 'deal', `${slug}.json`), v)

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

/** List entity slugs of a kind (file basenames sans .json). */
export function listEntities(s: Settings, kind: 'person' | 'account' | 'deal'): string[] {
  const dir = join(brainDir(s), 'entities', kind)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => basename(f, '.json'))
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
 */
export function purgeBrain(settings: Settings): { ok: boolean } {
  const root = brainDir(settings)
  try {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true })
    return { ok: !existsSync(root) }
  } catch (e) {
    console.warn('[brain] purgeBrain: could not remove', root, e)
    return { ok: false }
  }
}
