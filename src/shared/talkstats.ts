import type { TranscriptLine } from './ipc'

/**
 * Talk-time stats — the single most-quoted meeting metric (Gong's "talk ratio"), computed here from
 * data competitors don't have: per-line speaker labels with timestamps from the live dual-channel
 * capture. Pure function over the transcript; every number is a count over real lines.
 *
 * youShare is a WORD share, not a wall-clock share: line timestamps mark starts, not durations, so
 * words spoken is the honest proxy (and robust to silence between lines). The monologue read uses
 * the timestamps for what they CAN prove — the span from a run's first line to the line that ends it.
 */

export interface TalkStats {
  /** Your share of all words spoken, 0..1. Null when nobody said anything. */
  youShare: number | null
  youWords: number
  themWords: number
  /** Longest unbroken run of YOUR lines, in seconds (first line of the run → the line after it). */
  longestMonologueSec: number
  /** Questions the other side asked (their lines ending in, or containing, a question mark). */
  themQuestions: number
}

const words = (text: string): number => (text.trim() ? text.trim().split(/\s+/).length : 0)

export function talkStats(lines: TranscriptLine[]): TalkStats {
  let youWords = 0
  let themWords = 0
  let themQuestions = 0
  let longestMonologueSec = 0
  let runStart: number | null = null // t of the first line in the current 'you' run

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (l.speaker === 'you') {
      youWords += words(l.text)
      runStart ??= l.t
      // A run's span ends at the NEXT line's start (them speaking) or, at transcript end, its own last line.
      const next = lines[i + 1]
      const end = next ? next.t : l.t
      if (runStart !== null) longestMonologueSec = Math.max(longestMonologueSec, Math.round((end - runStart) / 1000))
    } else if (l.speaker === 'them') {
      themWords += words(l.text)
      if (l.text.includes('?')) themQuestions++
      runStart = null
    } else {
      // Imported recordings are not diarized. Excluding unknown speakers keeps live talk-ratio metrics
      // honest rather than treating unidentified speech as the other participant.
      runStart = null
    }
  }

  const total = youWords + themWords
  return {
    youShare: total === 0 ? null : youWords / total,
    youWords,
    themWords,
    longestMonologueSec,
    themQuestions
  }
}
