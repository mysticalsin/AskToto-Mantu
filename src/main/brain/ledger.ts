/** The ingest ledger (.brain/index.json) and its read/replace invariant (M2-0003). */
import { readdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Settings } from '@shared/ipc'
import { BrainIndexSchema, BRAIN_SCHEMA_VERSION, type BrainIndex, type IndexUnavailableCause } from '@shared/brain'
import { decodeSavedResult } from '../transcripts'
import { mainLog, auditLog } from '../logger'
import { brainDir, writeJson } from './store'

// ── Brain index (index.json) ─ M2-0003 read/replace invariant ─────────────────────────────────────
// index.json is renamed or overwritten ONLY when this process fully decoded its current bytes (plaintext,
// or an envelope that authenticated under a key this device holds), or when no file exists. Bytes that
// could not be read, decrypted (another device's key, an unavailable keystore, damaged ciphertext — not
// distinguishable, so never distinguished) or parsed by this build's schema_version are left byte-identical
// and the index is read-only for the session. Decoded-but-invalid bytes are set aside, capped. Mirrors
// corrections.ts's parseJournalFile (absent / unreadable / corrupt / ok). See ticket M2-0003.

const INDEX_REL = 'index.json'
/** Only snapshots made by this scheme are counted. Legacy `index.corrupt-<ISO>.json` files (the pre-
 *  M2-0003 quarantine name) are never counted, renamed or deleted — every existing one stays exactly
 *  where it is. Keeps the `.corrupt-` infix every `.brain` reader already excludes from its own scans. */
const INDEX_AUTO_SNAPSHOT_PREFIX = 'index.corrupt-auto-'
export const INDEX_AUTO_SNAPSHOT_CAP = 5
/** Only an I/O failure is retried on a timer (e.g. a OneDrive dataless placeholder hydrating). A decode
 *  failure is not: retrying safeStorage on a timer risks Keychain prompts, and the bytes have not changed. */
export const INDEX_IO_RETRY_MS = 30_000

type IndexLoad =
  | { kind: 'ready'; index: BrainIndex }
  | { kind: 'absent' }
  | { kind: 'corrupt' } // decoded, but not a valid index for this build
  | { kind: 'unavailable'; cause: IndexUnavailableCause; detail?: string } // detail: log-only (errno / decode reason)
type ResolvedIndex = Exclude<IndexLoad, { kind: 'corrupt' }>

export class BrainIndexUnavailableError extends Error {
  override readonly name = 'BrainIndexUnavailableError'
  // NOT `cause` — that is Error.cause (ES2022).
  constructor(readonly unavailable: IndexUnavailableCause) {
    super(`brain index is read-only on this device (${unavailable})`)
  }
}

/** Pure classification of index.json bytes. No filesystem writes. */
export function classifyIndexBytes(buf: Buffer): IndexLoad {
  if (buf.length === 0) return { kind: 'absent' } // torn to zero bytes: nothing to preserve (unchanged)
  const decoded = decodeSavedResult(buf)
  if (!decoded.ok) return { kind: 'unavailable', cause: 'undecryptable', detail: decoded.reason }
  let raw: unknown
  try {
    raw = JSON.parse(decoded.text)
  } catch {
    return { kind: 'corrupt' }
  }
  const parsed = BrainIndexSchema.safeParse(raw)
  if (parsed.success) return { kind: 'ready', index: parsed.data }
  const v = (raw as { schema_version?: unknown } | null)?.schema_version
  if (typeof v === 'number' && v > BRAIN_SCHEMA_VERSION) return { kind: 'unavailable', cause: 'unsupported' }
  return { kind: 'corrupt' }
}

// Stat-keyed memo, one entry per `.brain` dir's index.json. NOT session state: an entry is used only
// while (mtimeMs,size) still match the file on disk — it ends by itself the moment the bytes change
// (another device/owner rewrites them, an explicit purge), so nothing in memory ever outlives the file.
// The (-1,-1) key stands for "stat itself failed (non-ENOENT)".
type IndexCacheEntry = { mtimeMs: number; size: number; at: number; load: ResolvedIndex }
const indexCache = new Map<string, IndexCacheEntry>()

/** Node fs errors carry `.code` (ENOENT, ETIMEDOUT, …); anything else has none. */
function errnoCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException).code
}

/** True once a cached I/O-failure entry is old enough to retry. Decode failures never retry here — the
 *  bytes haven't changed, and polling safeStorage on a timer risks a Keychain-prompt storm. */
function ioRetryDue(entry: IndexCacheEntry): boolean {
  return entry.load.kind === 'unavailable' && entry.load.cause === 'io' && Date.now() - entry.at >= INDEX_IO_RETRY_MS
}

/** Logs and audits a NEW unavailable classification once (not once per poll), then caches it. */
function recordUnavailable(
  p: string,
  hit: IndexCacheEntry | undefined,
  mtimeMs: number,
  size: number,
  load: Extract<ResolvedIndex, { kind: 'unavailable' }>
): ResolvedIndex {
  const alreadyLogged = hit?.load.kind === 'unavailable' && hit.load.cause === load.cause
  if (!alreadyLogged) {
    mainLog.warn(
      `[brain] index.json can't be used on this device (${load.cause}${load.detail ? `: ${load.detail}` : ''}) — left untouched; indexing is paused until it can be read`
    )
    auditLog('brain.index.unavailable', { cause: load.cause })
  }
  indexCache.set(p, { mtimeMs, size, at: Date.now(), load })
  return load
}

/**
 * Preserve DECODED-BUT-INVALID index.json bytes aside and let the app carry on with a rebuildable empty
 * index — the one case this process is certain the bytes are worthless (they authenticated under a key
 * this device holds; they are simply not a valid index for this build), so a rename is safe. Capped at
 * `INDEX_AUTO_SNAPSHOT_CAP` on disk, counting only this scheme's own `index.corrupt-auto-` prefix.
 */
function setAsideCorruptIndex(p: string): ResolvedIndex {
  const dir = dirname(p)
  let kept: number
  try {
    kept = readdirSync(dir).filter((f) => f.startsWith(INDEX_AUTO_SNAPSHOT_PREFIX)).length
  } catch (e) {
    return { kind: 'unavailable', cause: 'corrupt-kept', detail: errnoCode(e) }
  }
  if (kept >= INDEX_AUTO_SNAPSHOT_CAP) return { kind: 'unavailable', cause: 'corrupt-kept', detail: 'snapshot cap reached' }
  const to = join(dir, `${INDEX_AUTO_SNAPSHOT_PREFIX}${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}.json`)
  try {
    renameSync(p, to)
  } catch (e) {
    return { kind: 'unavailable', cause: 'corrupt-kept', detail: errnoCode(e) }
  }
  mainLog.warn(
    `[brain] index.json decoded but was not a valid index — preserved as ${basename(to)} (${kept + 1}/${INDEX_AUTO_SNAPSHOT_CAP}); it will be rebuilt from the transcripts`
  )
  auditLog('brain.index.quarantined', { kept: kept + 1, cap: INDEX_AUTO_SNAPSHOT_CAP })
  return { kind: 'absent' }
}

function loadIndex(s: Settings): ResolvedIndex {
  const p = join(brainDir(s), INDEX_REL)
  const hit = indexCache.get(p)

  let mtimeMs: number
  let size: number
  try {
    const st = statSync(p)
    mtimeMs = st.mtimeMs
    size = st.size
  } catch (e) {
    if (errnoCode(e) === 'ENOENT') {
      indexCache.delete(p)
      return { kind: 'absent' }
    }
    return recordUnavailable(p, hit, -1, -1, { kind: 'unavailable', cause: 'io', detail: errnoCode(e) })
  }

  if (hit && hit.mtimeMs === mtimeMs && hit.size === size && !ioRetryDue(hit)) return hit.load

  let buf: Buffer
  try {
    buf = readFileSync(p)
  } catch (e) {
    const code = errnoCode(e)
    if (code === 'ENOENT') {
      indexCache.delete(p)
      return { kind: 'absent' }
    }
    return recordUnavailable(p, hit, mtimeMs, size, { kind: 'unavailable', cause: 'io', detail: code })
  }

  const classified = classifyIndexBytes(buf)
  const load: ResolvedIndex = classified.kind === 'corrupt' ? setAsideCorruptIndex(p) : classified

  if (load.kind === 'absent') {
    indexCache.delete(p)
    return load
  }
  if (load.kind === 'unavailable') return recordUnavailable(p, hit, mtimeMs, size, load)

  indexCache.set(p, { mtimeMs, size, at: Date.now(), load })
  return load
}

/** The index, or an empty stand-in when there is none or it is read-only (see indexUnavailable). The
 *  stand-in can never be persisted over unreadable bytes: writeIndex refuses. Callers still clone before
 *  mutating (see updateIndex) — an unchanged file serves the same cached object on every call. */
export const readIndex = (s: Settings): BrainIndex => {
  const load = loadIndex(s)
  return load.kind === 'ready' ? load.index : BrainIndexSchema.parse({})
}

/** Non-null while an existing index.json cannot be used here: the index is read-only for the session. */
export function indexUnavailable(s: Settings): IndexUnavailableCause | null {
  const load = loadIndex(s)
  return load.kind === 'unavailable' ? load.cause : null
}

/** User-facing, content-free explanation for brainStatus.error. */
export function indexUnavailableMessage(cause: IndexUnavailableCause): string {
  switch (cause) {
    case 'undecryptable':
      return "Mantu Intelligence can't read its index on this device: it was encrypted with a key this " +
        'device doesn\'t have (another device, or a keychain that is unavailable). Nothing was changed ' +
        'or deleted. Indexing is paused on this device.'
    case 'io':
      return "Mantu Intelligence couldn't read its index file just now (it may still be downloading from " +
        'OneDrive). Nothing was changed. Indexing resumes automatically once the file can be read.'
    case 'unsupported':
      return "Mantu Intelligence's index was written by a newer version of Métis. Nothing was changed. " +
        'Update Métis on this device to resume indexing.'
    case 'corrupt-kept':
      return "Mantu Intelligence's index is damaged and the automatic repair limit for this folder has " +
        'been reached. Nothing was deleted. Indexing is paused on this device.'
  }
}

/** Fail-closed write: never replaces bytes this process could not fully decode. */
export async function writeIndex(s: Settings, v: BrainIndex): Promise<void> {
  const blocked = indexUnavailable(s)
  if (blocked) throw new BrainIndexUnavailableError(blocked)
  await writeJson(s, INDEX_REL, v)
  indexCache.delete(join(brainDir(s), INDEX_REL))
}
