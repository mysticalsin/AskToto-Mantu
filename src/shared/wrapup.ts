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
  // "let's wrap" alone is a sign-off ("let's wrap for today"), but not when what follows is "up"
  // (that shape is the next cue's job) or a direct object ("let's wrap the pricing section" — a topic
  // transition, not the meeting ending).
  /\blet'?s wrap\b(?!\s+(?:up\b|the|this|that|those|these|our|my|your|his|her|their|its|a|an)\b)/i,
  // "wrap (this/it) up" is the sign-off shape; "wrap up the/this/... <noun>" right after is a topic
  // transition ("let's wrap up the pricing section and move to timelines"), not the meeting ending.
  /\bwrap(ping)? (this |it )?up\b(?!\s+(?:the|this|that|those|these|our|my|your|his|her|their|its|a|an)\b)/i,
  /\b(gotta|got to|have to|need to) (run|jump|drop|hop off)\b/i,
  /\bwe'?re (at|out of) time\b/i,
  /\brunning (out of|low on) time\b/i,
  /\btop of the hour\b/i,
  /\blet'?s call it\b/i,
  /\bthanks?,? (everyone|everybody|all|guys|both of you)\b/i,
  // "thanks for your time" as a sign-off vs. mid-meeting ("...explaining the architecture, now onto
  // pricing") — a following gerund clause means the "time" was spent on something, not a closing line.
  /\bthanks? (so much )?for (your|the) time\b(?!\s+\w+ing\b)/i,
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
  /\bpencil(ed)? in\b/i,
  // Named third-party ownership ("Sarah will handle the follow-up", "Marc is going to send the
  // numbers") — the cues above only recognize first-person (I/we) or second-person (you) commitments.
  // Case-SENSITIVE and deliberately conservative: a real name reads as capitalized wherever it sits in
  // the sentence, while a capitalized common word/pronoun only looks that way at a sentence's start
  // ("It will improve...") — the exclusion list below blocks the common ones from posing as a name.
  /\b(?!It\b|We\b|They\b|This\b|That\b|He\b|She\b|You\b|There\b|Here\b|The\b|Let\b|I\b|So\b|And\b|But\b|Ok\b|Okay\b|Well\b|Maybe\b|Also\b|Then\b|Now\b|Someone\b|Everyone\b|Something\b|Everything\b|Yes\b|No\b)[A-Z][a-z]+(?:'ll| will| is going to) (?:send|share|get|set up|schedule|book|draft|prepare|put together|circulate|follow up|circle back|intro|introduce|forward|email|ping|handle|take (?:that|this|it|the action)|own|work on|look into|reach out|call|review|update|finalize|close|sort out|deal with|get back)\b/
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
