/** The ingest ledger (.brain/index.json) and its read/replace invariant (M2-0003). */
import { rename } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Settings } from '@shared/ipc'
import { BrainIndexSchema, type BrainIndex, type IndexUnavailableCause } from '@shared/brain'
import { resolveMeetingsFolder } from '../transcripts'
import { mainLog, auditLog } from '../logger'
import { storageAtRoot } from '../infra/storage/meetings-storage'
import { brainDir, persistJson, readBrainFile, type ContentIdentity } from './store'
import {
  BrainIndexUnavailableError,
  INDEX_REL,
  classifyIndexBytes,
  type ResolvedIndex
} from './index-state'

// ── Brain index (index.json) ─ M2-0003 read/replace invariant ─────────────────────────────────────
// index.json is renamed or overwritten ONLY when this process fully decoded its current bytes (plaintext,
// or an envelope that authenticated under a key this device holds), or when no file exists. Bytes that
// could not be read, decrypted (another device's key, an unavailable keystore, damaged ciphertext — not
// distinguishable, so never distinguished) or parsed by this build's schema_version are left byte-identical
// and the index is read-only for the session. Decoded-but-invalid bytes are set aside, capped. Mirrors
// corrections.ts's parseJournalFile (absent / unreadable / corrupt / ok). See ticket M2-0003.

/** Only snapshots made by this scheme are counted. Legacy `index.corrupt-<ISO>.json` files (the pre-
 *  M2-0003 quarantine name) are never counted, renamed or deleted — every existing one stays exactly
 *  where it is. Keeps the `.corrupt-` infix every `.brain` reader already excludes from its own scans. */
const INDEX_AUTO_SNAPSHOT_PREFIX = 'index.corrupt-auto-'
export const INDEX_AUTO_SNAPSHOT_CAP = 5

export { BrainIndexUnavailableError, classifyIndexBytes } from './index-state'

// Loading goes through the storage gateway (M2-0031): nothing here reads index.json synchronously, and a
// cloud-only index.json is never read. readIndex and indexUnavailable answer from the last load and never
// touch the disk. A decoded outcome holds while the file's content identity (mtimeMs, size) holds, even
// after an eviction: those bytes are in memory. Availability outcomes ('io', 'cloud-only') are
// re-evaluated on every load.

/** Causes decided by decoding a version's bytes; they hold while its content identity holds. */
const DECODED_CAUSES: ReadonlySet<IndexUnavailableCause> = new Set(['undecryptable', 'unsupported', 'corrupt-kept'])
const ABSENT: ResolvedIndex = { kind: 'absent' }

type LedgerEntry = { identity: ContentIdentity | null; load: ResolvedIndex }
/** The last load per `.brain` index path. */
const ledger = new Map<string, LedgerEntry>()
/** Bumped by every writeIndex: a load that read older bytes never replaces the entry a write set. */
let writes = 0

function indexPath(s: Settings): string {
  return join(brainDir(s), INDEX_REL)
}

/** The entry's decoded outcome with the content identity it holds for, or undefined when it holds none. */
function decodedHeld(entry: LedgerEntry | undefined): (ContentIdentity & { load: ResolvedIndex }) | undefined {
  if (!entry?.identity) return undefined
  const { load } = entry
  const decoded = load.kind === 'ready' || (load.kind === 'unavailable' && DECODED_CAUSES.has(load.cause))
  return decoded ? { ...entry.identity, load } : undefined
}

function settle(p: string, identity: ContentIdentity | null, load: ResolvedIndex): ResolvedIndex {
  ledger.set(p, { identity, load })
  return load
}

/** Logs and audits a NEW unavailable cause once (not once per poll), then records it. */
function recordUnavailable(
  p: string,
  identity: ContentIdentity | null,
  load: Extract<ResolvedIndex, { kind: 'unavailable' }>
): ResolvedIndex {
  const previous = ledger.get(p)?.load
  if (previous?.kind !== 'unavailable' || previous.cause !== load.cause) {
    mainLog.warn(`[brain] index.json can't be used on this device (${load.cause}${load.detail ? `: ${load.detail}` : ''}) — left untouched; indexing is paused until it can be read`)
    auditLog('brain.index.unavailable', { cause: load.cause })
  }
  return settle(p, identity, load)
}

/**
 * Preserve DECODED-BUT-INVALID index.json bytes aside and let the app carry on with a rebuildable empty
 * index — the one case this process is certain the bytes are worthless (they authenticated under a key
 * this device holds; they are simply not a valid index for this build), so a rename is safe. Capped at
 * `INDEX_AUTO_SNAPSHOT_CAP` on disk, counting only this scheme's own `index.corrupt-auto-` prefix.
 */
async function setAsideCorruptIndex(s: Settings): Promise<ResolvedIndex> {
  const listing = await storageAtRoot(() => resolveMeetingsFolder(s)).list('.brain')
  if (listing.status !== 'ok') return { kind: 'unavailable', cause: 'corrupt-kept', detail: listing.status }
  const kept = listing.names.filter((f) => f.startsWith(INDEX_AUTO_SNAPSHOT_PREFIX)).length
  if (kept >= INDEX_AUTO_SNAPSHOT_CAP) return { kind: 'unavailable', cause: 'corrupt-kept', detail: 'snapshot cap reached' }
  const to = join(brainDir(s), `${INDEX_AUTO_SNAPSHOT_PREFIX}${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}.json`)
  try {
    await rename(indexPath(s), to)
  } catch (e) {
    return { kind: 'unavailable', cause: 'corrupt-kept', detail: (e as NodeJS.ErrnoException).code }
  }
  mainLog.warn(`[brain] index.json decoded but was not a valid index — preserved as ${basename(to)}`)
  auditLog('brain.index.quarantined', { kept: kept + 1, cap: INDEX_AUTO_SNAPSHOT_CAP })
  return ABSENT
}

export async function loadIndex(s: Settings): Promise<ResolvedIndex> {
  const p = indexPath(s)
  const writesBefore = writes
  const file = await readBrainFile(s, INDEX_REL, decodedHeld(ledger.get(p)))
  const written = ledger.get(p)
  if (writes !== writesBefore && written) return written.load
  switch (file.status) {
    case 'unchanged':
      return file.held.load
    case 'missing':
      return settle(p, null, ABSENT)
    case 'cloud-only':
      return recordUnavailable(p, null, { kind: 'unavailable', cause: 'cloud-only' })
    case 'unreadable':
      return recordUnavailable(p, null, { kind: 'unavailable', cause: 'io', detail: file.code })
    case 'ok': {
      const classified = classifyIndexBytes(file.bytes)
      if (classified.kind === 'corrupt') {
        const kept = await setAsideCorruptIndex(s)
        return kept.kind === 'unavailable' ? recordUnavailable(p, file.identity, kept) : settle(p, null, kept)
      }
      if (classified.kind === 'unavailable') return recordUnavailable(p, file.identity, classified)
      return settle(p, classified.kind === 'ready' ? file.identity : null, classified)
    }
  }
}

/** The ledger as of the last load, or the empty stand-in when there is none or it is read-only. Never
 *  touches the disk. Callers clone before mutating: it is the shared loaded object. */
export function readIndex(s: Settings): BrainIndex {
  const load = ledger.get(indexPath(s))?.load
  return load?.kind === 'ready' ? load.index : BrainIndexSchema.parse({})
}

/** Non-null while the last load found index.json unusable here, and 'io' before the first load. */
export function indexUnavailable(s: Settings): IndexUnavailableCause | null {
  const load = ledger.get(indexPath(s))?.load
  if (!load) return 'io'
  return load.kind === 'unavailable' ? load.cause : null
}

export function forgetIndex(s: Settings): void {
  ledger.delete(indexPath(s))
  writes += 1
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
    case 'cloud-only':
      return 'Some Mantu Intelligence files are in OneDrive but not on this device right now, so Métis ' +
        "won't open them in the background. Nothing was changed. Indexing is paused until the Métis Meetings " +
        'folder is kept on this device (in OneDrive, choose "Always keep on this device").'
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
  if (!ledger.has(indexPath(s))) await loadIndex(s)
  const blocked = indexUnavailable(s)
  if (blocked) throw new BrainIndexUnavailableError(blocked)
  const identity = await persistJson(s, INDEX_REL, v)
  writes += 1
  ledger.set(indexPath(s), { identity, load: { kind: 'ready', index: BrainIndexSchema.parse(JSON.parse(JSON.stringify(v))) } })
}
