import type { Settings } from '@shared/ipc'

export type TranscriptSaveSideEffect =
  | 'summary-credit'
  | 'time-saved-credit'
  | 'draft-cleanup'
  | 'audit'
  | 'rebuild'
  | 'ingest'
  | 'speaker-save'
  | 'complete'

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

  constructor(private readonly maxEntries = 256) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error('Invalid transcript receipt limit')
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
      entry = { receipt: { completed: new Set() }, ownerKey, touched: ++this.#clock }
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
      .then(() => work(current.receipt))
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
      ) continue
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
      const pending = entries.flatMap((entry) => entry.pending ? [entry.pending] : [])
      if (pending.length) {
        await Promise.all(pending.map((operation) => operation.then(() => undefined, () => undefined)))
        continue
      }
      const background = entries.flatMap((entry) => entry.receipt.backgroundWork ? [entry.receipt.backgroundWork] : [])
      if (background.length) await Promise.all(background.map((operation) => operation.then(() => undefined, () => undefined)))
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
      if (key.startsWith(prefix) && entry.receipt.durablePath === path) entry.receipt.discarded = true
    }
  }

  markMeetingDiscarded(startedAt: number, authGeneration: number): void {
    const owner = this.meetingKey(startedAt, authGeneration)
    this.#discardedMeetings.delete(owner)
    this.#discardedMeetings.set(owner, ++this.#clock)
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
