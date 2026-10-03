import type { TranscriptLine } from '@shared/ipc'
import type { JournalAck, JournalDoc, JournalEntry } from '@shared/contracts/journal'

/**
 * When the journal writes. Transcript finals are batched: the first final after a write starts a
 * FINALS_BATCH_MS window and every final committed in it lands in one record, so a final waits at most
 * FINALS_BATCH_MS for its fsync. Recap and note revisions are full snapshots debounced per document: each
 * revision restarts its REVISION_DEBOUNCE_MS timer and only the newest text is written when it fires.
 * Every write goes through the sink, which resolves only once the records are fsynced (INV-ACK in store.ts).
 */

export const FINALS_BATCH_MS = 2000
export const REVISION_DEBOUNCE_MS = 500

export type JournalSink = (entries: JournalEntry[]) => Promise<JournalAck>

export type JournalCadenceOptions = {
  onAck: (ack: JournalAck) => void
  onError: (error: unknown) => void
}

export interface JournalCadence {
  /** Queues a committed transcript line; provisional captions are ignored. */
  final(line: TranscriptLine): void
  /** Records the newest full text of a document. */
  revise(doc: JournalDoc, text: string): void
  /** Writes everything pending now, in one append, and resolves once it is acknowledged or has failed. */
  flush(): Promise<void>
}

export function createJournalCadence(sink: JournalSink, options: JournalCadenceOptions): JournalCadence {
  let finals: TranscriptLine[] = []
  let finalsTimer: ReturnType<typeof setTimeout> | null = null
  const revisions = new Map<JournalDoc, { text: string; timer: ReturnType<typeof setTimeout> }>()

  function write(entries: JournalEntry[]): Promise<void> {
    return sink(entries).then(options.onAck, options.onError)
  }

  function takeFinals(): JournalEntry[] {
    if (finalsTimer) clearTimeout(finalsTimer)
    finalsTimer = null
    const lines = finals
    finals = []
    return lines.length > 0 ? [{ kind: 'finals', lines }] : []
  }

  function takeRevision(doc: JournalDoc): JournalEntry[] {
    const pending = revisions.get(doc)
    if (!pending) return []
    clearTimeout(pending.timer)
    revisions.delete(doc)
    return [{ kind: 'revision', doc, text: pending.text }]
  }

  return {
    final(line) {
      if (line.provisional) return
      finals.push(line)
      finalsTimer ??= setTimeout(() => void write(takeFinals()), FINALS_BATCH_MS)
    },
    revise(doc, text) {
      const pending = revisions.get(doc)
      if (pending) clearTimeout(pending.timer)
      revisions.set(doc, { text, timer: setTimeout(() => void write(takeRevision(doc)), REVISION_DEBOUNCE_MS) })
    },
    flush() {
      const entries = [...takeFinals(), ...[...revisions.keys()].flatMap(takeRevision)]
      return entries.length > 0 ? write(entries) : Promise.resolve()
    }
  }
}
