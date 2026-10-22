/**
 * The encrypted dictation segment journal (G26). It keeps what a dictation recognized until that text is verified
 * into a field, so an interruption (a crash, a quit, a failed insertion) never costs the person their words.
 *
 * Layout, under the injected root (`<userData>/dictation-memory/journal/`, never the meetings folder, never synced):
 *   <id>.dj1   one sealed record per dictation turn (AES-256-GCM, the id bound in as additional data).
 * The content key lives beside it in `key.v1`, wrapped by the OS keychain or the file backend (see the keyring).
 *
 * A record holds the recognized segments of the turn and, once the guard kept it, the preserved draft. Every append
 * rewrites the whole bounded record atomically, so a crash leaves the previous complete record, never a torn one.
 *
 * Invariants:
 *  - a verified insertion deletes the record (`complete`); what survives is exactly what was never verified;
 *  - recovery is offered once: `take` marks a record offered before returning it, `resolve` deletes it, and the next
 *    launch sweep retires any offered record nobody resolved. A recovered draft is returned as text; nothing here
 *    inserts anything;
 *  - a turn still being dictated in this process is never offered, evicted or swept;
 *  - bounded: seven day retention, at most N records, at most M segments and K bytes per record (all PROPOSED, see
 *    dictation-memory-policy.ts). A segment over a bound is refused, never truncated;
 *  - another partition's records are neither offered, resolved nor deleted early (they age out by retention);
 *  - a record's age is the time sealed inside it, so touching the file extends nothing;
 *  - async fs only; no method rejects: a failure is a typed outcome. Nothing here logs or audits text.
 */
import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { DictationRecoveryItem } from '@shared/dictation-memory'
import { DICTATION_RECOVERY_TEXT_MAX_CHARS } from '@shared/dictation-memory'
import { atomicSavedWrite } from '../../infra/storage/atomic-saved-write'
import type { PriorDraft } from '../desktop-contract'
import type { MemoryKeyring } from './dictation-memory-crypto'
import {
  DICTATION_JOURNAL_LIMITS,
  DICTATION_JOURNAL_SCAN_MAX,
  type DictationJournalLimits
} from './dictation-memory-policy'
import { mintOwnedSpan, type OwnedSpan } from './dictation-owned-span'

export type JournalRefusal = 'DISABLED' | 'UNAVAILABLE' | 'LIMIT' | 'INVALID' | 'COMPLETED'
export type JournalOutcome = { status: 'durable' } | { status: 'refused'; reason: JournalRefusal }
export type JournalResolve = { status: 'resolved'; text: string; span: OwnedSpan } | { status: 'unknown' }

export interface JournalSweepCounts {
  expired: number
  evicted: number
  retired: number
  unreadable: number
  temp: number
}

export interface DictationJournalDeps {
  /** `<userData>/dictation-memory/journal`. Created on first write. */
  rootDir(): string
  keyring: MemoryKeyring
  /**
   * The memory partition in force (G19), on every use; null when none is open (signed out, unverified, switching).
   * Without one nothing is recorded, offered or resolved. Records of another partition are never touched.
   */
  partition(): string | null
  /** Lifecycle generation supplied by memory; changes when the owner is revoked or memory is disposed. */
  ownerEpoch?(): number
  /** Whether the journal may record or offer right now. Deleting never needs it. */
  enabled(): boolean
  now(): number
  /** Test seam: may only tighten the policy. */
  limits?: Partial<DictationJournalLimits>
}

export interface DictationJournal {
  appendSegment(turnId: string, text: string): Promise<JournalOutcome>
  preserveDraft(
    turnId: string,
    draft: Pick<PriorDraft, 'text' | 'reason' | 'state' | 'preservedAtMs'>
  ): Promise<JournalOutcome>
  /** A verified insertion: the record is deleted and can never be offered. Idempotent. */
  complete(turnId: string): Promise<void>
  /** The turn is over in this process: its record, if any, may now be offered. Synchronous. */
  endTurn(turnId: string): void
  /** The records this partition may be offered now, marked offered. Never the same record twice. */
  take(): Promise<DictationRecoveryItem[]>
  /** The person acted on an offered record: delete it and hand its text to the owned-span path. */
  resolve(id: string): Promise<JournalResolve>
  /** Deletes every record that is not being dictated now, whatever its partition. Returns how many. */
  purge(): Promise<number>
  /** Launch housekeeping: expired, unreadable, temp, over-cap and (optionally) offered-and-ignored records. */
  sweep(options: { retireOffered: boolean }): Promise<JournalSweepCounts>
  /** The file id (opaque, 32 hex) a turn is journaled under. */
  idFor(turnId: string): string
}

const EntrySchema = z
  .object({
    v: z.literal(1),
    id: z.string().regex(/^[0-9a-f]{32}$/),
    partition: z.string().min(1).max(64),
    createdAtMs: z.number().int().nonnegative(),
    updatedAtMs: z.number().int().nonnegative(),
    offered: z.boolean(),
    segments: z.array(
      z.object({ seq: z.number().int().nonnegative(), text: z.string(), atMs: z.number().int().nonnegative() })
    ),
    prior: z
      .object({
        text: z.string(),
        reason: z.string().max(32),
        state: z.string().max(32),
        preservedAtMs: z.number().int().nonnegative()
      })
      .nullable()
  })
  .strict()
type Entry = z.infer<typeof EntrySchema>

const ENTRY_NAME = /^([0-9a-f]{32})\.dj1$/
const TEMP_NAME = /^[0-9a-f]{32}\.dj1\.[0-9a-f]+\.tmp$/
const COMPLETED_MEMORY = 256

const fileIdFor = (turnId: string): string =>
  createHash('sha256').update(`dictation-journal:${turnId}`).digest('hex').slice(0, 32)

/** The text a person gets back: the guard's kept draft when there is one, else what was recognized, in order. */
function recoveredText(entry: Entry): string {
  const text = entry.prior ? entry.prior.text : entry.segments.map((segment) => segment.text).join(' ')
  return text.length > DICTATION_RECOVERY_TEXT_MAX_CHARS ? text.slice(0, DICTATION_RECOVERY_TEXT_MAX_CHARS) : text
}

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'

export function createDictationJournal(deps: DictationJournalDeps): DictationJournal {
  const limits: DictationJournalLimits = { ...DICTATION_JOURNAL_LIMITS, ...deps.limits }
  const live = new Set<string>()
  const completed = new Set<string>()
  const lanes = new Map<string, Promise<unknown>>()

  const pathOf = (id: string): string => join(deps.rootDir(), `${id}.dj1`)
  const aadOf = (id: string): string => `dictation-journal:${id}`
  const safe = <T>(value: () => T, fallback: T): T => {
    try {
      return value()
    } catch {
      return fallback
    }
  }
  const ownerEpochOf = (): number | null => {
    if (!deps.ownerEpoch) return 0
    const epoch = safe(deps.ownerEpoch, null)
    return epoch !== null && Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : null
  }
  const ownerIsCurrent = (partition: string, epoch: number): boolean =>
    safe(deps.partition, null) === partition && ownerEpochOf() === epoch

  /** One lane per file: its operations run in order and a failure never poisons the next. */
  function lane<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = lanes.get(id) ?? Promise.resolve()
    const run = previous.then(work, work)
    const tail = run.catch(() => undefined)
    lanes.set(id, tail)
    void tail.then(() => {
      if (lanes.get(id) === tail) lanes.delete(id)
    })
    return run
  }

  type Read = { status: 'ok'; entry: Entry } | { status: 'missing' } | { status: 'unreadable' }

  async function read(id: string): Promise<Read> {
    try {
      const stats = await lstat(pathOf(id))
      if (!stats.isFile() || stats.size > limits.maxEntryBytes + 4_096) return { status: 'unreadable' }
      const opened = await deps.keyring.open(await readFile(pathOf(id)), aadOf(id))
      if (!opened) return { status: 'unreadable' }
      const parsed = EntrySchema.safeParse(JSON.parse(opened.toString('utf8')))
      return parsed.success && parsed.data.id === id ? { status: 'ok', entry: parsed.data } : { status: 'unreadable' }
    } catch (error) {
      return isMissing(error) ? { status: 'missing' } : { status: 'unreadable' }
    }
  }

  /** Seals and atomically replaces the record. Refuses an over-size record. */
  async function write(entry: Entry): Promise<JournalRefusal | null> {
    try {
      const json = Buffer.from(JSON.stringify(entry), 'utf8')
      if (json.byteLength > limits.maxEntryBytes) return 'LIMIT'
      const sealed = await deps.keyring.seal(json, aadOf(entry.id))
      json.fill(0)
      if (!sealed) return 'UNAVAILABLE'
      await mkdir(deps.rootDir(), { recursive: true, mode: 0o700 })
      await atomicSavedWrite(pathOf(entry.id), sealed)
      return null
    } catch {
      return 'UNAVAILABLE'
    }
  }

  async function remove(id: string): Promise<boolean> {
    try {
      await unlink(pathOf(id))
      return true
    } catch (error) {
      return isMissing(error)
    }
  }

  async function names(): Promise<string[]> {
    try {
      return await readdir(deps.rootDir())
    } catch {
      return []
    }
  }

  const expired = (entry: Entry): boolean => entry.updatedAtMs + limits.retentionMs < deps.now()

  /** Evicts the oldest records that are not live until there is room for one more. */
  async function makeRoom(): Promise<void> {
    const ids = (await names()).map((name) => ENTRY_NAME.exec(name)?.[1]).filter((id): id is string => Boolean(id))
    if (ids.length < limits.maxEntries) return
    const candidates: Array<{ id: string; updatedAtMs: number }> = []
    for (const id of ids) {
      if (live.has(id)) continue
      const result = await lane(id, () => read(id))
      candidates.push({ id, updatedAtMs: result.status === 'ok' ? result.entry.updatedAtMs : 0 })
    }
    candidates.sort((a, b) => a.updatedAtMs - b.updatedAtMs)
    let count = ids.length
    for (const victim of candidates) {
      if (count < limits.maxEntries) break
      if (await lane(victim.id, () => remove(victim.id))) count--
    }
  }

  async function mutate(
    turnId: string,
    change: (entry: Entry | null) => Entry | JournalRefusal
  ): Promise<JournalOutcome> {
    const id = fileIdFor(turnId)
    return lane(id, async (): Promise<JournalOutcome> => {
      const existing = await read(id)
      if (existing.status === 'unreadable') return { status: 'refused', reason: 'UNAVAILABLE' }
      const partition = safe(deps.partition, null)
      if (partition === null) return { status: 'refused', reason: 'UNAVAILABLE' }
      if (existing.status === 'ok' && existing.entry.partition !== partition) {
        return { status: 'refused', reason: 'UNAVAILABLE' }
      }
      const next = change(existing.status === 'ok' ? existing.entry : null)
      if (typeof next === 'string') return { status: 'refused', reason: next }
      if (existing.status === 'missing') await makeRoom()
      const failure = await write(next)
      return failure ? { status: 'refused', reason: failure } : { status: 'durable' }
    })
  }

  const blank = (id: string, partition: string): Entry => ({
    v: 1,
    id,
    partition,
    createdAtMs: deps.now(),
    updatedAtMs: deps.now(),
    offered: false,
    segments: [],
    prior: null
  })

  function precheck(turnId: string, text: string): JournalRefusal | null {
    if (!safe(deps.enabled, false)) return 'DISABLED'
    if (completed.has(fileIdFor(turnId))) return 'COMPLETED'
    if (text.trim().length === 0) return 'INVALID'
    if (text.length > limits.maxSegmentChars) return 'LIMIT'
    return null
  }

  return {
    idFor: fileIdFor,

    async appendSegment(turnId, text) {
      const refusal = precheck(turnId, text)
      if (refusal) return { status: 'refused', reason: refusal }
      const id = fileIdFor(turnId)
      live.add(id)
      const partition = safe(deps.partition, null) ?? ''
      return mutate(turnId, (existing) => {
        const entry = existing ?? blank(id, partition)
        if (entry.segments.length >= limits.maxSegments) return 'LIMIT'
        return {
          ...entry,
          updatedAtMs: deps.now(),
          segments: [...entry.segments, { seq: entry.segments.length, text, atMs: deps.now() }]
        }
      })
    },

    async preserveDraft(turnId, draft) {
      const refusal = precheck(turnId, draft.text)
      if (refusal) return { status: 'refused', reason: refusal }
      const id = fileIdFor(turnId)
      const partition = safe(deps.partition, null) ?? ''
      return mutate(turnId, (existing) => ({
        ...(existing ?? blank(id, partition)),
        updatedAtMs: deps.now(),
        prior: {
          text: draft.text,
          reason: String(draft.reason).slice(0, 32),
          state: String(draft.state).slice(0, 32),
          preservedAtMs:
            Number.isSafeInteger(draft.preservedAtMs) && draft.preservedAtMs >= 0 ? draft.preservedAtMs : deps.now()
        }
      }))
    },

    async complete(turnId) {
      const id = fileIdFor(turnId)
      completed.add(id)
      if (completed.size > COMPLETED_MEMORY) completed.delete(completed.values().next().value as string)
      live.delete(id)
      await lane(id, () => remove(id))
    },

    endTurn(turnId) {
      live.delete(fileIdFor(turnId))
    },

    async take() {
      const partition = safe(deps.partition, null)
      if (!safe(deps.enabled, false) || partition === null) return []
      const offered: Array<{ item: DictationRecoveryItem; order: number }> = []
      for (const name of await names()) {
        const id = ENTRY_NAME.exec(name)?.[1]
        if (!id || live.has(id)) continue
        await lane(id, async () => {
          const current = await read(id)
          if (current.status !== 'ok') return
          const { entry } = current
          if (entry.partition !== partition || entry.offered || expired(entry) || live.has(id)) return
          const text = recoveredText(entry)
          if (text.trim().length === 0) return
          // Mark first: a record is never returned unless it is durably marked, so it can never be offered twice.
          if ((await write({ ...entry, offered: true })) !== null) return
          offered.push({
            order: entry.updatedAtMs,
            item: { id, text, savedAtMs: entry.updatedAtMs, reason: entry.prior ? 'not_inserted' : 'interrupted' }
          })
        })
      }
      return offered
        .sort((a, b) => a.order - b.order)
        .slice(0, 64)
        .map((entry) => entry.item)
    },

    async resolve(id) {
      if (!/^[0-9a-f]{32}$/.test(id) || live.has(id)) return { status: 'unknown' }
      const partition = safe(deps.partition, null)
      const epoch = ownerEpochOf()
      if (partition === null || epoch === null) return { status: 'unknown' }
      const resolved = await lane(id, async (): Promise<JournalResolve> => {
        if (!ownerIsCurrent(partition, epoch)) return { status: 'unknown' }
        const current = await read(id)
        if (
          current.status !== 'ok' ||
          current.entry.partition !== partition ||
          !current.entry.offered ||
          !ownerIsCurrent(partition, epoch)
        ) {
          return { status: 'unknown' }
        }
        const text = recoveredText(current.entry)
        if (!ownerIsCurrent(partition, epoch)) return { status: 'unknown' }
        const removed = await remove(id)
        if (!removed || !ownerIsCurrent(partition, epoch)) return { status: 'unknown' }
        return { status: 'resolved', text, span: mintOwnedSpan(text, 'recovered-draft') }
      })
      return resolved.status === 'resolved' && ownerIsCurrent(partition, epoch) ? resolved : { status: 'unknown' }
    },

    async purge() {
      let count = 0
      for (const name of await names()) {
        const id = ENTRY_NAME.exec(name)?.[1]
        if (id && !live.has(id) && (await lane(id, () => remove(id)))) count++
      }
      return count
    },

    async sweep(options) {
      const counts: JournalSweepCounts = { expired: 0, evicted: 0, retired: 0, unreadable: 0, temp: 0 }
      const kept: Array<{ id: string; updatedAtMs: number }> = []
      const all = await names()
      const entryIds: string[] = []
      for (const name of all) {
        if (TEMP_NAME.test(name)) {
          try {
            await unlink(join(deps.rootDir(), name))
            counts.temp++
          } catch {
            /* a temp file another process already removed */
          }
          continue
        }
        const id = ENTRY_NAME.exec(name)?.[1]
        if (id) entryIds.push(id)
      }
      // Past the scan bound, the rest are evicted unread: the bound is on work, and the oldest names go first.
      for (const id of entryIds.slice(DICTATION_JOURNAL_SCAN_MAX)) {
        if (live.has(id)) continue
        if (await lane(id, () => remove(id))) counts.evicted++
      }
      for (const id of entryIds.slice(0, DICTATION_JOURNAL_SCAN_MAX)) {
        if (live.has(id)) continue
        await lane(id, async () => {
          const current = await read(id)
          if (current.status === 'missing') return
          if (current.status === 'unreadable') {
            if (await remove(id)) counts.unreadable++
            return
          }
          if (expired(current.entry)) {
            if (await remove(id)) counts.expired++
            return
          }
          if (options.retireOffered && current.entry.offered) {
            if (await remove(id)) counts.retired++
            return
          }
          kept.push({ id, updatedAtMs: current.entry.updatedAtMs })
        })
      }
      kept.sort((a, b) => a.updatedAtMs - b.updatedAtMs)
      let total = kept.length + [...live].filter((id) => entryIds.includes(id)).length
      for (const victim of kept) {
        if (total <= limits.maxEntries) break
        if (await lane(victim.id, () => remove(victim.id))) {
          counts.evicted++
          total--
        }
      }
      return counts
    }
  }
}
