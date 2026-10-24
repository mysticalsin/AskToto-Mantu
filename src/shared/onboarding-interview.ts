import { z } from 'zod'
import {
  ASSISTANT_INSTRUCTIONS_MAX_CHARS,
  ASSISTANT_NAME_MAX_CHARS,
  AssistantBaseSchema,
  ConfirmRequestSchema,
  CONFIRM_REFUSALS,
  PROPOSE_REFUSALS,
  ProposeResultSchema
} from './assistants'
import { SetupMeterSummarySchema } from './setup-metering'

/**
 * The onboarding role interview (G56, R005). Four short questions propose three editable assistants; confirming
 * creates them through the G48 assistant service. Answers are the owner's own typed choices and live only in a
 * sealed per-partition file in main. Nothing here is a model call: the drafts come from fixed templates.
 */
export const ONBOARDING_INTERVIEW_IPC = {
  load: 'onboarding-interview:load',
  save: 'onboarding-interview:save',
  propose: 'onboarding-interview:propose',
  confirm: 'onboarding-interview:confirm',
  discard: 'onboarding-interview:discard',
  setupEnded: 'onboarding-interview:setup-ended'
} as const

export const INTERVIEW_ROLES = ['consulting', 'sales', 'engineering', 'leadership', 'other'] as const
export const INTERVIEW_MEETINGS = ['client', 'internal', 'interviews', 'workshops'] as const
export const INTERVIEW_OUTCOMES = ['actions', 'client-summary', 'decisions', 'follow-up'] as const
export const INTERVIEW_TONES = ['brief', 'detailed'] as const
export const INTERVIEW_ROLE_OTHER_MAX_CHARS = 80
export const INTERVIEW_STEP_COUNT = 4
/** Step 4 is the proposal, after the four questions. */
export const INTERVIEW_PROPOSAL_STEP = INTERVIEW_STEP_COUNT
export const INTERVIEW_DRAFT_COUNT = 3

export type InterviewRole = (typeof INTERVIEW_ROLES)[number]
export type InterviewMeeting = (typeof INTERVIEW_MEETINGS)[number]
export type InterviewOutcome = (typeof INTERVIEW_OUTCOMES)[number]
export type InterviewTone = (typeof INTERVIEW_TONES)[number]

export interface InterviewQuestion<T extends string> {
  key: 'role' | 'meetings' | 'outcome' | 'tone'
  title: string
  choices: ReadonlyArray<{ id: T; label: string }>
  /** How many choices the question accepts. */
  max: number
}

export const INTERVIEW_QUESTIONS: readonly [
  InterviewQuestion<InterviewRole>,
  InterviewQuestion<InterviewMeeting>,
  InterviewQuestion<InterviewOutcome>,
  InterviewQuestion<InterviewTone>
] = [
  {
    key: 'role',
    title: 'What do you do?',
    max: 1,
    choices: [
      { id: 'consulting', label: 'Consulting' },
      { id: 'sales', label: 'Sales' },
      { id: 'engineering', label: 'Engineering' },
      { id: 'leadership', label: 'Leadership' },
      { id: 'other', label: 'Something else' }
    ]
  },
  {
    key: 'meetings',
    title: 'Which meetings fill your week?',
    max: 2,
    choices: [
      { id: 'client', label: 'Client calls' },
      { id: 'internal', label: 'Team meetings' },
      { id: 'interviews', label: 'Interviews' },
      { id: 'workshops', label: 'Workshops' }
    ]
  },
  {
    key: 'outcome',
    title: 'What do you want afterwards?',
    max: 1,
    choices: [
      { id: 'actions', label: 'Action items' },
      { id: 'client-summary', label: 'A summary to share' },
      { id: 'decisions', label: 'Decisions made' },
      { id: 'follow-up', label: 'A follow-up draft' }
    ]
  },
  {
    key: 'tone',
    title: 'How should Métis write?',
    max: 1,
    choices: [
      { id: 'brief', label: 'Short and direct' },
      { id: 'detailed', label: 'Thorough' }
    ]
  }
]

export const InterviewAnswersSchema = z
  .object({
    role: z.enum(INTERVIEW_ROLES).optional(),
    roleOther: z.string().max(INTERVIEW_ROLE_OTHER_MAX_CHARS).optional(),
    meetings: z.array(z.enum(INTERVIEW_MEETINGS)).min(1).max(2).optional(),
    outcome: z.enum(INTERVIEW_OUTCOMES).optional(),
    tone: z.enum(INTERVIEW_TONES).optional()
  })
  .strict()
export type InterviewAnswers = z.infer<typeof InterviewAnswersSchema>

export const InterviewDraftSchema = z
  .object({
    name: z.string().trim().min(1).max(ASSISTANT_NAME_MAX_CHARS),
    base: AssistantBaseSchema,
    instructions: z.string().max(ASSISTANT_INSTRUCTIONS_MAX_CHARS),
    include: z.boolean()
  })
  .strict()
export type InterviewDraft = z.infer<typeof InterviewDraftSchema>

export const INTERVIEW_STATUSES = ['in-progress', 'proposed', 'complete', 'declined'] as const
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number]

const STEP = z.number().int().min(0).max(INTERVIEW_PROPOSAL_STEP)
const ASSISTANT_ID = z.string().regex(/^a_[0-9a-f]{32}$/)

/** What the renderer sees of the sealed interview doc: never an owner, tenant or idempotency key. */
export const InterviewViewSchema = z
  .object({
    status: z.enum(INTERVIEW_STATUSES),
    step: STEP,
    answers: InterviewAnswersSchema,
    drafts: z.array(InterviewDraftSchema).max(INTERVIEW_DRAFT_COUNT),
    createdIds: z.array(ASSISTANT_ID).max(INTERVIEW_DRAFT_COUNT)
  })
  .strict()
export type InterviewView = z.infer<typeof InterviewViewSchema>

/** The renderer may save progress, never `complete`: only a confirmed creation completes the interview. */
export const InterviewSaveRequestSchema = z
  .object({
    status: z.enum(['in-progress', 'proposed', 'declined']),
    step: STEP,
    answers: InterviewAnswersSchema,
    drafts: z.array(InterviewDraftSchema).max(INTERVIEW_DRAFT_COUNT)
  })
  .strict()
export type InterviewSaveRequest = z.infer<typeof InterviewSaveRequestSchema>

export const InterviewProposeRequestSchema = z
  .object({ drafts: z.array(InterviewDraftSchema).length(INTERVIEW_DRAFT_COUNT) })
  .strict()
export const InterviewConfirmRequestSchema = ConfirmRequestSchema
export const InterviewNoPayloadSchema = z.undefined()

export const INTERVIEW_REFUSALS = ['signed-out', 'invalid', 'stale', 'unavailable'] as const

export const InterviewLoadResultSchema = z.union([
  z.object({ ok: z.literal(true), view: InterviewViewSchema, meter: SetupMeterSummarySchema }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(INTERVIEW_REFUSALS) }).strict()
])
export type InterviewLoadResult = z.infer<typeof InterviewLoadResultSchema>

export const InterviewMutationResultSchema = z.union([
  z.object({ ok: z.literal(true), view: InterviewViewSchema }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(INTERVIEW_REFUSALS) }).strict()
])
export type InterviewMutationResult = z.infer<typeof InterviewMutationResultSchema>

export const InterviewProposeResultSchema = z.union([
  ProposeResultSchema,
  z.object({ ok: z.literal(false), reason: z.enum([...PROPOSE_REFUSALS, 'stale', 'nothing-included']) }).strict()
])
export type InterviewProposeResult = z.infer<typeof InterviewProposeResultSchema>

export const InterviewConfirmResultSchema = z.union([
  z.object({ ok: z.literal(true), view: InterviewViewSchema, createdCount: z.number().int().min(0).max(3) }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(CONFIRM_REFUSALS) }).strict()
])
export type InterviewConfirmResult = z.infer<typeof InterviewConfirmResultSchema>

export const InterviewSetupEndedResultSchema = z.union([
  z.object({ ok: z.literal(true), workAllowanceStartsAt: z.number().int().nonnegative() }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(INTERVIEW_REFUSALS) }).strict()
])
export type InterviewSetupEndedResult = z.infer<typeof InterviewSetupEndedResultSchema>

export const EMPTY_INTERVIEW_VIEW: InterviewView = {
  status: 'in-progress',
  step: 0,
  answers: {},
  drafts: [],
  createdIds: []
}

type Seed = { name: string; base: z.infer<typeof AssistantBaseSchema>; purpose: string }

const ROLE_SEEDS: Record<InterviewRole, readonly [Seed, Seed, Seed]> = {
  consulting: [
    { name: 'Client debrief', base: 'meeting', purpose: 'Captures what the client asked for and what you agreed.' },
    { name: 'Workshop lead', base: 'presentation', purpose: 'Keeps a workshop on track and notes every output.' },
    { name: 'Proposal coach', base: 'negotiation', purpose: 'Tracks scope, price and the open points of a deal.' }
  ],
  sales: [
    { name: 'Discovery call', base: 'sales', purpose: 'Notes needs, budget, timing and the next step.' },
    { name: 'Deal negotiator', base: 'negotiation', purpose: 'Tracks offers, concessions and what is still open.' },
    { name: 'Cold call coach', base: 'cold-call', purpose: 'Helps open strong and handle the first objection.' }
  ],
  engineering: [
    { name: 'Team sync', base: 'meeting', purpose: 'Captures blockers, owners and decisions from the sync.' },
    { name: 'Design review', base: 'general', purpose: 'Notes trade-offs, risks and what was decided.' },
    { name: 'Interview panel', base: 'recruiting', purpose: 'Keeps evidence for each skill the panel assesses.' }
  ],
  leadership: [
    { name: 'Leadership sync', base: 'meeting', purpose: 'Captures decisions, owners and dates.' },
    { name: 'Presenter', base: 'presentation', purpose: 'Keeps a talk on message and notes the questions.' },
    { name: 'Hiring panel', base: 'recruiting', purpose: 'Keeps evidence for each candidate you meet.' }
  ],
  other: [
    { name: 'Meeting notes', base: 'meeting', purpose: 'Captures what was said, decided and promised.' },
    { name: 'Everyday helper', base: 'general', purpose: 'Answers questions while you talk.' },
    { name: 'Presenter', base: 'presentation', purpose: 'Keeps a talk on message and notes the questions.' }
  ]
}

const MEETING_TEXT: Record<InterviewMeeting, string> = {
  client: 'client calls',
  internal: 'team meetings',
  interviews: 'interviews',
  workshops: 'workshops'
}
const OUTCOME_TEXT: Record<InterviewOutcome, string> = {
  actions: 'End with a clear list of action items and owners.',
  'client-summary': 'End with a short summary that can be shared with the client.',
  decisions: 'End with the decisions made and who made them.',
  'follow-up': 'End with a follow-up message ready to edit and send.'
}
const TONE_TEXT: Record<InterviewTone, string> = {
  brief: 'Write short and direct.',
  detailed: 'Write thoroughly and keep the context.'
}

/** Owner-typed free text, trimmed and capped; control characters removed so the template stays one line. */
export function cleanRoleOther(raw: string | undefined): string {
  return (raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, INTERVIEW_ROLE_OTHER_MAX_CHARS)
}

/** The purpose line shown on a proposal card for a base mode, or an empty string for an edited base. */
export function draftPurpose(answers: InterviewAnswers, index: number): string {
  return ROLE_SEEDS[answers.role ?? 'other'][index]?.purpose ?? ''
}

/** Deterministic: the same answers always give the same three drafts. No model call, no network. */
export function draftsFromAnswers(answers: InterviewAnswers): InterviewDraft[] {
  const seeds = ROLE_SEEDS[answers.role ?? 'other']
  const roleOther = answers.role === 'other' ? cleanRoleOther(answers.roleOther) : ''
  const meetings = (answers.meetings ?? []).map((id) => MEETING_TEXT[id])
  return seeds.map((seed) => {
    const lines = [seed.purpose]
    if (roleOther) lines.push(`The person describes their work as: ${roleOther}.`)
    if (meetings.length > 0) lines.push(`Most of their meetings are ${meetings.join(' and ')}.`)
    if (answers.outcome) lines.push(OUTCOME_TEXT[answers.outcome])
    if (answers.tone) lines.push(TONE_TEXT[answers.tone])
    return { name: seed.name, base: seed.base, instructions: lines.join(' '), include: true }
  })
}
