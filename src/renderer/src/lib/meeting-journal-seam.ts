import type { TranscriptLine } from '@shared/transcript-line'

/**
 * The renderer's write seam into the live meeting journal. Called once from `commitLine` for each committed line:
 * only a final cloud segment (the line carries the provider's `speech` event) is journaled in v1; local-engine and
 * provisional lines are not, and the periodic draft stays their durable copy.
 *
 * Capture must never wait on, fail because of, or learn anything from the journal: the call is not awaited, a
 * rejection (including a missing bridge) is swallowed, and nothing here touches UI state. Main proves the sender owns
 * the meeting; the renderer only names it.
 */
export function journalCommittedLine(startedAt: number | undefined, line: TranscriptLine): void {
  if (startedAt === undefined || line.provisional === true) return
  if (line.speech?.type !== 'segment' || line.speech.segment.final !== true) return
  try {
    void Promise.resolve(window.toto.appendMeetingJournal({ startedAt, line })).catch(() => undefined)
  } catch {
    // A missing or throwing bridge never reaches the capture path.
  }
}
