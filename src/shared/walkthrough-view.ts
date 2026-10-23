import { z } from 'zod'

/**
 * The renderer-safe view of a walkthrough (G44, CAP-25). G45 draws it; it carries only what is drawn: the phase,
 * the step position, the instruction Métis wrote, and one plain sentence of status. It never carries an
 * observation, a source id, a window title or anything read from the screen.
 */
export const WALKTHROUGH_STEP_BUDGET = 15

export const WALKTHROUGH_PHASES = [
  'idle',
  'planning',
  'awaiting',
  'verifying',
  'revalidating',
  'paused',
  'completed',
  'abandoned'
] as const
export type WalkthroughPhase = (typeof WALKTHROUGH_PHASES)[number]

export const WALKTHROUGH_PAUSE_REASONS = ['owner', 'locked', 'focus_away', 'meeting', 'interrupted'] as const
export type WalkthroughPauseReason = (typeof WALKTHROUGH_PAUSE_REASONS)[number]

export const WALKTHROUGH_STOP_REASONS = [
  'owner_stop',
  'sign_out',
  'owner_switch',
  'budget',
  'unverified',
  'no_plan',
  'plan_refused'
] as const
export type WalkthroughStopReason = (typeof WALKTHROUGH_STOP_REASONS)[number]

export const WalkthroughViewSchema = z
  .object({
    runId: z.string().max(64).nullable(),
    phase: z.enum(WALKTHROUGH_PHASES),
    /** 1-based position of the current step; null when no step is current. */
    step: z.number().int().min(1).max(WALKTHROUGH_STEP_BUDGET).nullable(),
    /** Steps in the plan, never more than the budget. */
    stepCount: z.number().int().min(0).max(WALKTHROUGH_STEP_BUDGET),
    budget: z.literal(WALKTHROUGH_STEP_BUDGET),
    instruction: z.string().max(240).nullable(),
    /** One plain sentence for the pill or card. */
    status: z.string().max(240),
    pauseReason: z.enum(WALKTHROUGH_PAUSE_REASONS).nullable(),
    stopReason: z.enum(WALKTHROUGH_STOP_REASONS).nullable(),
    canCheck: z.boolean(),
    canPause: z.boolean(),
    canResume: z.boolean(),
    canStop: z.boolean()
  })
  .strict()
export type WalkthroughView = z.infer<typeof WalkthroughViewSchema>

export const IDLE_WALKTHROUGH_VIEW: WalkthroughView = Object.freeze({
  runId: null,
  phase: 'idle',
  step: null,
  stepCount: 0,
  budget: WALKTHROUGH_STEP_BUDGET,
  instruction: null,
  status: '',
  pauseReason: null,
  stopReason: null,
  canCheck: false,
  canPause: false,
  canResume: false,
  canStop: false
})

/** G45: main pushes the view to the owner window; the coach card asks for one of the owner's own actions. */
export const WALKTHROUGH_IPC = {
  view: 'walkthrough:view',
  current: 'walkthrough:current',
  act: 'walkthrough:act'
} as const

export const WALKTHROUGH_CARD_ACTIONS = ['check', 'pause', 'resume', 'stop'] as const
export type WalkthroughCardAction = (typeof WALKTHROUGH_CARD_ACTIONS)[number]
export const WalkthroughActInputSchema = z.object({ action: z.enum(WALKTHROUGH_CARD_ACTIONS) }).strict()
