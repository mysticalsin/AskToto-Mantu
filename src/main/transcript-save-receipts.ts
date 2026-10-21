import type { Settings } from '@shared/ipc'
import type {
  ReceiptJournalPort,
  SaveReceiptRecord,
  SaveReceiptStage
} from './infra/storage/transcript-receipt-journal'

export type TranscriptSaveSideEffect = SaveReceiptStage

export interface TranscriptSaveReceipt {
  /** Stored once, so legacy invalid timestamps reuse the same normalized identity on retry. */
  normalizedStartedAt?: number
  /** Captured with the first attempt; cleanup and ingestion retry against the original save context. */
  settings?: Settings
  durablePath?: string
  deferredIngest?: boolean
  /** Background work launched by the receipt; meeting discard joins it before deleting the file. */
  backgroundWork?: Promise<void>
  /** Set by Disregard before joining saves; active stage runners stop before starting another effect. */
  discardRequested?: boolean
  /** A confirmed user discard tombstones this exact receipt so a stale retry cannot recreate it. */
  discarded?: boolean
  readonly completed: Set<TranscriptSaveSideEffect>
}

export interface DurableTranscriptReceiptPath {
  path: string
  settings: Settings
}

interface ReceiptEntry {
  receipt: TranscriptSaveReceipt
  pending?: Promise<string>
  ownerKey?: string
  touched: number
  journalId?: string
  journalLocation?: NonNullable<ReturnType<ReceiptLocator>>
  journalForgotten?: boolean
}

/** Where a durable save lives, P1 only. Null when the path cannot be named safely, so the receipt is not journaled. */
export type ReceiptLocator = (
  durablePath: string,
  settings: Settings,
  meetingStartedAt: number
) => { savedBasename: string; folderIdSha256: string; revision: number } | null

export interface ReceiptJournalOptions {
  journal: ReceiptJournalPort
  locate: ReceiptLocator
  newId(): string
  now?(): number
  onError?(error: unknown): void
}

/** A receipt whose durable fields report every change, so the save handler persists them without knowing it. */
function observedReceipt(changed: () => void): TranscriptSaveReceipt {
  class ObservedStages extends Set<TranscriptSaveSideEffect> {
    override add(stage: TranscriptSaveSideEffect): this {
      const had = this.has(stage)
      super.add(stage)
      if (!had) changed()
      return this
    }
  }
  const receipt = { completed: new ObservedStages() } as TranscriptSaveReceipt
  // The durable path, and the first attempt's ingest policy that retries must keep.
  for (const field of ['durablePath', 'deferredIngest'] as const) {
    let value: unknown
    Object.defineProperty(receipt, field, {
      enumerable: true,
      get: () => value,
      set: (next: unknown) => {
        const changedValue = next !== value
        value = next
        if (changedValue) changed()
      }
    })
  }
  return receipt
}

/**
 * Main-process idempotency receipts for final transcript saves. Settled entries may be evicted at the
 * fixed capacity; pending work is never evicted. If every slot is pending, new unique saves fail closed.
 */
export class TranscriptSaveReceiptStore {
  readonly #entries = new Map<string, ReceiptEntry>()
  readonly #discardedMeetings = new Map<string, number>()
  readonly #sealedMeetings = new Set<string>()
  #clock = 0
  readonly #journal: ReceiptJournalOptions | undefined
  /** Latest unwritten record (or removal) per journal id; one writer drains them in order. */
  readonly #journalQueue = new Map<string, SaveReceiptRecord | null>()
  /** Construction failures have no queued record yet; the first barrier must observe them before retry. */
  readonly #failedConstructions = new Map<
    ReceiptEntry,
    { key: string; failure: { error: unknown }; observed: boolean }
  >()
  #journalDrain: Promise<{ error: unknown } | undefined> = Promise.resolve(undefined)
  #journalDraining = false

  constructor(
    private readonly maxEntries = 256,
    journal?: ReceiptJournalOptions
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error('Invalid transcript receipt limit')
    this.#journal = journal
  }

  /** Resolves after persistence, or rejects with this drain's failure even if another caller retries it. */
  async journalIdle(): Promise<void> {
    let constructionFailure: { error: unknown } | undefined
    for (const [entry, pending] of [...this.#failedConstructions]) {
      if (this.#failedConstructions.get(entry) !== pending) continue
      if (!pending.observed) {
        pending.observed = true
        constructionFailure ??= pending.failure
      } else {
        this.#failedConstructions.delete(entry)
        const failure = this.journalChanged(pending.key, entry, true)
        constructionFailure ??= failure
      }
    }
    this.drainJournal()
    // Capture the construction outcome before a logger-scheduled caller can recover it.
    if (constructionFailure) throw constructionFailure.error
    const result = await this.#journalDrain
    if (result) throw result.error
  }

  run(
    key: string,
    owner: { startedAt: number; authGeneration: number } | undefined,
    work: (receipt: TranscriptSaveReceipt) => Promise<string>
  ): Promise<string> {
    const ownerKey = owner ? this.meetingKey(owner.startedAt, owner.authGeneration) : undefined
    if (ownerKey && (this.#sealedMeetings.has(ownerKey) || this.#discardedMeetings.has(ownerKey))) {
      return Promise.reject(new Error('This meeting is being discarded.'))
    }
    let entry = this.#entries.get(key)
    if (!entry) {
      this.makeRoom()
      const created: ReceiptEntry = { receipt: { completed: new Set() }, ownerKey, touched: ++this.#clock }
      if (this.#journal) created.receipt = observedReceipt(() => this.journalChanged(key, created))
      entry = created
      this.#entries.set(key, entry)
    } else if (ownerKey) {
      entry.ownerKey ??= ownerKey
      if (entry.ownerKey !== ownerKey) return Promise.reject(new Error('Transcript receipt owner does not match.'))
    }
    entry.touched = ++this.#clock
    if (entry.pending) return entry.pending

    const current = entry
    let pending!: Promise<string>
    pending = Promise.resolve()
      .then(async () => {
        await this.journalIdle()
        const path = await work(current.receipt)
        await this.journalIdle()
        return path
      })
      .then(
        (path) => {
          if (current.pending === pending) current.pending = undefined
          current.touched = ++this.#clock
          return path
        },
        (error: unknown) => {
          if (current.pending === pending) current.pending = undefined
          current.touched = ++this.#clock
          // Before durability there is nothing to resume; let a later request retry the write.
          if (!current.receipt.durablePath && this.#entries.get(key) === current) this.#entries.delete(key)
          throw error
        }
      )
    current.pending = pending
    return pending
  }

  durablePathsForMeeting(startedAt: number, authGeneration: number): DurableTranscriptReceiptPath[] {
    const prefix = `${authGeneration}:`
    const paths = new Map<string, DurableTranscriptReceiptPath>()
    for (const [key, entry] of this.#entries) {
      const { receipt } = entry
      if (
        !key.startsWith(prefix) ||
        receipt.normalizedStartedAt !== startedAt ||
        receipt.discarded ||
        !receipt.durablePath ||
        !receipt.settings
      )
        continue
      paths.set(receipt.durablePath, { path: receipt.durablePath, settings: receipt.settings })
    }
    return [...paths.values()]
  }

  /** Close admission synchronously, then join every save and receipt-owned background operation. */
  async sealMeetingAndJoin(startedAt: number, authGeneration: number): Promise<void> {
    const ownerKey = this.meetingKey(startedAt, authGeneration)
    this.#sealedMeetings.add(ownerKey)
    for (const entry of this.#entries.values()) {
      if (entry.ownerKey === ownerKey) entry.receipt.discardRequested = true
    }
    while (true) {
      const entries = [...this.#entries.values()].filter((entry) => entry.ownerKey === ownerKey)
      const pending = entries.flatMap((entry) => (entry.pending ? [entry.pending] : []))
      if (pending.length) {
        await Promise.all(
          pending.map((operation) =>
            operation.then(
              () => undefined,
              () => undefined
            )
          )
        )
        continue
      }
      const background = entries.flatMap((entry) =>
        entry.receipt.backgroundWork ? [entry.receipt.backgroundWork] : []
      )
      if (background.length)
        await Promise.all(
          background.map((operation) =>
            operation.then(
              () => undefined,
              () => undefined
            )
          )
        )
      // The seal prevents a new matching receipt from appearing after the final snapshot.
      return
    }
  }

  releaseMeetingSeal(startedAt: number, authGeneration: number): void {
    const ownerKey = this.meetingKey(startedAt, authGeneration)
    this.#sealedMeetings.delete(ownerKey)
    if (!this.#discardedMeetings.has(ownerKey)) {
      for (const entry of this.#entries.values()) {
        if (entry.ownerKey === ownerKey) entry.receipt.discardRequested = false
      }
    }
  }

  markDurablePathDiscarded(path: string, authGeneration: number): void {
    const prefix = `${authGeneration}:`
    for (const [key, entry] of this.#entries) {
      if (key.startsWith(prefix) && entry.receipt.durablePath === path) {
        entry.receipt.discarded = true
        this.journalForget(entry)
      }
    }
  }

  markMeetingDiscarded(startedAt: number, authGeneration: number): void {
    const owner = this.meetingKey(startedAt, authGeneration)
    this.#discardedMeetings.delete(owner)
    this.#discardedMeetings.set(owner, ++this.#clock)
    for (const entry of this.#entries.values()) if (entry.ownerKey === owner) this.journalForget(entry)
    while (this.#discardedMeetings.size > this.maxEntries) {
      const oldest = this.#discardedMeetings.keys().next().value
      if (oldest === undefined) break
      this.#discardedMeetings.delete(oldest)
    }
  }

  isMeetingDiscarded(startedAt: number, authGeneration: number): boolean {
    const owner = this.meetingKey(startedAt, authGeneration)
    return this.#sealedMeetings.has(owner) || this.#discardedMeetings.has(owner)
  }

  private meetingKey(startedAt: number, authGeneration: number): string {
    return `${authGeneration}:${startedAt}`
  }

  /** A durable receipt's state changed: queue its record, or its removal once every stage completed. */
  private journalChanged(key: string, entry: ReceiptEntry, retry = false): { error: unknown } | undefined {
    const journal = this.#journal
    const { receipt } = entry
    if (!journal || entry.journalForgotten) return
    if (receipt.discarded || receipt.completed.has('complete')) {
      this.journalForget(entry)
      return
    }
    if (receipt.durablePath === undefined || !receipt.settings || this.#failedConstructions.has(entry)) return
    const separator = key.indexOf(':')
    const authGeneration = Number(key.slice(0, separator))
    const meetingStartedAt = receipt.normalizedStartedAt
    if (meetingStartedAt === undefined || !Number.isSafeInteger(authGeneration)) return
    try {
      if (!entry.journalLocation) {
        const located = journal.locate(receipt.durablePath, receipt.settings, meetingStartedAt)
        if (!located) return
        entry.journalLocation = { ...located }
      }
      const where = entry.journalLocation
      entry.journalId ??= journal.newId()
      const completed = [...receipt.completed]
      const has = (stage: TranscriptSaveSideEffect): boolean => receipt.completed.has(stage)
      this.journalEnqueue(entry.journalId, {
        receiptId: entry.journalId,
        ownerKey: this.meetingKey(meetingStartedAt, authGeneration),
        authGeneration,
        meetingStartedAt,
        payloadSha256: key.slice(separator + 1),
        revision: where.revision,
        stages: {
          draftSealed: has('draft-cleanup'),
          savedWritten: true,
          brainIngestQueued: has('ingest'),
          draftsUnlinked: has('draft-cleanup'),
          receiptsDeleted: false
        },
        completed,
        ...(receipt.deferredIngest !== undefined ? { deferredIngest: receipt.deferredIngest } : {}),
        savedBasename: where.savedBasename,
        folderIdSha256: where.folderIdSha256,
        updatedAt: Math.max(0, Math.trunc(journal.now?.() ?? Date.now()))
      })
    } catch (error) {
      const failure = { error }
      this.#failedConstructions.set(entry, { key, failure, observed: retry })
      try {
        journal.onError?.(error)
      } catch {
        // Logging must not replace even a falsy construction error or abandon its retry.
      }
      return failure
    }
  }

  private journalForget(entry: ReceiptEntry): void {
    entry.journalForgotten = true
    this.#failedConstructions.delete(entry)
    if (entry.journalId === undefined) return
    this.journalEnqueue(entry.journalId, null)
  }

  private journalEnqueue(id: string, record: SaveReceiptRecord | null): void {
    if (!this.#journal) return
    this.#journalQueue.set(id, record)
    this.drainJournal()
  }

  private drainJournal(): void {
    const journal = this.#journal
    if (!journal || this.#journalDraining || this.#journalQueue.size === 0) return
    this.#journalDraining = true
    this.#journalDrain = this.#journalDrain.then(async () => {
      try {
        while (this.#journalQueue.size > 0) {
          const [next, value] = this.#journalQueue.entries().next().value as [string, SaveReceiptRecord | null]
          this.#journalQueue.delete(next)
          try {
            await (value === null ? journal.journal.remove(next) : journal.journal.put(value))
          } catch (error) {
            // Retain the latest state for a retry, without replaying its already-completed effect.
            if (!this.#journalQueue.has(next)) this.#journalQueue.set(next, value)
            try {
              journal.onError?.(error)
            } catch {
              // A logging failure must not lose the retry or replace the persistence error.
            }
            return { error }
          }
        }
      } finally {
        this.#journalDraining = false
      }
      return undefined
    })
  }

  private makeRoom(): void {
    while (this.#entries.size >= this.maxEntries) {
      let oldestKey: string | undefined
      let oldestTouched = Number.POSITIVE_INFINITY
      for (const [key, entry] of this.#entries) {
        // Keep durable-but-incomplete receipts (for example, an ingest rejection) so a retry can
        // resume the missing work instead of creating another transcript or repeating credits.
        if (
          !entry.pending &&
          (!entry.ownerKey || !this.#sealedMeetings.has(entry.ownerKey)) &&
          (entry.receipt.discarded || entry.receipt.completed.has('complete')) &&
          entry.touched < oldestTouched
        ) {
          oldestKey = key
          oldestTouched = entry.touched
        }
      }
      if (oldestKey === undefined) throw new Error('Transcript save receipt capacity is occupied by unfinished saves')
      this.#entries.delete(oldestKey)
    }
  }
}
