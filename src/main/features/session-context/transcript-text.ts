import type { LedgerUtterance } from '@shared/kernel/transcript-ledger'
import type { ContextSnapshot } from '@shared/kernel/session-context'
import { LAST_THEM_SLOT, TRANSCRIPT_SLOT } from '@shared/session-context-request'

/**
 * Renders the usable transcript of a SessionContext snapshot as prompt text, in the speaker-labelled shape the
 * renderer's `transcriptToText` produced (`THEM: ...` / `YOU: ...`, one line per final). Only finals reach a
 * snapshot's `segments`; interim text never does. Pure: no I/O, no settings, no redaction (the caller redacts).
 */
const labelOf = (speakerId: string): string => (speakerId === 'THEM' ? 'THEM' : speakerId === 'YOU' ? 'YOU' : 'SPEAKER')

const finalsOf = (snapshot: ContextSnapshot): readonly LedgerUtterance[] =>
  snapshot.transcript.segments as unknown as readonly LedgerUtterance[]

/** The last `maxChars` of the transcript. Walks backwards so a long meeting never builds its whole text. */
export function transcriptTailText(snapshot: ContextSnapshot, maxChars: number): string {
  const segments = finalsOf(snapshot)
  const lines: string[] = []
  let size = 0
  for (let index = segments.length - 1; index >= 0 && size < maxChars; index -= 1) {
    const segment = segments[index]
    if (!segment) continue
    const line = `${labelOf(segment.speakerId)}: ${segment.text}`
    lines.push(line)
    size += line.length + 1
  }
  return lines.reverse().join('\n').slice(-maxChars)
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
