/**
 * Métis 2.0 Cap 2 — wake word + end-phrase detection (pure).
 * Spoken "Hey Métis" starts a command session; bare "Métis" alone does NOT.
 * Meeting Listen alone must NOT execute.
 */
export type MetisCommandPhase =
  | 'idle'
  | 'waking'
  | 'listening'
  | 'executing'
  | 'deactivating'

/** Product wake phrase (Ultron HARD). ASR folds accents/case. */
export const METIS_WAKE_WORD = 'Hey Métis'
export const METIS_PILL_HI = 'Hi Métis'
export const METIS_PILL_LISTENING = "Hi Métis, I'm listening..."

/** Fold accents / case for wake matching without losing user-facing copy. */
export function foldSpeech(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Require greeting + name — bare "Métis" must not arm Cap2 (Tony / Ultron HARD). */
/** hey|hi — Apple/Parakeet often fold "Hey" → "Hi". Bare Métis still fails. */
const WAKE_RE = /\b(hey|hi)\s+metis\b/
const END_RE =
  /\b(thank you|thanks metis|thanks|that'll be all|that will be all|stop listening)\b/

export function transcriptContainsWakeWord(text: string): boolean {
  return WAKE_RE.test(foldSpeech(text))
}

export function transcriptContainsEndPhrase(text: string): boolean {
  return END_RE.test(foldSpeech(text))
}

/** Strip the wake phrase so command parsing starts after the name call. */
export function stripWakeWord(text: string): string {
  const folded = foldSpeech(text)
  const m = folded.match(WAKE_RE)
  if (!m || m.index === undefined) return text.trim()
  const before = folded.slice(0, m.index).trim()
  const after = folded.slice(m.index + m[0].length).trim()
  return [before, after].filter(Boolean).join(' ')
}
