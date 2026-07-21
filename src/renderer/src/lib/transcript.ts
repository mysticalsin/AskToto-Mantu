import type { TranscriptLine } from '@shared/ipc'

// Shared by the live recap path (listen.ts's text()) and the saved-meeting recap path (App.tsx's
// generateSavedRecap, fed either an import's returned lines or a reopened past meeting's lines) — one
// joiner so the recap prompt always sees the identical THEM/YOU transcript format no matter which lines
// array it was built from.
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
    if (l.lang && prevLang && l.lang !== prevLang) out.push(`[conversation switches to ${l.lang}]`)
    if (l.lang) prevLang = l.lang
    out.push(`${l.speaker === 'them' ? 'THEM' : l.speaker === 'you' ? 'YOU' : 'SPEAKER'}: ${l.text}`)
  }
  return out.join('\n')
}

// Persist-on-settle decision for the App-level recap generator (recapGen): returns the {file, text} to
// write via recallUpdateRecap only once a run has fully SETTLED with a real, non-empty summary — i.e. not
// streaming, no error, and non-empty text. A null target (no generation in flight), a still-streaming
// answer, an errored settle, or a null answer all resolve to null so the caller knows there is nothing to
// persist yet (the caller still clears recapGenTarget on an errored settle; it just doesn't write here).
export function recapPersistAction(
  answer: { text: string; streaming: boolean; error: string | null } | null,
  target: { file: string } | null
): { file: string; text: string } | null {
  if (!target || !answer) return null
  if (answer.streaming || answer.error || !answer.text) return null
  return { file: target.file, text: answer.text }
}
