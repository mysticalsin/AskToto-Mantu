import type { TranscriptLine } from './transcript-line'

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
    const name = l.name
      ?.replace(/[\x00-\x1f\x7f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    const channel = l.speaker === 'them' ? 'THEM' : l.speaker === 'you' ? 'YOU' : 'SPEAKER'
    const label = name ? (l.speaker === 'unknown' ? name : `${channel} (${name})`) : channel
    out.push(`${label}: ${l.text}`)
  }
  return out.join('\n')
}
