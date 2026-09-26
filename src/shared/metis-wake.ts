/**
 * Métis 2.0 Cap 2 — wake word + end-phrase detection (pure).
 * Spoken "Métis" starts a command session; meeting Listen alone must NOT execute.
 */
export type MetisCommandPhase =
  | 'idle'
  | 'waking'
  | 'listening'
  | 'executing'
  | 'deactivating'

export const METIS_WAKE_WORD = 'Métis'
export const METIS_PILL_HI = 'Hi Métis'
export const METIS_PILL_LISTENING = "Hi Métis, I'm listening..."

/** One character's contribution to the folded/matching text. Shared by foldSpeech and
 * wakeWordSourceSpan so accent/case/width folding can never drift between the detector
 * and the stripper: a copy that changes in only one place is exactly how they'd disagree
 * on what counts as a wake word.
 */
function foldCharacter(character: string): string {
  return character
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
}

/** Fold accents / case for wake matching without losing user-facing copy. */
export function foldSpeech(text: string): string {
  let folded = ''
  for (const character of text) folded += foldCharacter(character)
  return folded.replace(/\s+/g, ' ').trim()
}

const WAKE_RE = /\bmetis\b/
const END_RE =
  /\b(thank you|thanks metis|thanks|that'll be all|that will be all|stop listening)\b/

export function transcriptContainsWakeWord(text: string): boolean {
  return WAKE_RE.test(foldSpeech(text))
}

export function transcriptContainsEndPhrase(text: string): boolean {
  return END_RE.test(foldSpeech(text))
}

/** Locate the folded wake token without using the folded text as the command payload.
 * Offsets refer to the original UTF-16 string: compatibility characters may expand,
 * and combining marks may disappear during matching. Neither is a license to rewrite
 * the user's note, URL, name, punctuation, or casing.
 */
function wakeWordSourceSpan(text: string): { start: number; end: number } | null {
  let folded = ''
  const starts: number[] = []
  const ends: number[] = []
  let offset = 0
  for (const character of text) {
    const end = offset + character.length
    const part = foldCharacter(character)
    // A decomposed accent following the final letter belongs to that source span.
    if (!part && ends.length > 0) ends[ends.length - 1] = end
    for (let i = 0; i < part.length; i++) {
      starts.push(offset)
      ends.push(end)
    }
    folded += part
    offset = end
  }
  // Collapsing/stripping whitespace is unnecessary for a single-token match and
  // would discard the offsets. WAKE_RE is intentionally shared with the detector.
  const match = WAKE_RE.exec(folded)
  if (!match) return null
  return { start: starts[match.index], end: ends[match.index + match[0].length - 1] }
}

/** Remove the first wake token; preserve the remaining source text verbatim apart
 * from the surrounding whitespace needed to join the two sides of the name call.
 * Use foldSpeech for keyword matching only, never for persisted/action arguments.
 */
export function stripWakeWord(text: string): string {
  const span = wakeWordSourceSpan(text)
  if (!span) return text.trim()
  const before = text.slice(0, span.start).trim()
  const after = text.slice(span.end).trim()
  return [before, after].filter(Boolean).join(' ')
}
