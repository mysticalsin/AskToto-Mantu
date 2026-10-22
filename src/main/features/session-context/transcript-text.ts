import type { LedgerUtterance } from '@shared/kernel/transcript-ledger'
import type { ContextSnapshot } from '@shared/kernel/session-context'
import type { TranscriptLine } from '@shared/transcript-line'
import { transcriptToText } from '@shared/transcript-text'
import { LAST_THEM_SLOT, TRANSCRIPT_SLOT } from '@shared/session-context-request'

/**
 * Renders the usable transcript of a SessionContext snapshot as prompt text through the same joiner the renderer used
 * (`transcriptToText`, now shared): `THEM (Alice): ...` with the speaker name when one is known, and the
 * `[conversation switches to ...]` marker when the tagged language changes. Only finals reach a snapshot's
 * `segments`; interim text never does. Pure: no I/O, no settings, no redaction (the caller redacts).
 */
type Segment = LedgerUtterance & { name?: string; lang?: string }

const finalsOf = (snapshot: ContextSnapshot): readonly Segment[] =>
  snapshot.transcript.segments as unknown as readonly Segment[]

const lineOf = (segment: Segment): TranscriptLine => ({
  speaker: segment.speakerId === 'THEM' ? 'them' : segment.speakerId === 'YOU' ? 'you' : 'unknown',
  text: segment.text,
  t: segment.startMs,
  ...(segment.name ? { name: segment.name } : {}),
  ...(segment.lang ? { lang: segment.lang } : {})
})

/** The last `maxChars` of the transcript, cut after the labels and language markers are in, as before. */
export function transcriptTailText(snapshot: ContextSnapshot, maxChars: number): string {
  return transcriptToText(finalsOf(snapshot).map(lineOf)).slice(-maxChars)
}

/** The most recent line the other side spoke (the fact-check claim), at most `maxChars` from its end. */
export function lastThemText(snapshot: ContextSnapshot, maxChars: number): string {
  const segments = finalsOf(snapshot)
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]
    if (segment?.speakerId === 'THEM' && segment.text.trim()) return segment.text.slice(-maxChars)
  }
  return ''
}

/** Replaces every slot token in one pass. The inserted text is never scanned again, so it cannot name a slot. */
export function fillSlots(prompt: string, values: { transcript: string; lastThem: string }): string {
  if (!prompt.includes(TRANSCRIPT_SLOT) && !prompt.includes(LAST_THEM_SLOT)) return prompt
  return prompt
    .split(TRANSCRIPT_SLOT)
    .map((part) => part.split(LAST_THEM_SLOT).join(values.lastThem))
    .join(values.transcript)
}
