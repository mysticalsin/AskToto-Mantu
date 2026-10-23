import { z } from 'zod'
import {
  WALKTHROUGH_STEP_BUDGET,
  type WalkthroughPauseReason,
  type WalkthroughStopReason
} from '@shared/walkthrough-view'

/**
 * Walkthrough model (G44, CAP-25): the plan a walkthrough follows and the observation it is checked against.
 *
 * A step's success is a typed predicate over a structured observation of the screen (an element, a window or a
 * state flag), never free text read off the screen. What the screen says is compared against what the plan
 * expects and nothing else: it cannot become an instruction, a step or a decision (G36, R124).
 *
 * ASSUMED: the structured observation comes from the accessibility helper (G38) or a user-triggered snapshot (G46)
 * through the `observe` seam. Until one is bound the seam answers "unavailable" and no step is ever verified.
 */

const short = (max: number) => z.string().min(1).max(max)

export type WalkthroughPredicate =
  | { kind: 'window'; app?: string; titleContains?: string }
  | { kind: 'element'; role: string; name?: string; state?: string; present?: boolean }
  | { kind: 'state'; key: string; equals: string | boolean }
  | { kind: 'all'; of: WalkthroughPredicate[] }

const LeafPredicateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('window'), app: short(120).optional(), titleContains: short(120).optional() }).strict(),
  z
    .object({
      kind: z.literal('element'),
      role: short(48),
      name: short(120).optional(),
      state: short(48).optional(),
      present: z.boolean().optional()
    })
    .strict(),
  z.object({ kind: z.literal('state'), key: short(64), equals: z.union([short(120), z.boolean()]) }).strict()
])
export const WalkthroughPredicateSchema = z.union([
  LeafPredicateSchema,
  z.object({ kind: z.literal('all'), of: z.array(LeafPredicateSchema).min(1).max(6) }).strict()
]) as z.ZodType<WalkthroughPredicate>

export const WalkthroughStepSchema = z
  .object({
    /** Written by Métis for the owner. Never copied from the screen. */
    instruction: short(200),
    /** Where the owner should be to do this step. Checked on resume. */
    precondition: WalkthroughPredicateSchema.optional(),
    postcondition: WalkthroughPredicateSchema
  })
  .strict()
export type WalkthroughStep = z.infer<typeof WalkthroughStepSchema>

export const WalkthroughPlanSchema = z
  .object({
    /** The app the walkthrough happens in. Leaving it for long pauses the walkthrough. */
    app: short(120).optional(),
    // More than the budget is accepted and cut at the budget: the engine stops honestly at step 15.
    steps: z.array(WalkthroughStepSchema).max(60)
  })
  .strict()
export type WalkthroughPlan = z.infer<typeof WalkthroughPlanSchema>

export interface WalkthroughObservation {
  /** The G16 revocation epoch and capture order of this observation. */
  generation: number
  sequence: number
  capturedAt: number
  frontApp?: string
  windowTitle?: string
  elements: ReadonlyArray<{ role: string; name?: string; state?: string }>
  flags?: Readonly<Record<string, string | boolean>>
}

export interface ObservationWatermark {
  generation: number
  sequence: number
}

/** The typed seam for "observe the current state" (G46 snapshots, G38 accessibility). */
export interface WalkthroughObserver {
  /** Identity of the newest observation issued so far. Steps are verified only by a later one. */
  watermark(): ObservationWatermark
  /** One fresh observation, or null when the screen cannot be looked at. Rejects count as null. */
  observe(signal: AbortSignal): Promise<WalkthroughObservation | null>
}

const same = (a: string | undefined, b: string): boolean => a !== undefined && a.toLowerCase() === b.toLowerCase()

export function evaluatePredicate(p: WalkthroughPredicate, obs: WalkthroughObservation): boolean {
  switch (p.kind) {
    case 'window':
      return (
        (p.app === undefined || same(obs.frontApp, p.app)) &&
        (p.titleContains === undefined || (obs.windowTitle ?? '').toLowerCase().includes(p.titleContains.toLowerCase()))
      )
    case 'element': {
      const found = obs.elements.some(
        (e) =>
          e.role === p.role &&
          (p.name === undefined || same(e.name, p.name)) &&
          (p.state === undefined || same(e.state, p.state))
      )
      return p.present === false ? !found : found
    }
    case 'state':
      return obs.flags?.[p.key] === p.equals
    case 'all':
      return p.of.every((q) => evaluatePredicate(q, obs))
  }
}

/** An observation counts only if it was taken after the step (or the resume) started. */
export function isFresh(obs: WalkthroughObservation, mark: ObservationWatermark, startedAt: number): boolean {
  return obs.generation >= mark.generation && obs.sequence > mark.sequence && obs.capturedAt >= startedAt
}

/** Plain, calm copy in the V04 voice: what happened, then what the owner can do. No exclamation marks. */
export const WALKTHROUGH_COPY = {
  planning: 'Working out the steps.',
  step: (n: number, total: number) => `Step ${n} of ${total}. Tell me when you are done and I will check.`,
  retry: 'I do not see that change yet. Finish the step and ask me to check again.',
  unavailable: 'I could not look at the screen just now. Try checking again.',
  completed: 'That was the last step, and it is done.',
  resumeChanged: 'The screen has changed since you paused. Take this step again from here.',
  resumeBlocked: 'I will pick this up once the screen is unlocked and no meeting is running.',
  resumeUnavailable: 'I could not look at the screen, so I stayed paused. Try resuming again.',
  paused: {
    owner: 'Paused. Resume when you are ready and I will look at the screen first.',
    locked: 'Paused while the screen is locked. I will look again before we continue.',
    focus_away: 'Paused because you went to another app. I will look again before we continue.',
    meeting: 'Paused because a meeting started. I will look again before we continue.',
    interrupted: 'Paused. I will look at the screen again before we continue.'
  } satisfies Record<WalkthroughPauseReason, string>,
  stopped: {
    owner_stop: 'Stopped. Nothing else will happen.',
    sign_out: 'Stopped because you signed out.',
    owner_switch: 'Stopped because the account changed.',
    budget: `We have reached the ${WALKTHROUGH_STEP_BUDGET}-step limit, so I am stopping here. Ask again to carry on from where you are.`,
    unverified: 'I could not confirm this step, so I am stopping rather than guessing. Ask again to start over.',
    no_plan: 'I cannot guide that one yet. I stopped without touching anything.',
    plan_refused: 'I could not put together safe steps for that, so I stopped.'
  } satisfies Record<WalkthroughStopReason, string>
} as const
