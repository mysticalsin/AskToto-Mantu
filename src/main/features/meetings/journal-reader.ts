import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { IncrementalMeetingRecordSchema } from '@shared/incremental-meeting'
import type { TranscriptLine } from '@shared/transcript-line'
import type { ContentKeyUnwrapResult, WrappedKeyFileReadResult } from '../../infra/security/content-key-wrap'
import { createStorageGateway } from '../../infra/storage/gateway'
import { MEETING_JOURNAL_ID, resolveMeetingJournalRoot } from '../../infra/storage/meeting-journal-purge'
import type { IncrementalJournalLimits, IncrementalJournalSnapshot } from './incremental-meeting-journal'
import {
  createIncrementalMeetingJournalFileStorage,
  type IncrementalMeetingJournalFileStorage
} from './incremental-meeting-journal-files'
import { LOCAL_JOURNAL_DETECTOR, liveMeetingJournalId } from './live-meeting-journal'
import {
  LIVE_MEETING_JOURNAL_LIMITS,
  LIVE_MEETING_JOURNAL_STORAGE_BUDGET,
  validateLiveMeetingJournalPolicy,
  type LiveMeetingJournalStorageBudget
} from './live-meeting-journal-policy'

/**
 * Read-only access to one live meeting journal for launch recovery (WP03 / C09b T6). It re-derives everything the
 * writer did: the directory from the meeting id, the key from `key.v1` through the same unwrap rule as every other
 * at-rest read, the store from the same limits. Anything it cannot prove is an `ignored` outcome with an enum reason
 * and never a partial result: a journal is merged whole or not at all. It never creates, repairs or deletes.
 */

export type JournalIgnoreReason =
  | 'unsafe-path'
  | 'no-records-dir'
  | 'key-missing'
  | 'key-unreadable'
  | 'key-unwrap'
  | 'storage'
  | 'manifest'
  | 'too-large'
  | 'read-failed'

export interface JournalRecord {
  revision: number
  /** `cloud:<captureId>:<captureGeneration>:<streamGeneration>:<track>:<epoch>:<segmentIndex>`, or null for a local line. */
  identityKey: string | null
  line: TranscriptLine
}

export type JournalState = IncrementalJournalSnapshot['state']

export interface JournalReaderDeps {
  userDataPath(): string
  keys: {
    readFile(path: string): Promise<WrappedKeyFileReadResult>
    unwrap(wrapped: string): ContentKeyUnwrapResult
  }
  /** Re-checked at every storage boundary: turning the kill switch off stops a read in flight. */
  readsAllowed(): boolean
  /** Test seams; production uses the frozen policy. */
  limits?: Readonly<IncrementalJournalLimits>
  budget?: Readonly<LiveMeetingJournalStorageBudget>
}

export type OpenedJournal =
  | {
      status: 'open'
      meetingId: string
      storage: IncrementalMeetingJournalFileStorage
      snapshot: IncrementalJournalSnapshot
    }
  | { status: 'absent' }
  | { status: 'ignored'; reason: JournalIgnoreReason }

export type JournalReadResult =
  | { status: 'ok'; meetingId: string; state: JournalState; records: JournalRecord[] }
  | { status: 'absent' }
  | { status: 'ignored'; reason: JournalIgnoreReason }

const PAGE_RECORDS = 128
/** A start file is `{"v":1,"startedAt":<ms>}`; anything larger is not one. */
const START_FILE_MAX_BYTES = 256

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

/** The identity of a cloud-final line, the same tuple the journal records and the draft's provenance frame carry. */
export function lineIdentityKey(line: TranscriptLine): string | null {
  const speech = line.speech
  if (!speech || speech.type !== 'segment') return null
  const { stream, index } = speech.segment
  return `cloud:${speech.captureId}:${speech.captureGeneration}:${stream.generation}:${stream.track}:${stream.epoch}:${index}`
}

/** The owners a journal at launch may belong to: whoever is signed in now, then a signed-out meeting. */
export function ownerCandidates(currentOwnerKey: string | null): Array<string | null> {
  return currentOwnerKey ? [currentOwnerKey, null] : [null]
}

/** Opens one journal's store read-only. The caller releases it by calling `storage.dispose()`. */
export async function openJournal(deps: JournalReaderDeps, meetingId: string): Promise<OpenedJournal> {
  let keyBuffer: Buffer | undefined
  try {
    if (!MEETING_JOURNAL_ID.test(meetingId)) return { status: 'ignored', reason: 'unsafe-path' }
    const limits = deps.limits ?? LIVE_MEETING_JOURNAL_LIMITS
    const budget = deps.budget ?? LIVE_MEETING_JOURNAL_STORAGE_BUDGET
    validateLiveMeetingJournalPolicy(limits, budget)
    const root = await resolveMeetingJournalRoot(deps.userDataPath())
    if (root === 'absent') return { status: 'absent' }
    if (root === 'unsafe') return { status: 'ignored', reason: 'unsafe-path' }
    const directory = join(root, meetingId.toLowerCase())
    try {
      const entry = await lstat(directory)
      if (!entry.isDirectory() || entry.isSymbolicLink() || (await realpath(directory)) !== directory) {
        return { status: 'ignored', reason: 'unsafe-path' }
      }
    } catch (error) {
      return code(error) === 'ENOENT' ? { status: 'absent' } : { status: 'ignored', reason: 'unsafe-path' }
    }
    const records = join(directory, 'records')
    try {
      const entry = await lstat(records)
      if (!entry.isDirectory() || entry.isSymbolicLink()) return { status: 'ignored', reason: 'unsafe-path' }
    } catch (error) {
      // Never let the store create a missing records directory: a read must not make state.
      return { status: 'ignored', reason: code(error) === 'ENOENT' ? 'no-records-dir' : 'unsafe-path' }
    }
    if (!deps.readsAllowed()) return { status: 'absent' }
    const stored = await deps.keys.readFile(join(directory, 'key.v1'))
    if (!stored.ok) return { status: 'ignored', reason: stored.reason === 'missing' ? 'key-missing' : 'key-unreadable' }
    const unwrapped = deps.keys.unwrap(stored.wrapped)
    if (!unwrapped.ok) return { status: 'ignored', reason: 'key-unwrap' }
    keyBuffer = unwrapped.key
    const storage = createIncrementalMeetingJournalFileStorage({
      root: records,
      meetingId,
      key: Uint8Array.from(keyBuffer),
      maxJournalBytes: limits.maxJournalBytes,
      ...budget,
      isCurrent: deps.readsAllowed,
      gateway: createStorageGateway({ root: () => records, detector: LOCAL_JOURNAL_DETECTOR })
    })
    if (!storage) return { status: 'ignored', reason: 'storage' }
    const snapshot = await storage.readSnapshot(meetingId, deps.readsAllowed)
    if (snapshot.status !== 'ok') {
      storage.dispose()
      return { status: 'ignored', reason: 'manifest' }
    }
    return { status: 'open', meetingId, storage, snapshot: snapshot.snapshot }
  } catch {
    return { status: 'ignored', reason: 'storage' }
  } finally {
    keyBuffer?.fill(0)
  }
}

/** The journal's lifecycle state, without reading any record. */
export async function readJournalState(
  deps: JournalReaderDeps,
  meetingId: string
): Promise<
  { status: 'ok'; state: JournalState } | { status: 'absent' } | { status: 'ignored'; reason: JournalIgnoreReason }
> {
  const opened = await openJournal(deps, meetingId)
  if (opened.status !== 'open') return opened
  opened.storage.dispose()
  return { status: 'ok', state: opened.snapshot.state }
}

/**
 * Every durable record of one journal, in revision order. All or nothing: a record that fails its integrity check,
 * does not parse as a canonical record, or a page that cannot be read ignores the whole journal.
 */
export async function readJournal(deps: JournalReaderDeps, meetingId: string): Promise<JournalReadResult> {
  const opened = await openJournal(deps, meetingId)
  if (opened.status !== 'open') return opened
  const { storage, snapshot } = opened
  try {
    const limits = deps.limits ?? LIVE_MEETING_JOURNAL_LIMITS
    if (snapshot.recordCount > limits.maxRecords) return { status: 'ignored', reason: 'too-large' }
    const records: JournalRecord[] = []
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let after = 0
    while (after < snapshot.durableRevision) {
      const page = await storage.readPage(
        after,
        snapshot.durableRevision,
        PAGE_RECORDS,
        (record) => {
          const parsed = IncrementalMeetingRecordSchema.safeParse(JSON.parse(decoder.decode(record.canonicalBytes)))
          if (!parsed.success) throw new Error('INVALID_RECORD')
          records.push({
            revision: record.revision,
            identityKey: lineIdentityKey(parsed.data.line),
            line: parsed.data.line
          })
        },
        deps.readsAllowed
      )
      if (page.status !== 'ok' || page.nextRevision <= after) return { status: 'ignored', reason: 'read-failed' }
      after = page.nextRevision
      if (page.complete) break
      // Yield between pages so launch recovery never starves the event loop on a long meeting.
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    if (after !== snapshot.durableRevision) return { status: 'ignored', reason: 'read-failed' }
    return { status: 'ok', meetingId, state: snapshot.state, records }
  } catch {
    return { status: 'ignored', reason: 'read-failed' }
  } finally {
    storage.dispose()
  }
}

/** First readable journal for the meeting among the plausible owners, with the owner that matched. */
export async function readJournalForMeeting(
  deps: JournalReaderDeps,
  startedAt: number,
  owners: ReadonlyArray<string | null>
): Promise<
  | (Extract<JournalReadResult, { status: 'ok' }> & { ownerKey: string | null })
  | { status: 'absent' }
  | { status: 'ignored'; reason: JournalIgnoreReason }
> {
  let ignored: JournalIgnoreReason | null = null
  for (const ownerKey of owners) {
    const read = await readJournal(deps, liveMeetingJournalId(startedAt, ownerKey))
    if (read.status === 'ok') return { ...read, ownerKey }
    if (read.status === 'ignored') ignored ??= read.reason
  }
  return ignored ? { status: 'ignored', reason: ignored } : { status: 'absent' }
}

/**
 * The meeting start recorded beside the journal (`meeting.v1`), accepted only when it reproduces the directory name
 * for one of the plausible owners. A start that does not verify (tampered, or another owner's journal) is not used.
 */
export async function readVerifiedJournalStart(
  userDataPath: string,
  meetingId: string,
  owners: ReadonlyArray<string | null>
): Promise<{ startedAt: number; ownerKey: string | null } | null> {
  try {
    const root = await resolveMeetingJournalRoot(userDataPath)
    if (root === 'absent' || root === 'unsafe') return null
    const directory = join(root, meetingId.toLowerCase())
    const container = await lstat(directory)
    // Never read through a link planted where a journal directory belongs.
    if (!container.isDirectory() || container.isSymbolicLink()) return null
    const path = join(directory, 'meeting.v1')
    const entry = await lstat(path)
    if (!entry.isFile() || entry.size > START_FILE_MAX_BYTES) return null
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { v?: unknown; startedAt?: unknown }
    if (parsed.v !== 1 || typeof parsed.startedAt !== 'number' || !Number.isSafeInteger(parsed.startedAt)) return null
    for (const ownerKey of owners) {
      if (liveMeetingJournalId(parsed.startedAt, ownerKey) === meetingId.toLowerCase()) {
        return { startedAt: parsed.startedAt, ownerKey }
      }
    }
    return null
  } catch {
    return null
  }
}

/** Journal directory names under `<userData>/meeting-journal`, valid ids only, with a bounded count. */
export async function listJournalIds(userDataPath: string, max = 500): Promise<string[] | 'unsafe'> {
  const root = await resolveMeetingJournalRoot(userDataPath)
  if (root === 'absent') return []
  if (root === 'unsafe') return 'unsafe'
  try {
    return (await readdir(root)).filter((name) => MEETING_JOURNAL_ID.test(name)).slice(0, max)
  } catch {
    return []
  }
}
