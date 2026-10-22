/**
 * The dictation memory (G26): the encrypted segment journal, the owned-span ledger and the personal dictionary,
 * composed behind one object that the dictation session feeds and the IPC surface reads.
 *
 * What the session calls (the sink, all synchronous and never throwing, because a journal must never slow or fail a
 * dictation):
 *   segmentRecognized  main recognized a segment: it is journaled before any insertion is attempted;
 *   draftPreserved     the guard kept a draft that was not verified (the G07 `onDraftPreserved` sink);
 *   inserted           the text was verified into a field: the journal entry is deleted and the text is held, in
 *                      memory only, for the twenty second correction window;
 *   turnEnded          the turn is over in this process: an entry that survived may now be offered.
 *
 * What the person can do (the IPC surface):
 *   take the recoverable drafts once (a typed notice; `autoInsert` is false, a recovered draft is only shown);
 *   resolve one (optionally after correcting it); correct a recently dictated span; list, remove or clear the
 *   dictionary. The dictionary learns only through the owned-span path: the original is always main's own copy.
 *
 * Audit records carry a phase, an optional enum reason and counts. Never text, a term, a path or an id.
 */
import type {
  DictationMemoryAck,
  DictationRecoveryNotice,
  DictationRecoveryResolve,
  DictationSpanCorrect,
  DictationSpans,
  DictionaryList,
  DictionaryRemove
} from '@shared/dictation-memory'
import { join } from 'node:path'
import type { PriorDraft } from '../desktop-contract'
import { createDictationDictionary, type DictationDictionary } from './dictation-dictionary'
import { createDictationJournal, type DictationJournal, type JournalOutcome } from './dictation-journal'
import { createMemoryKeyring, type DictationKeyCustody } from './dictation-memory-crypto'
import { createOwnedSpanLedger, type OwnedSpan } from './dictation-owned-span'

export type DictationMemoryAuditPhase =
  | 'journal_refused'
  | 'journal_swept'
  | 'recovery_offered'
  | 'recovery_resolved'
  | 'dictionary_learned'
  | 'dictionary_removed'
  | 'dictionary_cleared'

/** Counts and enums only. */
export interface DictationMemoryAuditRecord {
  phase: DictationMemoryAuditPhase
  count: number
  reason?: string
  expired?: number
  evicted?: number
  retired?: number
  unreadable?: number
  temp?: number
}

/** What a dictation session reports. Every call is synchronous, contained and fire-and-forget. */
export interface DictationMemorySink {
  segmentRecognized(turnId: string, text: string): void
  draftPreserved(turnId: string, draft: PriorDraft): void
  inserted(turnId: string, text: string): void
  turnEnded(turnId: string): void
}

export interface DictationMemoryDeps {
  /** `<userData>/dictation-memory`: holds `key.v1`, `journal/` and `dictionary/`. Never the meetings folder. */
  rootDir(): string
  keys: DictationKeyCustody
  /**
   * The opaque partition of the verified person, on every use (typed seam: G19's memory partition API replaces the
   * wiring's derivation when it lands). Records of another partition are never offered, read or changed.
   */
  partition(): string
  /** Whether dictation may record right now (signed in). Deleting and reading the dictionary never need it. */
  enabled(): boolean
  now(): number
  newId?(): string
  audit?(record: DictationMemoryAuditRecord): void
}

export interface DictationMemory {
  readonly sink: DictationMemorySink
  /** Launch housekeeping: retention, temp and unreadable files, and retiring drafts that were offered and ignored. */
  launch(): Promise<void>
  recoveryTake(): Promise<DictationRecoveryNotice | null>
  recoveryResolve(input: DictationRecoveryResolve): Promise<DictationMemoryAck>
  spansRecent(): DictationSpans
  spansCorrect(input: DictationSpanCorrect): Promise<DictationMemoryAck>
  dictionaryList(): Promise<DictionaryList>
  dictionaryRemove(input: DictionaryRemove): Promise<DictationMemoryAck>
  dictionaryClear(): Promise<DictationMemoryAck>
  /** The owner signed out or changed: the correction window of the previous person is forgotten. */
  onOwnerRevoked(): void
  /** Resolves when every journal write started so far has landed. Never rejects. */
  flush(): Promise<void>
  /** Flushes, then zeroes the key. */
  dispose(): Promise<void>
}

const REFUSED: DictationMemoryAck = { ok: false, count: 0 }

export function createDictationMemory(deps: DictationMemoryDeps): DictationMemory {
  const keyring = createMemoryKeyring({ keyPath: join(deps.rootDir(), 'key.v1'), keys: deps.keys })
  const journal: DictationJournal = createDictationJournal({
    rootDir: () => join(deps.rootDir(), 'journal'),
    keyring,
    partition: deps.partition,
    enabled: deps.enabled,
    now: deps.now
  })
  const dictionary: DictationDictionary = createDictationDictionary({
    rootDir: () => join(deps.rootDir(), 'dictionary'),
    keyring,
    partition: deps.partition,
    now: deps.now,
    newId: deps.newId
  })
  const ledger = createOwnedSpanLedger({ now: deps.now, newId: deps.newId })
  const pending = new Set<Promise<unknown>>()
  const refusals = new Map<string, number>()

  const audit = (record: DictationMemoryAuditRecord): void => {
    try {
      deps.audit?.(record)
    } catch {
      /* audit is best effort */
    }
  }

  /** Runs a journal write in the background: tracked for `flush`, never rejecting, refusals counted. */
  function background(work: () => Promise<JournalOutcome | void>): void {
    // Started synchronously, so the journal's bookkeeping (a live turn) is in place before the next sink call.
    let started: Promise<JournalOutcome | void>
    try {
      started = Promise.resolve(work())
    } catch {
      started = Promise.resolve()
    }
    const tracked: Promise<unknown> = started
      .then(
        (outcome) => {
          if (
            outcome &&
            outcome.status === 'refused' &&
            outcome.reason !== 'DISABLED' &&
            outcome.reason !== 'INVALID'
          ) {
            const reason = outcome.reason.toLowerCase()
            const seen = (refusals.get(reason) ?? 0) + 1
            refusals.set(reason, seen)
            // The first refusal of a kind is audited, then every tenth power: a stuck store is loud once, not per word.
            if (/^10*$/.test(String(seen))) audit({ phase: 'journal_refused', reason, count: seen })
          }
        },
        () => undefined
      )
      .finally(() => {
        pending.delete(tracked)
      })
    pending.add(tracked)
  }

  const learn = async (span: OwnedSpan, correctedText: string): Promise<number> => {
    const { learned } = await dictionary.learnFromCorrection(span, correctedText)
    if (learned > 0) audit({ phase: 'dictionary_learned', count: learned })
    return learned
  }

  const flush = async (): Promise<void> => {
    while (pending.size > 0) await Promise.allSettled([...pending])
  }

  const sink: DictationMemorySink = {
    segmentRecognized(turnId, text) {
      try {
        background(() => journal.appendSegment(turnId, text))
      } catch {
        /* never reaches the dictation */
      }
    },
    draftPreserved(turnId, draft) {
      try {
        background(() => journal.preserveDraft(turnId, draft))
      } catch {
        /* never reaches the dictation */
      }
    },
    inserted(turnId, text) {
      try {
        if (deps.enabled()) ledger.mint(text)
        background(() => journal.complete(turnId))
      } catch {
        /* never reaches the dictation */
      }
    },
    turnEnded(turnId) {
      try {
        journal.endTurn(turnId)
      } catch {
        /* never reaches the dictation */
      }
    }
  }

  return {
    sink,

    async launch() {
      const counts = await journal.sweep({ retireOffered: true })
      const count = counts.expired + counts.evicted + counts.retired + counts.unreadable + counts.temp
      if (count > 0) audit({ phase: 'journal_swept', count, ...counts })
    },

    async recoveryTake() {
      const items = await journal.take()
      if (items.length === 0) return null
      audit({ phase: 'recovery_offered', count: items.length })
      return { v: 1, kind: 'dictation-recovery', autoInsert: false, items }
    },

    async recoveryResolve(input) {
      const resolved = await journal.resolve(input.id)
      if (resolved.status !== 'resolved') return REFUSED
      audit({ phase: 'recovery_resolved', count: 1 })
      const learned = input.correctedText === undefined ? 0 : await learn(resolved.span, input.correctedText)
      return { ok: true, count: learned }
    },

    spansRecent() {
      return { spans: ledger.recent() }
    },

    async spansCorrect(input) {
      const span = ledger.claim(input.id)
      if (!span) return REFUSED
      return { ok: true, count: await learn(span, input.correctedText) }
    },

    dictionaryList: () => dictionary.list(),

    async dictionaryRemove(input) {
      const removed = await dictionary.remove(input.id)
      if (!removed) return REFUSED
      audit({ phase: 'dictionary_removed', count: 1 })
      return { ok: true, count: 1 }
    },

    async dictionaryClear() {
      const count = await dictionary.clear()
      audit({ phase: 'dictionary_cleared', count })
      return { ok: true, count }
    },

    onOwnerRevoked() {
      ledger.clear()
    },

    flush,

    async dispose() {
      ledger.clear()
      await flush()
      keyring.dispose()
    }
  }
}
