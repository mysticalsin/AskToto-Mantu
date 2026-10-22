import type { TranscriptLine } from '@shared/ipc'
import type { RecapStatus } from '@shared/recap-status'

// The joiner moved to src/shared so main builds the same labelled text from its own ledger (G13).
export { transcriptToText } from '@shared/transcript-text'

export interface RecapPersistTarget {
  /** Meeting start id for a live recap, or the saved filename for a past-meeting generation. */
  ownerId: string
  runId: string
  file: string | null
  /** Text already known to belong to this exact target. Used only when a retry returns no new text. */
  priorText: string
}

export interface RecapPersistAction {
  ownerId: string
  runId: string
  file: string | null
  text: string
  recapStatus: RecapStatus
}

/**
 * Convert one terminal recap answer into an owned persistence action. Completion is never inferred from
 * length or the absence of an error: only the hook's explicit terminal outcome can produce a write, and
 * only a non-empty explicit completion is `complete`. A failed/hollow retry keeps the baseline captured
 * from this exact target, so useful partial notes survive without borrowing carried text from another run.
 */
export function recapPersistAction(
  answer: {
    id: string
    text: string
    streaming: boolean
    error: string | null
    completion?: 'pending' | 'complete' | 'incomplete'
  } | null,
  target: RecapPersistTarget | null,
  currentOwnerId: string
): RecapPersistAction | null {
  if (!target || !answer) return null
  if (target.ownerId !== currentOwnerId || target.runId !== answer.id) return null
  if (answer.streaming || answer.completion === 'pending' || !answer.completion) return null

  const hasCurrentText = !!answer.text.trim()
  const recapStatus: RecapStatus =
    answer.completion === 'complete' && hasCurrentText && !answer.error ? 'complete' : 'incomplete'
  return {
    ownerId: target.ownerId,
    runId: target.runId,
    file: target.file,
    text: hasCurrentText ? answer.text : target.priorText,
    recapStatus
  }
}
