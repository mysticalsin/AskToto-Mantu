/**
 * History's list and search read path: every saved meeting's row and searchable text, read through the
 * storage gateway.
 *
 * Invariants:
 *   - No node:fs call: every listing, classify and read goes through the storage gateway, so a cloud-only,
 *     locked or kernel-blocked file costs a pool permit and a deadline, never a pinned libuv thread.
 *   - A listing classifies its files in one batch first; a file classified dataless or unknown is answered
 *     as a 'Not downloaded' row and never read, and a FIFO, socket or device is never opened. Nothing here
 *     hydrates a file: only an explicit open does (recallRead in recall.ts, meetingOpenTarget).
 *   - A newer search aborts the one still queued at the gateway (searchMeetingsLatest).
 */
import { join } from 'node:path'
import { resolveMeetingsFolder, decodeSaved, isEncryptedBytes } from './transcripts'
import { classifyAll, storageAt } from './infra/storage/meetings-storage'
import type { FileClass } from './infra/storage/gateway'
import { getSettings } from './store'
import type { MeetingSummary, RecallHit } from '@shared/ipc'
import { readMeetingFields as frontmatter, stripMeetingFrontmatter } from './features/meetings/meeting-document'

// `meeting-summary` is a first-class saved meeting under managed summary-only retention. Keep the accepted
// document kinds in one place: History, search, recap editing, and erasure must never disagree about
// whether that privacy-preserving meeting exists.
const MEETING_DOCUMENT_TYPES = new Set(['meeting-transcript', 'meeting-summary'])

export function isMeetingDocumentType(type: string | undefined): boolean {
  return !type || MEETING_DOCUMENT_TYPES.has(type)
}

export async function meetingFiles(folder: string, signal?: AbortSignal): Promise<string[]> {
  const listing = await storageAt(folder).list('', { signal })
  if (listing.status !== 'ok') return []
  return listing.names.filter((name) => name.endsWith('.md') && name !== 'README.md' && name !== 'index.md')
}

/** A History row. `notDownloaded` marks a file whose bytes are not on this device (a cloud-only
 *  placeholder): listed from its name, never read; opening it hydrates it explicitly (openExplicitly in
 *  recall.ts), and History shows it with MeetingSummary.notDownloaded. */
export type HistoryRow = MeetingSummary

interface Read {
  sum: HistoryRow
  text: string
}

/** A MeetingSummary stub for a REAL encrypted meeting that failed to decrypt on this device (foreign
 *  keychain — see transcripts.ts's UNDECRYPTABLE_MSG), kept in list/search results instead of dropped,
 *  with `locked: true` as the affordance signal. NOTE: `locked` is not yet declared on the shared
 *  MeetingSummary type (src/shared/ipc.ts, outside this file's scope) — it still flows through at
 *  runtime (see lockedStub/readMeetingUncached below) since it's a real own property on the object, not
 *  a type-only annotation. A renderer that wants to show a lock icon needs a `'locked' in m` runtime
 *  check today, or `locked?: boolean` added to MeetingSummary itself as a follow-up. */
interface LockedMeetingSummary extends MeetingSummary {
  locked: true
}

// Métis's own filenames are always `YYYY-MM-DD_HHMMSS-<slug>.md` (see stamp()/slug() in transcripts.ts).
// These two patterns are the only signal left to tell a real meeting from a non-meeting file once
// decryption has failed — its `type:` frontmatter can't be read — so lockedStub() below uses them to
// keep genuinely non-meeting files dropped, same as the decryptable path already does via fm.type.
export const DRAFT_FILENAME = /^\.autosave-draft-/ // saveDraftTranscript's in-progress autosave — never a real meeting
const NOTE_FILENAME = /^\d{4}-\d{2}-\d{2}_\d{6}-note-/ // saveNote always inserts this literal segment
// Deliberately a separate copy of sweepExpiredMeetings' own FILENAME_TIMESTAMP regex in recall.ts, rather
// than one shared const: this module owns the read path, recall.ts the retention sweep.
const STUB_FILENAME_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})-/

/** Best-effort display stub for a real meeting file we can't render right now, so it stays visible
 *  (instead of silently vanishing) with a lock affordance. Returns null for the one case a filename
 *  alone can still rule out as NOT a meeting: a draft autosave or a quick note (see DRAFT_FILENAME/
 *  NOTE_FILENAME). `label` names the reason in the title — undecryptable on this device ("Locked", the
 *  default) vs. temporarily unreadable ("Unavailable", see UNREADABLE); both need the same visible row. */
function lockedStub(file: string, label = 'Locked'): LockedMeetingSummary | null {
  if (DRAFT_FILENAME.test(file) || NOTE_FILENAME.test(file)) return null
  const m = file.match(STUB_FILENAME_TIMESTAMP)
  const date = m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`) : null
  const slugPart = file.replace(/\.md$/, '').replace(STUB_FILENAME_TIMESTAMP, '').replace(/-/g, ' ').trim()
  return {
    file,
    title: `${label} — ${slugPart || file}`,
    date: date && !isNaN(date.getTime()) ? date.toISOString() : '',
    mode: 'general',
    durationMin: 0,
    participants: [],
    locked: true
  }
}

// Per-file read cache validated by (mtimeMs, size) on every use. List and search previously re-read
// AND re-decrypted every meeting file on every call — per keystroke while searching — the one path
// that degrades linearly as the library grows, with decryption work on the main process. A stat()
// replaces the full read+decode when the file is unchanged; any mtime/size change re-reads, and a
// vanished file drops its entry. Saved meetings are immutable-after-write, so hits are the norm.
// Null results (non-meeting or undecryptable files) are cached too, so they stop costing reads. A file
// whose bytes are not on this device is answered with a fresh 'Not downloaded' row and never cached here:
// hydration changes neither mtimeMs nor size, so a cached stub would outlive the download. A keystroke
// still never re-reads such a file: the gateway remembers a dataless, unknown or timed-out read for
// FAILURE_TTL_MS, and forgets it when an explicit open hydrates the file. Any other failed read (a
// share-lock, a transient error) is deliberately never cached (see UNREADABLE below).
interface CacheEntry {
  mtimeMs: number
  size: number
  read: Read | null
}
// Least-recently-used, so a pathological folder (or repeated folder switches) cannot grow it without
// limit and a full cache drops one cold entry instead of every warm one. A Map iterates in insertion
// order, so re-inserting on every hit keeps the coldest entry first.
const READ_CACHE_MAX = 2000
const readCache = new Map<string, CacheEntry>()

function cachedRead(path: string): CacheEntry | undefined {
  const entry = readCache.get(path)
  if (entry) {
    readCache.delete(path)
    readCache.set(path, entry)
  }
  return entry
}

function cacheRead(path: string, entry: CacheEntry): void {
  readCache.delete(path)
  readCache.set(path, entry)
  if (readCache.size > READ_CACHE_MAX) readCache.delete(readCache.keys().next().value as string)
}

/** Sentinel for "this file could not be READ at all" — an unhydrated OneDrive Files-On-Demand
 *  placeholder while offline, or an AV/EDR share-lock (the same transient conditions writeSaved
 *  already retries around, see transcripts.ts). Kept distinct from `null` ("not a meeting file"),
 *  which is a permanent verdict and safe to cache. A thrown read is neither: stat() still succeeds on
 *  a placeholder, and hydration changes neither mtimeMs nor size, so caching that failure would key it
 *  to a value nothing invalidates and the meeting would stay invisible until the app restarts. */
export const UNREADABLE = Symbol('unreadable')

/** The row for a file whose bytes are not on this device: listed, never read. */
function notDownloadedRow(file: string): Read | null {
  const stub = lockedStub(file, 'Not downloaded')
  return stub ? { text: '', sum: { ...stub, notDownloaded: true } } : null
}

function unavailableRow(file: string): Read | null {
  const stub = lockedStub(file, 'Unavailable')
  return stub ? { text: '', sum: stub } : null
}

/** Read + decode one file (async), parse its frontmatter. Null if it isn't a saved meeting.
 *  `fileClass` comes from the listing's one batched classify, so a file classified dataless or unknown is
 *  answered as a 'Not downloaded' row without ever being read. Served from readCache when the file is
 *  unchanged since the last read. */
async function readMeeting(folder: string, file: string, fileClass: FileClass | undefined, signal?: AbortSignal): Promise<Read | null> {
  const path = join(folder, file)
  if (!fileClass || fileClass.status === 'missing') {
    readCache.delete(path)
    return null
  }
  if (!('version' in fileClass)) {
    readCache.delete(path)
    return unavailableRow(file)
  }
  if (!fileClass.isRegular) {
    // A FIFO, socket or device is never opened by a listing or a search: it would pin a pool thread.
    readCache.delete(path)
    return unavailableRow(file)
  }
  const { mtimeMs, size } = fileClass.version
  const notLocal = (): Read | null => {
    readCache.delete(path)
    return notDownloadedRow(file)
  }
  if (fileClass.status !== 'ok') return notLocal()
  const hit = cachedRead(path)
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.read
  const read = await readMeetingUncached(folder, file, signal)
  if (read === NOT_LOCAL) return notLocal()
  if (read === UNREADABLE) {
    // Drop any stale entry and cache nothing, so the next list/search retries the read instead of
    // serving a transient failure the user has no way to invalidate. The meeting keeps its row as a
    // stub rather than disappearing from History and search with no signal at all.
    readCache.delete(path)
    return unavailableRow(file)
  }
  cacheRead(path, { mtimeMs, size, read })
  return read
}

/** Reads one listing's files: a single batched classify, then a read of each file classified local. Aborting
 *  `signal` ends the queued classify and every queued read at the gateway, and the listing comes back empty. */
export async function readMeetings(folder: string, files: readonly string[], signal?: AbortSignal): Promise<Array<Read | null>> {
  const gateway = storageAt(folder)
  const classes = await classifyAll({ ...gateway, classify: (paths) => gateway.classify(paths, { signal }) }, files)
  if (signal?.aborted) return []
  const read = await Promise.all(files.map((f) => readMeeting(folder, f, classes.get(f), signal)))
  // Reads cut short by a superseding search answer 'Unavailable'; those rows are not a listing.
  return signal?.aborted ? [] : read
}

/** The gateway says this file's bytes are not on this device (or would not arrive in time). */
const NOT_LOCAL = Symbol('not-local')

async function readMeetingUncached(folder: string, file: string, signal?: AbortSignal): Promise<Read | null | typeof UNREADABLE | typeof NOT_LOCAL> {
  const raw = await storageAt(folder).read(file, { signal })
  if (raw.status !== 'ok') {
    if (raw.status === 'dataless' || raw.status === 'unknown' || raw.status === 'timeout') return NOT_LOCAL
    // A THROWN read means "can't read it right now", which is not the same verdict as "not a meeting
    // file" — the caller must not cache it, and must not drop the meeting. Split out from the catch
    // below so only the read itself can produce it: decodeSaved never throws (see transcripts.ts).
    return UNREADABLE
  }
  try {
    const text = decodeSaved(raw.bytes)
    if (!text) {
      // decodeSaved returns '' both for "not a meeting file" and for a REAL meeting encrypted at rest
      // that this device's keychain can't decrypt (a different machine/user — see transcripts.ts's
      // UNDECRYPTABLE_MSG). Only the latter should still show up, as a locked stub, so it never just
      // vanishes; a file that isn't one of Métis's encrypted saves at all stays dropped.
      if (!isEncryptedBytes(raw.bytes)) return null
      const stub = lockedStub(file)
      return stub ? { text: '', sum: stub } : null
    }
    const fm = frontmatter(text)
    if (!isMeetingDocumentType(fm.type)) return null
    const topics = (fm.topics || '').split(',').map((s) => s.trim()).filter(Boolean)
    return {
      text,
      sum: {
        file,
        title: fm.title || file.replace(/\.md$/, ''),
        date: fm.date || '',
        mode: fm.mode || 'general',
        durationMin: Number(fm.duration_min || 0),
        participants: (fm.participants || '').split(',').map((s) => s.trim()).filter(Boolean),
        ...(topics.length ? { topics } : {}),
        ...(fm.confidential === 'true' ? { confidential: true } : {})
      }
    }
  } catch {
    return null
  }
}

/** Newest-first list of saved meetings. */
export async function listMeetings(): Promise<HistoryRow[]> {
  const folder = resolveMeetingsFolder(getSettings())
  const read = await readMeetings(folder, await meetingFiles(folder))
  return read
    .filter((r): r is Read => r !== null)
    .map((r) => r.sum)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
}

/** Keyword search across saved meetings; returns scored hits with a snippet. */
export async function searchMeetings(query: string, signal?: AbortSignal): Promise<RecallHit[]> {
  const folder = resolveMeetingsFolder(getSettings())
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1)
  if (!terms.length) return []
  const read = await readMeetings(folder, await meetingFiles(folder, signal), signal)
  const hits: RecallHit[] = []
  for (const r of read) {
    if (!r) continue
    const { sum, text } = r
    // Strip the frontmatter block before scoring/snippeting so boilerplate keys (type, source,
    // status, etc.) don't manufacture hits or snippets for terms that never appear in the actual
    // recap/transcript body (mirrors the delimiter the frontmatter() helper already uses).
    const body = stripMeetingFrontmatter(text)
    const lc = body.toLowerCase()
    let score = 0
    for (const t of terms) {
      const inTitle = sum.title.toLowerCase().includes(t) ? 3 : 0
      const count = lc.split(t).length - 1
      score += inTitle + count
    }
    if (score === 0) continue
    // Anchor the snippet on a term that actually occurs in the body, falling back to terms[0] only
    // if none do (a multi-word search whose first word only matched via the title bonus).
    const anchor = terms.find((t) => lc.includes(t)) ?? terms[0]
    const first = lc.indexOf(anchor)
    const start = Math.max(0, first - 60)
    const snippet = body.slice(start, start + 200).replace(/\s+/g, ' ').trim()
    hits.push({ ...sum, snippet, score })
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 25)
}

let activeSearch: AbortController | null = null

/** The IPC search: a newer keystroke aborts the search still queued at the storage gateway, whose caller
 *  gets `[]`. */
export function searchMeetingsLatest(query: string): Promise<RecallHit[]> {
  activeSearch?.abort()
  const search = (activeSearch = new AbortController())
  return searchMeetings(query, search.signal).finally(() => {
    if (activeSearch === search) activeSearch = null
  })
}
