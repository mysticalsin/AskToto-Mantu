import type { TranscriptLine } from '@shared/transcript-line'

/**
 * The renderer's write seam toward main, called once from `commitLine` for each committed line.
 *
 * A final cloud segment (the line carries the provider's `speech` event) is journaled in v1: main sees that segment
 * itself and feeds its own transcript ledger from it, so only the speaker name and language the renderer tagged are
 * sent for it (a label by utterance id). Every other final line (on-device engines, the legacy cloud path) is
 * forwarded to the ledger with its text, name and language, because main never sees the committed text; the periodic
 * draft stays the durable copy. Provisional lines go nowhere.
 *
 * Capture must never wait on, fail because of, or learn anything from either write: the call is not awaited, a
 * rejection (including a missing bridge) is swallowed, and nothing here touches UI state. Main proves the sender owns
 * the meeting; the renderer only names it.
 */
type Labels = { name?: string; lang?: string }
const labelsOf = (line: TranscriptLine): Labels => ({
  ...(line.name ? { name: line.name } : {}),
  ...(line.lang ? { lang: line.lang } : {})
})

function sendToLedger(payload: Parameters<Window['toto']['appendSessionLedgerLine']>[0]): void {
  try {
    void Promise.resolve(window.toto.appendSessionLedgerLine(payload)).catch(() => undefined)
  } catch {
    // A missing or throwing bridge never reaches the capture path.
  }
}

/** A name or language for a line already committed (a voiceprint name that resolved later, or a tag at commit). */
export function labelCommittedLine(startedAt: number | undefined, line: TranscriptLine): void {
  const labels = labelsOf(line)
  if (startedAt === undefined || line.provisional === true || (!labels.name && !labels.lang)) return
  if (line.utteranceId !== undefined)
    sendToLedger({ op: 'label-segment', startedAt, utteranceId: line.utteranceId, ...labels })
  else if (line.speech === undefined) sendToLedger({ op: 'label-local', startedAt, t: line.t, ...labels })
}

export function journalCommittedLine(startedAt: number | undefined, line: TranscriptLine): void {
  if (startedAt === undefined || line.provisional === true) return
  if (line.speech === undefined) {
    sendToLedger({ op: 'final', startedAt, t: line.t, speaker: line.speaker, text: line.text, ...labelsOf(line) })
    return
  }
  if (line.speech.type !== 'segment' || line.speech.segment.final !== true) return
  try {
    void Promise.resolve(window.toto.appendMeetingJournal({ startedAt, line })).catch(() => undefined)
  } catch {
    // A missing or throwing bridge never reaches the capture path.
  }
  labelCommittedLine(startedAt, line)
}

/** A committed line the renderer later dropped (operator echo through loopback): main retracts it from the ledger. */
export function retractCommittedLine(startedAt: number | undefined, t: number): void {
  if (startedAt !== undefined) sendToLedger({ op: 'retract', startedAt, t })
}
