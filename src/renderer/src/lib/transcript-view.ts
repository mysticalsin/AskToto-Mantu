/**
 * transcript-view.ts — the reading rules for the live transcript.
 *
 * The live transcript was a 240px slot with every line stamped by its speaker and a scroller that
 * jumped to the bottom on every arriving line. Three things were wrong with that, and all three are
 * about reading rather than styling:
 *
 *   1. 240px is roughly four lines of speech. During a call the transcript is the thing you actually
 *      read, and it was the smallest surface on screen.
 *   2. Re-reading something was impossible: scroll up, and the next arriving line yanked you back to
 *      the bottom. A transcript you cannot scroll back through is a transcript you cannot check.
 *   3. Every single line repeated its speaker label, so a person saying three sentences read as three
 *      strangers. Conversation is grouped by speaker; the transcript should be too.
 *
 * Pure functions so each rule is testable without mounting a scroller or faking a display.
 */
import type { TranscriptLine } from '@shared/ipc'

/** Floor for very short displays — below this the transcript stops being readable at all. */
const TRANSCRIPT_MIN_PX = 360
/** Room left for the copilot card, suggestion strip, notices and the bar chrome above/below. */
const TRANSCRIPT_CHROME_PX = 120
/** Share of the display the transcript may claim. Main clamps the window to workArea - 48 regardless,
 *  so this asks for a generous height and lets the existing ceiling be the authority. */
const TRANSCRIPT_DISPLAY_SHARE = 0.62

/**
 * Height cap for the transcript scroller, derived from the DISPLAY rather than the viewport.
 *
 * Same contract as Bar's answerBodyMaxHeight and for the same reason: `vh` in a self-sizing overlay is
 * circular — the window resizes to its content, so a height expressed as a fraction of the window feeds
 * its own input. The display's availHeight is a fixed outside measurement.
 */
export function transcriptMaxHeight(
  availHeight: number | undefined = typeof window !== 'undefined' ? window.screen?.availHeight : undefined
): number {
  if (!availHeight || !Number.isFinite(availHeight)) return TRANSCRIPT_MIN_PX
  return Math.max(TRANSCRIPT_MIN_PX, Math.round(availHeight * TRANSCRIPT_DISPLAY_SHARE) - TRANSCRIPT_CHROME_PX)
}

/** How far from the bottom still counts as "following along" — about one line of slack. */
export const STICK_SLACK_PX = 48

/**
 * True when the reader is at (or within a line of) the bottom, which is the ONLY case where an arriving
 * line may scroll the view. Anywhere else the reader is looking at something deliberately and moving
 * them is the bug.
 */
export function isFollowingTail(el: { scrollTop: number; scrollHeight: number; clientHeight: number }): boolean {
  return el.scrollHeight - (el.scrollTop + el.clientHeight) <= STICK_SLACK_PX
}

export interface TranscriptRowModel {
  line: TranscriptLine
  /** Index into the ORIGINAL lines array, so keys stay stable across a truncated render window. */
  index: number
  /** First line of a run by the same speaker: only these carry a name and the extra top spacing. */
  startsGroup: boolean
  /** Last line of the run, so only the final bubble in a group gets the flattened tail corner. */
  endsGroup: boolean
}

/**
 * Group consecutive lines by speaker IDENTITY, not just side. Two different named people are two groups
 * even though both are 'them', which is the whole point of Speaker Intelligence resolving names: a
 * meeting where three colleagues speak should not read as one undifferentiated "them".
 */
export function groupTranscriptRows(lines: TranscriptLine[]): TranscriptRowModel[] {
  const identity = (l: TranscriptLine): string => `${l.speaker}\u0000${l.name?.trim() ?? ''}`
  return lines.map((line, i) => {
    const prev = i > 0 ? lines[i - 1] : undefined
    const next = i + 1 < lines.length ? lines[i + 1] : undefined
    return {
      line,
      index: i,
      startsGroup: !prev || identity(prev) !== identity(line),
      endsGroup: !next || identity(next) !== identity(line)
    }
  })
}

/**
 * Elapsed time as mm:ss from the session's first line. Absolute wall-clock is the wrong unit here: what
 * a reader wants is "how far into the call was this", and that is what a recap or a follow-up refers to.
 * Returns null when the stamps cannot produce a sane offset, so the UI omits it rather than printing
 * a negative or NaN time.
 */
export function transcriptElapsed(t: number | undefined, firstT: number | undefined): string | null {
  if (!Number.isFinite(t) || !Number.isFinite(firstT)) return null
  const ms = (t as number) - (firstT as number)
  if (!Number.isFinite(ms) || ms < 0) return null
  const total = Math.floor(ms / 1000)
  const mm = Math.floor(total / 60)
  const ss = total % 60
  return `${mm}:${String(ss).padStart(2, '0')}`
}

/** Plural-safe label for the jump-to-latest pill. */
export function newLinesLabel(count: number): string {
  return count === 1 ? '1 new line' : `${count} new lines`
}
