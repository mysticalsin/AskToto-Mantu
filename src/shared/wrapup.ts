import type { TranscriptLine } from './ipc'

/**
 * No-Decision Honk (innovation #5) — detect, live, that the meeting is wrapping up with no decision
 * and no owned next step, so the copilot can nudge ONCE with a "force the ask" line while there is
 * still someone on the call to ask.
 *
 * Deliberately heuristic and biased toward silence: a false honk (nagging when a next step was in fact
 * agreed) costs trust, a missed honk costs nothing new. So the ownership check scans the WHOLE meeting
 * (any owned step anywhere disarms it), the wrap-up check needs an explicit ending phrase in the last
 * few lines, and short meetings never honk at all. Pure functions on the transcript — `now` injected.
 */

const MIN_MEETING_MS = 10 * 60 * 1000 // sub-10-minute calls end abruptly all the time; never honk
const ENDING_WINDOW_LINES = 8 // an ending phrase only counts when the meeting is actually ending

// Explicit ending language. Word-ish boundaries via regex; case-insensitive.
const ENDING_CUES: RegExp[] = [
  /\blet'?s wrap\b/i,
  /\bwrap(ping)? (this |it )?up\b/i,
  /\b(gotta|got to|have to|need to) (run|jump|drop|hop off)\b/i,
  /\bwe'?re (at|out of) time\b/i,
  /\brunning (out of|low on) time\b/i,
  /\btop of the hour\b/i,
  /\blet'?s call it\b/i,
  /\bthanks?,? (everyone|everybody|all|guys|both of you)\b/i,
  /\bthanks? (so much )?for (your|the) time\b/i,
  /\b(great|good|nice|lovely) (talking|chatting|catching up|to see you|seeing you)\b/i,
  /\bhave a (good|great|nice) (one|day|evening|weekend|week)\b/i,
  /\btalk (to you )?(soon|later|next week)\b/i,
  /\bsee you (next|then|soon|tomorrow)\b/i,
  /\b(bye|goodbye|take care|cheers)\b[.!]?\s*$/i
]

// Owned-next-step language: someone claimed an action, or a concrete gate was set. Any one of these
// anywhere in the meeting disarms the honk.
const OWNED_STEP_CUES: RegExp[] = [
  /\bi('| wi)ll (send|share|get|set up|schedule|book|draft|prepare|put together|circulate|follow up|circle back|intro|introduce|forward|email|ping|get back)\b/i,
  /\bwe('| wi)ll (send|share|get|set up|schedule|book|draft|prepare|put together|circulate|follow up|get back)\b/i,
  /\byou('| wi)ll (have|get|receive|hear from)\b/i,
  /\blet me (send|share|set up|schedule|book|draft|put together|follow up|get back)\b/i,
  /\bi('| wi)ll take (that|this|it|the action)\b/i,
  /\b(action item|next step)s?\b.{0,40}\b(is|are|:)/i,
  /\bby (monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|end of (day|week|month)|eod|eow|eom)\b/i,
  /\b(we|it'?s) (agreed|decided|settled)\b/i,
  /\blet'?s (schedule|book|set up|put) (a|the|some)?\s?(call|meeting|time|session|demo|workshop)\b/i,
  /\bi'?ll send (over|you|the|a)\b/i,
  /\b(calendar|invite) (invite|out|coming|on its way)\b/i,
  /\bpencil(ed)? in\b/i
]

export interface HonkVerdict {
  honk: boolean
  /** The ending phrase that tripped the detector (for the nudge copy / debugging). */
  cue?: string
}

/** Does any recent line contain an explicit ending phrase? Returns the matched line text. */
function endingCue(lines: TranscriptLine[]): string | undefined {
  const recent = lines.slice(-ENDING_WINDOW_LINES)
  for (let i = recent.length - 1; i >= 0; i--) {
    const text = recent[i].text
    if (ENDING_CUES.some((re) => re.test(text))) return text
  }
  return undefined
}

/** Did anyone, at any point, own a concrete next step or set a hard gate? */
export function hasOwnedNextStep(lines: TranscriptLine[]): boolean {
  return lines.some((l) => OWNED_STEP_CUES.some((re) => re.test(l.text)))
}

/**
 * Should the copilot honk right now? Callers latch the result — one honk per meeting, ever.
 * `startedAt`/`now` are injected epoch ms (pure & testable).
 */
export function detectNoDecisionEnding(lines: TranscriptLine[], startedAt: number, now: number): HonkVerdict {
  if (!startedAt || now - startedAt < MIN_MEETING_MS) return { honk: false }
  if (lines.length < 10) return { honk: false } // barely any conversation — nothing to force
  const cue = endingCue(lines)
  if (!cue) return { honk: false }
  if (hasOwnedNextStep(lines)) return { honk: false }
  return { honk: true, cue }
}
