/**
 * Act 2 (Demo) — the scripted fake meeting that plays through Métis's REAL Bar/Copilot/Answer
 * components (see components/OnboardingDemoScene.tsx), replacing the old static mock card (MQA-277).
 * Per the Vibe-Island teardown's boxed pattern ("drive the real UI with fake data... never a video"),
 * this module is the "fake data" half: a pure, DOM-free projection of one meeting's worth of scripted
 * beats onto a single `elapsedMs` clock, in the same spirit as lib/scramble.ts's `scrambleFrame` — the
 * logic that actually matters lives here and is fully unit-tested; the component only measures pixels
 * and drives a rAF/timeout clock over it (a bug there is a wiring bug, not a logic bug).
 *
 * SAFETY (MQA-278): this module has NO dependency on the IPC bridge, the renderer's shared state module,
 * or the live listen engine — it cannot read a real transcript, a real session, or any other real app
 * state, and it cannot call a real save/ingest IPC. Its only inputs are the constants below and a plain
 * number (elapsed milliseconds); its only output is inert data (strings/booleans) for the demo scene to
 * render. That is what makes "a real in-progress meeting can never leak into the demo" true by
 * construction rather than by a runtime check — there is simply no code path here through which real
 * data could arrive. A contract test (onboarding-demo.mqa277.test.ts) pins this by asserting the source
 * never references those symbols, so a future edit that tries to wire real state in fails a test
 * instead of silently opening the hole.
 */

export type DemoSpeaker = 'them' | 'you'

export interface DemoLine {
  speaker: DemoSpeaker
  text: string
  /** Elapsed-ms offset at which this line lands. */
  at: number
}

export const DEMO_LINES: readonly DemoLine[] = [
  { speaker: 'them', text: 'Quick gut-check before we move on — where did we land on the renewal timeline?', at: 200 },
  { speaker: 'you', text: 'Let me pull that up.', at: 1900 },
  { speaker: 'them', text: "Wasn't the security review supposed to take three weeks?", at: 7100 }
]

export const DEMO_SUGGESTION_TEXT =
  '**Say this:** "We agreed to renew by the 15th, contingent on the security review closing this week — ' +
  'and that review is on track, nothing\u2019s blocking it."\n\n' +
  "- Lead with the date so it can't slip in the notes.\n" +
  "- Confirm the review's status before you commit to it out loud."

/** The user-facing claim/question header for the fact-check beat — never the engineered prompt. */
export const DEMO_FACTCHECK_LABEL = '"The review takes three weeks"'

export const DEMO_FACTCHECK_TEXT =
  'VERDICT: MISLEADING\n' +
  "- Last call's notes scoped the review to five business days, not three weeks.\n" +
  '- Worth correcting now, before it becomes the story everyone repeats.'

export const DEMO_RECAP_HEADLINE = 'Renewal on track for the 15th.'

export const DEMO_RECAP_ITEMS: readonly string[] = [
  'Security review closes this week — confirmed live, on the call.',
  'Corrected the "three weeks" claim before it became the record.',
  'Send the renewal date in writing today.'
]

/** Named milestones (elapsed ms since the demo mounted). Kept as one object, in play order, so the
 *  timeline reads top-to-bottom like a shot list and every downstream consumer (the projector below,
 *  the reduced-motion stepper in the component) shares the exact same numbers. */
export const DEMO_TIMING = {
  line1: DEMO_LINES[0].at,
  line2: DEMO_LINES[1].at,
  // The synthetic cursor starts gliding toward "What to say next" once there's something to react to.
  cursorToSuggestionStart: 3100,
  cursorToSuggestionArrive: 3900,
  suggestionTextStart: 3950,
  suggestionTextEnd: 5750,
  line3: DEMO_LINES[2].at,
  cursorToFactcheckStart: 8300,
  cursorToFactcheckArrive: 9000,
  factcheckTextStart: 9050,
  factcheckTextEnd: 10600,
  recapStart: 11800,
  end: 13400
} as const

/** How long a synthetic click's ripple stays visible, from the moment the cursor arrives. */
export const DEMO_CLICK_FLASH_MS = 420

export type DemoStage = 'lines' | 'suggestion' | 'factcheck' | 'recap'

export type DemoCursorTarget = 'none' | 'suggestion' | 'factcheck'

export interface DemoCursorState {
  target: DemoCursorTarget
  /** 0 (at rest / start point) .. 1 (arrived at the target). Monotonic within a stage. */
  progress: number
  /** True for DEMO_CLICK_FLASH_MS right after arrival — the moment of the (synthetic) click. */
  pressed: boolean
}

export interface DemoStreamState {
  text: string
  streaming: boolean
}

export interface DemoFrame {
  elapsedMs: number
  stage: DemoStage
  /** Transcript lines committed so far, in order. */
  lines: DemoLine[]
  /** Non-null once the suggestion beat has started; null before and after (factcheck/recap replace it). */
  suggestion: DemoStreamState | null
  /** Non-null once the fact-check beat has started. */
  factcheck: DemoStreamState | null
  cursor: DemoCursorState
  /** True once the recap stage has started — the component swaps the live Bar/Copilot area for the
   *  recap card, mirroring how a real meeting's chrome disappears once Review takes over. */
  meetingEnded: boolean
  /** True once the whole script has finished playing (recap has had time to be read). */
  done: boolean
}

function clamp01(n: number): number {
  return n <= 0 ? 0 : n >= 1 ? 1 : n
}

/** Linear progress of `elapsed` between `start` and `end`, clamped to [0, 1]. An instant boundary
 *  (`end <= start`) is treated as "already arrived" the moment `elapsed` reaches `start`. */
function progressBetween(elapsed: number, start: number, end: number): number {
  if (end <= start) return elapsed >= start ? 1 : 0
  return clamp01((elapsed - start) / (end - start))
}

/** Truncates `full` to the fraction implied by `progress` — the same "reveal as it streams" shape a
 *  real token-by-token answer has, without needing a token list. Whole characters only (no NaN/negative
 *  slicing), and always exactly `full` once progress reaches 1 so the final frame is never off-by-one. */
function sliceByProgress(full: string, progress: number): string {
  if (progress >= 1) return full
  if (progress <= 0) return ''
  return full.slice(0, Math.round(full.length * progress))
}

/**
 * The pure per-frame projection: given elapsed milliseconds since the demo started, returns everything
 * the scene needs to render. Calling this twice with the same `elapsedMs` always returns the same shape
 * (aside from fresh array/object identity) — no hidden clock, no randomness, no external state.
 */
export function demoFrameAt(elapsedMs: number): DemoFrame {
  const t = DEMO_TIMING
  const lines = DEMO_LINES.filter((l) => elapsedMs >= l.at)

  let stage: DemoStage = 'lines'
  if (elapsedMs >= t.recapStart) stage = 'recap'
  else if (elapsedMs >= t.cursorToFactcheckStart) stage = 'factcheck'
  else if (elapsedMs >= t.cursorToSuggestionStart) stage = 'suggestion'

  const suggestion: DemoStreamState | null =
    elapsedMs >= t.suggestionTextStart
      ? {
          text: sliceByProgress(DEMO_SUGGESTION_TEXT, progressBetween(elapsedMs, t.suggestionTextStart, t.suggestionTextEnd)),
          streaming: elapsedMs < t.suggestionTextEnd
        }
      : null

  const factcheck: DemoStreamState | null =
    elapsedMs >= t.factcheckTextStart
      ? {
          text: sliceByProgress(DEMO_FACTCHECK_TEXT, progressBetween(elapsedMs, t.factcheckTextStart, t.factcheckTextEnd)),
          streaming: elapsedMs < t.factcheckTextEnd
        }
      : null

  let cursor: DemoCursorState = { target: 'none', progress: 0, pressed: false }
  if (stage === 'suggestion') {
    const progress = progressBetween(elapsedMs, t.cursorToSuggestionStart, t.cursorToSuggestionArrive)
    cursor = {
      target: 'suggestion',
      progress,
      pressed: elapsedMs >= t.cursorToSuggestionArrive && elapsedMs < t.cursorToSuggestionArrive + DEMO_CLICK_FLASH_MS
    }
  } else if (stage === 'factcheck') {
    const progress = progressBetween(elapsedMs, t.cursorToFactcheckStart, t.cursorToFactcheckArrive)
    cursor = {
      target: 'factcheck',
      progress,
      pressed: elapsedMs >= t.cursorToFactcheckArrive && elapsedMs < t.cursorToFactcheckArrive + DEMO_CLICK_FLASH_MS
    }
  }

  return {
    elapsedMs,
    stage,
    lines,
    // The suggestion card stays mounted through the factcheck beat too (Copilot keeps showing it behind
    // the fact-check answer's own surface in the real app) — but once recap starts, both clear.
    suggestion: stage === 'recap' ? null : suggestion,
    factcheck: stage === 'recap' ? null : factcheck,
    cursor,
    meetingEnded: stage === 'recap',
    done: elapsedMs >= t.end
  }
}

/** Ordered stage-boundary milestones, exported for the reduced-motion stepper (component) — stepping
 *  straight to each of these (instead of interpolating continuously) shows the same beats in the same
 *  order with no glide/streaming motion, matching Act 1's reduced-motion rule ("a static resolved state,
 *  never stuck mid-animation"). */
export const DEMO_STAGE_BOUNDARIES: readonly number[] = [
  DEMO_TIMING.line1,
  DEMO_TIMING.line2,
  DEMO_TIMING.suggestionTextEnd,
  DEMO_TIMING.line3,
  DEMO_TIMING.factcheckTextEnd,
  DEMO_TIMING.recapStart,
  DEMO_TIMING.end
]

/** Act 2 recap for the chosen role. Sales / recruiting / meeting (and the other six) are different layouts. */
export function demoRecapMarkdown(mode: string): string {
  switch (mode) {
    case 'sales':
      return `## Deal snapshot
Q3 renewal. On track for the 15th if security review closes this week.

## Buying signals
They asked for the date in writing. No budget pushback.

## Objections
"The review takes three weeks." Corrected live: five business days.

## What the seller must know
Renewal date is the 15th. Review is on track. Nothing blocking.

## Next steps
- Send the renewal date in writing today (you)
- Confirm security review close (them)

## Stakeholders
Their AE, their security lead.`
    case 'recruiting':
      return `## Candidate
Alex, mid-level consultant. Clear on the stack, thin on ownership.

## Background
CS 2019. Current role: implementation. Open because the work flattened.

## Motivations
Wants client-facing delivery, not ticket queues. not covered: target sector.

## Projects
Renault, 8 months: cut cutover defects. They owned the test plan. SAP + Jira.

## Compensation and contract
Current 62k. Expected "around 70". Permanent.

## Availability
3 month notice. Real: will hear a counter.

## Ratings
Technical B (named the stack, no deep design). Functional B. Personality A. Dynamism C (needed a second ask for numbers).

## Strengths and concerns
Strength: concrete Renault example. Concern: "we" more than "I".`
    case 'meeting':
      return `## Outcome
Renewal stays on the 15th. Security review is five days, not three weeks.

## Decisions
Keep the 15th date. Review closes this week.

## Action items
- Send the date in writing today (you)
- Confirm review close (them)

## Open questions
None on the date. Review owner on their side not named.

## Key numbers
15th. Five business days.`
    case 'interview':
      return `## Role
Implementation consultant, client-facing.

## Questions and answers
"Where did we land on timeline?" You restated the 15th and the five-day review.

## Examples given
Last call scoped the review to five business days.

## Next rounds
Send the date in writing today.`
    case 'negotiation':
      return `## Positions
They: review takes three weeks. You: five business days, date holds.

## Interests
They want slack. You want the 15th in the notes.

## Concessions
None. The three-week claim was corrected, not traded.

## Agreed terms
Renew by the 15th, contingent on this week's review.

## Still open
Written confirmation of the date.`
    case 'presentation':
      return `## What landed
The 15th date, once restated.

## Audience questions
"Wasn't the security review supposed to take three weeks?"

## Confusion or pushback
The three-week figure. Corrected from last call's notes.

## Follow-ups promised
Send the renewal date in writing today.`
    case 'support':
      return `## Reported problem
Security review timeline is wrong in their head (three weeks).

## Steps tried
Checked last call's notes: five business days.

## Resolution
Corrected live. Date holds.

## Follow-ups
Write the date today.`
    case 'cold-call':
      return `## How the call went
Reached the buyer. Opener was a gut-check on the renewal date.

## Objections
Three-week review. Met with last call's five-day scope.

## Qualifying facts
Renewal still targeted at the 15th.

## Commitment
They want the date in writing today.`
    default:
      return `## Title
Q3 renewal lock

## Tags
renewal, security, timeline

## Overview
Renewal stays on the 15th. The three-week review claim was wrong.

## Topics
- Gut-check on the renewal date
- Security review length
- Correction from last call

## Key Q&A
Q: Three weeks? A: Five business days. On track.

## Decisions
Keep the 15th.

## Action items
- Send the date in writing today

## Open questions
None.

## Notable quotes
"Wasn't the security review supposed to take three weeks?"`
  }
}
