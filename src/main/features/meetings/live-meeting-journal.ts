import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { TranscriptLine } from '@shared/transcript-line'
import { atomicSavedWrite } from '../../infra/storage/atomic-saved-write'
import { createStorageGateway } from '../../infra/storage/gateway'
import type { ContentPresence, DatalessDetector } from '../../infra/storage/dataless'
import { canonicalizeIncrementalMeetingRecord } from '../../infra/storage/incremental-record-canonical'
import { issueIncrementalRecordReceipt } from '../../infra/storage/incremental-record-receipt'
import type {
  ContentKeyUnwrapResult,
  ContentKeyWrapResult,
  WrappedKeyFileReadResult,
  WrappedKeyFileWriteResult
} from '../../infra/security/content-key-wrap'
import {
  createIncrementalMeetingAppender,
  type IncrementalAppendResult,
  type IncrementalJournalLimits,
  type IncrementalMeetingAppender
} from './incremental-meeting-journal'
import {
  createIncrementalMeetingJournalFileStorage,
  type IncrementalMeetingJournalFileStorage
} from './incremental-meeting-journal-files'
import {
  LIVE_MEETING_JOURNAL_APPEND_QUEUE_MAX,
  LIVE_MEETING_JOURNAL_LIMITS,
  LIVE_MEETING_JOURNAL_OPEN_RETRY_MS,
  LIVE_MEETING_JOURNAL_STORAGE_BUDGET,
  validateLiveMeetingJournalPolicy
} from './live-meeting-journal-policy'

/**
 * The live meeting journal (WP03 / C09b T4): one durable, encrypted record per committed cloud-final line, so a crash
 * loses at most the in-flight record instead of up to a 60 s draft interval.
 *
 * Layout, under `<userData>/meeting-journal/<meetingUuid>/` (never the user's meetings folder, never synced):
 *   key.v1    the wrapped content key (safeStorage or the AES-GCM file backend), mode 0600, OUTSIDE the records dir;
 *   records/  the journal root. It starts empty (the file adapter refuses a populated root on first use).
 *
 * Invariants:
 *  - capture never waits on, or fails because of, the journal: `append` never rejects and never throws, and a
 *    refusal is a typed outcome that is counted and audited as metadata only (no transcript text, no key material);
 *  - kill switch off, summary-only profile, unreadable settings or a missing speech policy => no directory, no key,
 *    no file I/O at all;
 *  - ownership is proven against the transcript revision store on every append and at every storage boundary
 *    (`isCurrent`): the meeting must still be bound to the same frame, the same owner and the same auth generation;
 *  - at most `queueMax` appends wait per meeting; the next one is refused (`QUEUE_FULL`) and the 60 s draft tick
 *    covers it. Commits are serialised by the storage's own per-meeting mutation lock (`withIncrementalMeetingMutation`).
 */

export type LiveJournalRefusal =
  | 'DISABLED'
  | 'NOT_OWNER'
  | 'STALE_OWNER'
  | 'QUEUE_FULL'
  | 'INVALID_RECORD'
  | 'STALE_REVISION'
  | 'CONFLICTING_IDENTITY'
  | 'LIMIT'
  | 'UNAVAILABLE'

export type LiveJournalAppendOutcome =
  | { status: 'durable'; duplicate: boolean }
  | { status: 'refused'; reason: LiveJournalRefusal }

export interface LiveJournalKeyCustody {
  generate(): Buffer
  wrap(key: Buffer): ContentKeyWrapResult
  unwrap(wrapped: string): ContentKeyUnwrapResult
  writeFile(path: string, wrapped: string): Promise<WrappedKeyFileWriteResult>
  readFile(path: string): Promise<WrappedKeyFileReadResult>
}

export interface LiveJournalAuditRecord {
  /** Enum only; never content. */
  reason: LiveJournalRefusal
  /** Refusals of this reason for the meeting so far (the first one is audited, later ones are only counted). */
  count: number
}

export interface LiveMeetingJournalDeps {
  /** Main-owned userData directory (injected so this module never imports electron). */
  userDataPath(): string
  /** Kill switch, summary-only profile, readable settings and installed speech policy, evaluated on every use. */
  enabled(): boolean
  /** The transcript revision store's ownership record for a meeting; null once it is closed or was never opened. */
  bindingOf(startedAt: number): { frameOwner: string; ownerKey: string | null } | null
  authGeneration(): number
  keys: LiveJournalKeyCustody
  audit(event: 'meeting.journal.degraded', record: LiveJournalAuditRecord): void
  now?(): number
  /** Test seams; production uses the frozen policy. */
  limits?: Readonly<IncrementalJournalLimits>
  queueMax?: number
}

export interface LiveJournalAppendInput {
  startedAt: number
  /** `<processId>:<routingId>` of the frame that sent the line, taken from the IPC sender and never the payload. */
  frameOwner: string
  line: TranscriptLine
}

export interface LiveMeetingJournal {
  /** Never rejects. */
  append(input: LiveJournalAppendInput): Promise<LiveJournalAppendOutcome>
  /** Ends one meeting's session (meeting stop). Files stay for recovery. */
  close(startedAt: number): Promise<void>
  /** Ends the sessions of a revoked owner. A session opened signed out (`ownerKey` null) is never closed by it. */
  closeOwnedBy(ownerKey: string): Promise<void>
  /** Ends every session (kill switch off, will-quit). */
  dispose(): Promise<void>
  /** Meetings with a live session, for diagnostics and tests. */
  activeMeetings(): number[]
  /** Journal ids of the live sessions: a retention sweep never deletes one of these. */
  activeJournalIds(): string[]
  /** Every journal id this process opened for the meeting (any owner), so a purge finds them after the session ends. */
  journalIdsFor(startedAt: number): string[]
}

/** Meetings whose first auth generation is remembered (the active one plus a few recent). */
const GENERATION_MEMORY = 16
const JOURNAL_DIR = 'meeting-journal'
const KEY_FILE = 'key.v1'
const START_FILE = 'meeting.v1'
const RECORDS_DIR = 'records'
const ID_PREFIX = 'metis-live-meeting-journal-v1'
const AUDITED_REASONS: ReadonlySet<LiveJournalRefusal> = new Set<LiveJournalRefusal>([
  'QUEUE_FULL',
  'INVALID_RECORD',
  'CONFLICTING_IDENTITY',
  'LIMIT',
  'UNAVAILABLE'
])

/** Everything under userData is on this device; probing every record file for cloud placeholders would be waste. */
export const LOCAL_JOURNAL_DETECTOR: DatalessDetector = {
  classify: async (files) => new Map(files.map((file): [string, ContentPresence] => [file.path, 'local']))
}

/**
 * Deterministic journal identity for one meeting of one owner: SHA-256 of a domain-separated string, shaped as a
 * version-8 / variant-8..b UUID (the journal format accepts versions 1-8). Deterministic so crash recovery can
 * recompute it from the draft's start time with no mapping to persist; owner-scoped so two signed-in owners on one
 * install never share a journal. The owner key is hashed, never stored or logged.
 */
export function liveMeetingJournalId(startedAt: number, ownerKey: string | null): string {
  const digest = createHash('sha256')
    .update(`${ID_PREFIX}\0${ownerKey ?? ''}\0${startedAt}`)
    .digest()
  digest[6] = (digest[6]! & 0x0f) | 0x80
  digest[8] = (digest[8]! & 0x3f) | 0x80
  const hex = digest.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** `<userData>/meeting-journal/<uuid>`; the only place the journal ever touches. */
export function liveMeetingJournalDirectory(userDataPath: string, meetingId: string): string {
  return join(userDataPath, JOURNAL_DIR, meetingId)
}

function refused(reason: LiveJournalRefusal): LiveJournalAppendOutcome {
  return { status: 'refused', reason }
}

/** The one canonical record for a committed cloud final, or null when the line is not one. */
function recordBytes(line: TranscriptLine): Uint8Array | null {
  const speech = line.speech
  if (!speech || speech.type !== 'segment' || speech.segment.final !== true || line.provisional === true) return null
  return new TextEncoder().encode(
    JSON.stringify({
      identity: {
        kind: 'cloud',
        captureId: speech.captureId,
        captureGeneration: speech.captureGeneration,
        streamGeneration: speech.segment.stream.generation,
        track: speech.segment.stream.track,
        epoch: speech.segment.stream.epoch,
        segmentIndex: speech.segment.index
      },
      source: 'cloud-final',
      line
    })
  )
}

interface PendingAppend {
  json: Uint8Array
  resolve(outcome: LiveJournalAppendOutcome): void
}

interface Session {
  readonly startedAt: number
  readonly frameOwner: string
  readonly ownerKey: string | null
  readonly meetingId: string
  readonly generation: number
  disposed: boolean
  queue: PendingAppend[]
  draining: Promise<void> | null
  ready: Promise<boolean>
  storage: IncrementalMeetingJournalFileStorage | undefined
  appender: IncrementalMeetingAppender | undefined
  revision: number
  refusals: Map<LiveJournalRefusal, number>
}

export function createLiveMeetingJournal(deps: LiveMeetingJournalDeps): LiveMeetingJournal {
  const now = deps.now ?? Date.now
  const limits = deps.limits ?? LIVE_MEETING_JOURNAL_LIMITS
  const queueMax = deps.queueMax ?? LIVE_MEETING_JOURNAL_APPEND_QUEUE_MAX
  const sessions = new Map<number, Session>()
  const openFailedAt = new Map<number, number>()
  /** The auth generation each meeting first journaled under: a later change never re-admits that meeting. */
  const generationOf = new Map<number, number>()
  /** Journal ids opened for each meeting by this process (the owner key is not recoverable from an id). */
  const idsOf = new Map<number, Set<string>>()
  const closing = new Set<Promise<void>>()

  const enabled = (): boolean => {
    try {
      return deps.enabled()
    } catch {
      return false
    }
  }

  /** Same meeting, same frame, same owner, same auth generation, journal still on, session not ended. */
  const current = (session: Session): boolean => {
    try {
      if (session.disposed || !deps.enabled() || deps.authGeneration() !== session.generation) return false
      const binding = deps.bindingOf(session.startedAt)
      return binding !== null && binding.frameOwner === session.frameOwner && binding.ownerKey === session.ownerKey
    } catch {
      return false
    }
  }

  const note = (session: Session, reason: LiveJournalRefusal): void => {
    const count = (session.refusals.get(reason) ?? 0) + 1
    session.refusals.set(reason, count)
    if (count !== 1 || !AUDITED_REASONS.has(reason)) return
    try {
      deps.audit('meeting.journal.degraded', { reason, count })
    } catch {
      /* auditing never changes the outcome */
    }
  }

  const refuse = (session: Session | undefined, reason: LiveJournalRefusal): LiveJournalAppendOutcome => {
    if (session) note(session, reason)
    return refused(reason)
  }

  const closeSession = (session: Session): Promise<void> => {
    if (session.disposed) return Promise.resolve()
    session.disposed = true
    if (sessions.get(session.startedAt) === session) sessions.delete(session.startedAt)
    for (const pending of session.queue.splice(0)) pending.resolve(refused('STALE_OWNER'))
    // The in-flight append and a pending open settle first: the key buffer is zeroed only when nothing can use it.
    const done = Promise.allSettled([session.ready, session.draining]).then(() => {
      session.storage?.dispose()
      session.storage = undefined
      session.appender = undefined
    })
    closing.add(done)
    void done.finally(() => closing.delete(done))
    return done
  }

  const hasEntries = async (directory: string): Promise<boolean> => {
    try {
      return (await readdir(directory)).length > 0
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return false
      return true
    }
  }

  /** Key custody + encrypted store, created lazily at the first append. Fails closed; never writes a plaintext key. */
  const open = async (session: Session): Promise<boolean> => {
    let key: Buffer | undefined
    try {
      validateLiveMeetingJournalPolicy(limits, LIVE_MEETING_JOURNAL_STORAGE_BUDGET, queueMax)
      const directory = liveMeetingJournalDirectory(deps.userDataPath(), session.meetingId)
      const records = join(directory, RECORDS_DIR)
      const keyPath = join(directory, KEY_FILE)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const entry = await lstat(directory)
      if (!entry.isDirectory() || entry.isSymbolicLink() || !current(session)) return false

      const stored = await deps.keys.readFile(keyPath)
      if (stored.ok) {
        const unwrapped = deps.keys.unwrap(stored.wrapped)
        if (!unwrapped.ok) return false // never start a new key over records this device cannot read
        key = unwrapped.key
      } else if (stored.reason === 'missing') {
        // Records without their key are unreadable: a populated root with no key file is never reused.
        if (await hasEntries(records)) return false
        key = deps.keys.generate()
        const wrapped = deps.keys.wrap(key)
        if (!wrapped.ok) return false
        if (!(await deps.keys.writeFile(keyPath, wrapped.wrapped)).ok) return false
      } else {
        return false
      }
      if (key.byteLength !== 32 || !current(session)) return false
      await mkdir(records, { recursive: true, mode: 0o700 })
      if (!current(session)) return false
      await writeStartFile(directory, session.startedAt)

      const storage = createIncrementalMeetingJournalFileStorage({
        root: records,
        meetingId: session.meetingId,
        key: Uint8Array.from(key),
        maxJournalBytes: limits.maxJournalBytes,
        ...LIVE_MEETING_JOURNAL_STORAGE_BUDGET,
        isCurrent: () => current(session),
        gateway: createStorageGateway({ root: () => records, detector: LOCAL_JOURNAL_DETECTOR })
      })
      if (!storage) return false
      const initialized = await storage.initialize()
      if (initialized.status !== 'ok' || initialized.snapshot.state !== 'active' || !current(session)) {
        storage.dispose()
        return false
      }
      session.storage = storage
      session.revision = initialized.snapshot.acceptedRevision
      session.appender = createIncrementalMeetingAppender({
        meetingId: session.meetingId,
        readLimits: () => limits,
        isCurrent: () => current(session),
        // Inline, in main, for one record: no worker dependency and no queue behind the speech worker.
        canonicalizeRecord: async (bytes, binding) => {
          const source = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
          const result = canonicalizeIncrementalMeetingRecord(source, binding.limits, binding.maxCanonicalBytes)
          if (!result.ok) throw new Error(result.reason)
          const receipt = issueIncrementalRecordReceipt(result.value, binding)
          if (!receipt) throw new Error('INVALID_RECORD')
          return receipt
        },
        storage
      })
      return true
    } catch {
      return false
    } finally {
      key?.fill(0)
    }
  }

  /**
   * `meeting.v1` beside the key (never inside the records dir): the meeting start, so a launch with no draft can still
   * recompute and verify this journal's id. The start time is not content (draft file names already carry it); it
   * is verified against the directory name at recovery, so a wrong value is never trusted. Best effort.
   */
  const writeStartFile = async (directory: string, startedAt: number): Promise<void> => {
    const path = join(directory, START_FILE)
    try {
      await lstat(path)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') return
    }
    try {
      await atomicSavedWrite(path, Buffer.from(JSON.stringify({ v: 1, startedAt }), 'utf8'))
    } catch {
      /* journal-only promotion needs it; the draft merge does not */
    }
  }

  const refusalFor = (result: Extract<IncrementalAppendResult, { status: 'refused' }>): LiveJournalRefusal => {
    switch (result.reason) {
      case 'STALE_OWNER':
      case 'STALE_REVISION':
      case 'CONFLICTING_IDENTITY':
      case 'LIMIT':
      case 'INVALID_RECORD':
      case 'QUEUE_FULL':
        return result.reason
      default:
        return 'UNAVAILABLE'
    }
  }

  const processItem = async (session: Session, item: PendingAppend): Promise<LiveJournalAppendOutcome> => {
    const appender = session.appender
    const storage = session.storage
    if (!appender || !storage || !current(session)) return refuse(session, 'STALE_OWNER')
    let result = await appender.append(item.json, session.revision)
    if (result.status === 'refused' && result.reason === 'STALE_REVISION') {
      // Another writer or an uncertain earlier commit moved the frontier: re-read it once and retry this record.
      const snapshot = await storage.readSnapshot(session.meetingId, () => current(session))
      if (snapshot.status === 'ok') {
        session.revision = snapshot.snapshot.acceptedRevision
        result = await appender.append(item.json, session.revision)
      }
    }
    if (result.status === 'durable') {
      if (!result.duplicate) session.revision = result.revision
      return { status: 'durable', duplicate: result.duplicate }
    }
    return refuse(session, refusalFor(result))
  }

  const drain = (session: Session): void => {
    if (session.draining) return
    const run = (async (): Promise<void> => {
      try {
        if (!(await session.ready)) {
          // An open that lost its owner (meeting closed, auth changed) is expected; any other failure is audited and
          // not retried for a while so a broken store costs bounded I/O instead of a retry per final.
          const reason: LiveJournalRefusal = current(session) ? 'UNAVAILABLE' : 'STALE_OWNER'
          if (reason === 'UNAVAILABLE') openFailedAt.set(session.startedAt, now())
          for (const pending of session.queue.splice(0)) pending.resolve(refuse(session, reason))
          void closeSession(session)
          return
        }
        for (let item = session.queue.shift(); item; item = session.queue.shift()) {
          let outcome: LiveJournalAppendOutcome
          try {
            outcome = await processItem(session, item)
          } catch {
            outcome = refuse(session, 'UNAVAILABLE')
          }
          item.resolve(outcome)
        }
      } finally {
        session.draining = null
        if (session.queue.length > 0 && !session.disposed) drain(session)
      }
    })()
    session.draining = run
  }

  /** Ends sessions whose meeting is closed in the store, rebound elsewhere, or no longer current. */
  const sweep = (): void => {
    for (const session of [...sessions.values()]) if (!current(session)) void closeSession(session)
    for (const [startedAt, at] of [...openFailedAt])
      if (now() - at >= LIVE_MEETING_JOURNAL_OPEN_RETRY_MS) openFailedAt.delete(startedAt)
  }

  return {
    async append(input) {
      try {
        if (!enabled()) {
          for (const session of [...sessions.values()]) void closeSession(session)
          return refused('DISABLED')
        }
        sweep()
        const binding = deps.bindingOf(input.startedAt)
        if (!binding || binding.frameOwner !== input.frameOwner) return refused('NOT_OWNER')
        const json = recordBytes(input.line)
        if (!json) return refused('INVALID_RECORD')

        let session = sessions.get(input.startedAt)
        if (session && (session.frameOwner !== binding.frameOwner || session.ownerKey !== binding.ownerKey)) {
          void closeSession(session)
          session = undefined
        }
        if (!session) {
          const failedAt = openFailedAt.get(input.startedAt)
          if (failedAt !== undefined && now() - failedAt < LIVE_MEETING_JOURNAL_OPEN_RETRY_MS)
            return refused('UNAVAILABLE')
          const generation = deps.authGeneration()
          if ((generationOf.get(input.startedAt) ?? generation) !== generation) return refused('STALE_OWNER')
          generationOf.set(input.startedAt, generation)
          while (generationOf.size > GENERATION_MEMORY) {
            const oldest = generationOf.keys().next()
            if (oldest.done) break
            generationOf.delete(oldest.value)
          }
          const created: Session = {
            startedAt: input.startedAt,
            frameOwner: binding.frameOwner,
            ownerKey: binding.ownerKey,
            meetingId: liveMeetingJournalId(input.startedAt, binding.ownerKey),
            generation,
            disposed: false,
            queue: [],
            draining: null,
            ready: Promise.resolve(false),
            storage: undefined,
            appender: undefined,
            revision: 0,
            refusals: new Map()
          }
          sessions.set(created.startedAt, created)
          const known = idsOf.get(created.startedAt) ?? new Set<string>()
          known.add(created.meetingId)
          idsOf.set(created.startedAt, known)
          while (idsOf.size > GENERATION_MEMORY) {
            const oldest = idsOf.keys().next()
            if (oldest.done) break
            idsOf.delete(oldest.value)
          }
          created.ready = open(created)
          session = created
        }
        if (session.queue.length >= queueMax) return refuse(session, 'QUEUE_FULL')
        const target = session
        return await new Promise<LiveJournalAppendOutcome>((resolve) => {
          target.queue.push({ json, resolve })
          drain(target)
        })
      } catch {
        return refused('UNAVAILABLE')
      }
    },
    async close(startedAt) {
      const session = sessions.get(startedAt)
      if (session) await closeSession(session)
    },
    async closeOwnedBy(ownerKey) {
      await Promise.all([...sessions.values()].filter((s) => s.ownerKey === ownerKey).map((s) => closeSession(s)))
    },
    async dispose() {
      await Promise.all([...sessions.values()].map((session) => closeSession(session)))
      await Promise.allSettled([...closing])
    },
    activeMeetings() {
      return [...sessions.keys()]
    },
    activeJournalIds() {
      return [...sessions.values()].map((session) => session.meetingId)
    },
    journalIdsFor(startedAt) {
      return [...(idsOf.get(startedAt) ?? [])]
    }
  }
}
