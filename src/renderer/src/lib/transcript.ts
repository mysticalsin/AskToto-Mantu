import type { TranscriptLine } from '@shared/ipc'
import type { RecapStatus } from '@shared/recap-status'

// Shared by the live recap path (listen.ts's text()) and the saved-meeting recap path (App.tsx's
// generateSavedRecap, fed either an import's returned lines or a reopened past meeting's lines) — one
// joiner so recap prompts retain the same established speaker names and channel labels whether the
// lines came from a live meeting or a saved one. Channel-only labels remain the unnamed fallback.
//
// Mixed-language meetings: when the tagged language changes between lines (see TranscriptLine.lang,
// tagged conservatively by commitLine), a "[conversation switches to …]" marker line is emitted so the
// LLM knows a real language switch happened — without it, a Portuguese call with an English segment
// reads like transcription noise and the recap's "respond in the main language" directive has nothing
// to anchor on. Untagged lines (detection not confident, older saved meetings) never emit markers.
export function transcriptToText(lines: TranscriptLine[]): string {
  const out: string[] = []
  let prevLang: string | undefined
  for (const l of lines) {
    // ASR quality (1B.2b) — a provisional line is a UI-only "…" placeholder for a window still being
    // transcribed (see shared/ipc.ts's TranscriptLineSchema.provisional). It must never reach the recap
    // prompt or a saved transcript — real text for the SAME speech replaces it once decode settles.
    if (l.provisional) continue
    if (l.lang && prevLang && l.lang !== prevLang) out.push(`[conversation switches to ${l.lang}]`)
    if (l.lang) prevLang = l.lang
    // Names may come from a Teams display name. Keep the label on one line, without dropping the
    // identity that distinguishes two remote participants' commitments (MQA-307).
    const name = l.name?.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()
    const channel = l.speaker === 'them' ? 'THEM' : l.speaker === 'you' ? 'YOU' : 'SPEAKER'
    const label = name ? (l.speaker === 'unknown' ? name : `${channel} (${name})`) : channel
    out.push(`${label}: ${l.text}`)
  }
  return out.join('\n')
}

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
