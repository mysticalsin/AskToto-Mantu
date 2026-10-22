import type { TranscriptLine } from '@shared/transcript-line'

/**
 * The renderer's write seam toward main, called once from `commitLine` for each committed line.
 *
 * A final cloud segment (the line carries the provider's `speech` event) is journaled in v1: main sees that segment
 * itself and feeds its own transcript ledger from it. Every other final line (on-device engines, the legacy cloud
 * path) is forwarded to the ledger instead, because main never sees the committed text; the periodic draft stays
 * the durable copy. Provisional lines go nowhere.
 *
 * Capture must never wait on, fail because of, or learn anything from either write: the call is not awaited, a
 * rejection (including a missing bridge) is swallowed, and nothing here touches UI state. Main proves the sender owns
 * the meeting; the renderer only names it.
 */
export function journalCommittedLine(startedAt: number | undefined, line: TranscriptLine): void {
  if (startedAt === undefined || line.provisional === true) return
  try {
    if (line.speech === undefined) {
      void Promise.resolve(
        window.toto.appendSessionLedgerLine({
          op: 'final',
          startedAt,
          t: line.t,
          speaker: line.speaker,
          text: line.text
        })
      ).catch(() => undefined)
      return
    }
    if (line.speech.type !== 'segment' || line.speech.segment.final !== true) return
    void Promise.resolve(window.toto.appendMeetingJournal({ startedAt, line })).catch(() => undefined)
  } catch {
    // A missing or throwing bridge never reaches the capture path.
  }
}

/** A committed line the renderer later dropped (operator echo through loopback): main retracts it from the ledger. */
export function retractCommittedLine(startedAt: number | undefined, t: number): void {
  if (startedAt === undefined) return
  try {
    void Promise.resolve(window.toto.appendSessionLedgerLine({ op: 'retract', startedAt, t })).catch(() => undefined)
  } catch {
    // never reaches the capture path
  }
}
