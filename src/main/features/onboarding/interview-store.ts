import { z } from 'zod'
import {
  INTERVIEW_DRAFT_COUNT,
  INTERVIEW_PROPOSAL_STEP,
  INTERVIEW_STATUSES,
  InterviewAnswersSchema,
  InterviewDraftSchema
} from '@shared/onboarding-interview'
import { SETUP_METER_MAX_ENTRIES, SetupMeterEntrySchema } from '@shared/setup-metering'
import type { AssistantFileIo, AssistantScope } from '../assistants'

const InterviewStateSchema = z
  .object({
    status: z.enum(INTERVIEW_STATUSES),
    step: z.number().int().min(0).max(INTERVIEW_PROPOSAL_STEP),
    answers: InterviewAnswersSchema,
    drafts: z.array(InterviewDraftSchema).max(INTERVIEW_DRAFT_COUNT),
    createdIds: z.array(z.string().regex(/^a_[0-9a-f]{32}$/)).max(INTERVIEW_DRAFT_COUNT),
    updatedAt: z.number().int().nonnegative()
  })
  .strict()
export type InterviewState = z.infer<typeof InterviewStateSchema>

/** The setup bucket (G56, R006). It holds setup events only: there is no work meter in this file. */
const SetupMeterDocSchema = z
  .object({
    entries: z.array(SetupMeterEntrySchema).max(SETUP_METER_MAX_ENTRIES),
    workAllowanceStartsAt: z.number().int().nonnegative().nullable()
  })
  .strict()
export type SetupMeterDoc = z.infer<typeof SetupMeterDocSchema>

const DocSchema = z
  .object({
    v: z.literal(1),
    partitionId: z.string().regex(/^(?:legacy|[0-9a-f]{24})$/),
    ownerKey: z.string().regex(/^[0-9a-f]{64}$/),
    tenantKey: z.string().regex(/^[0-9a-f]{64}$/),
    interview: InterviewStateSchema,
    meter: SetupMeterDocSchema
  })
  .strict()
type Doc = z.infer<typeof DocSchema>

export interface InterviewDocView {
  interview: InterviewState
  meter: SetupMeterDoc
}

export type InterviewTx<T> = { commit: false; value: T } | { commit: true; next: InterviewDocView; value: T }
export type InterviewTxResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'signed-out' | 'unavailable' | 'stale' }

export interface InterviewStore {
  /** Same contract as the G48 assistant store: one at a time, `stale` on a scope change, an unreadable file is never overwritten. */
  transact<T>(
    fn: (view: InterviewDocView) => InterviewTx<T>,
    expectedScope?: AssistantScope
  ): Promise<InterviewTxResult<T>>
}

export interface InterviewStoreDeps {
  io: AssistantFileIo
  seal(plain: string): Buffer
  open(sealed: Buffer): string
  scope(): AssistantScope | null
}

export const freshInterviewState = (now: number): InterviewState => ({
  status: 'in-progress',
  step: 0,
  answers: {},
  drafts: [],
  createdIds: [],
  updatedAt: now
})

const sameScope = (a: AssistantScope, b: AssistantScope | null): boolean =>
  b !== null && a.partitionId === b.partitionId && a.ownerKey === b.ownerKey && a.tenantKey === b.tenantKey

/** The interview and setup meter, sealed, one file per memory partition (`<userData>/onboarding/<partition>.bin`). */
export function createInterviewStore(deps: InterviewStoreDeps): InterviewStore {
  let tail: Promise<unknown> = Promise.resolve()

  const load = async (scope: AssistantScope): Promise<Doc | null> => {
    const bytes = await deps.io.read(scope.partitionId)
    if (bytes === null) {
      return {
        v: 1,
        partitionId: scope.partitionId,
        ownerKey: scope.ownerKey,
        tenantKey: scope.tenantKey,
        interview: freshInterviewState(0),
        meter: { entries: [], workAllowanceStartsAt: null }
      }
    }
    try {
      const parsed = DocSchema.safeParse(JSON.parse(deps.open(bytes)))
      return parsed.success && sameScope(scope, parsed.data) ? parsed.data : null
    } catch {
      return null
    }
  }

  const run = async <T>(
    fn: (view: InterviewDocView) => InterviewTx<T>,
    expectedScope?: AssistantScope
  ): Promise<InterviewTxResult<T>> => {
    const scope = deps.scope()
    if (scope === null) return { ok: false, reason: 'signed-out' }
    if (expectedScope && !sameScope(expectedScope, scope)) return { ok: false, reason: 'stale' }
    let doc: Doc | null
    try {
      doc = await load(scope)
    } catch {
      return { ok: false, reason: 'unavailable' }
    }
    if (!sameScope(scope, deps.scope())) return { ok: false, reason: 'stale' }
    if (doc === null) return { ok: false, reason: 'unavailable' }
    let outcome: InterviewTx<T>
    try {
      outcome = fn({ interview: doc.interview, meter: doc.meter })
    } catch {
      return { ok: false, reason: 'unavailable' }
    }
    if (!outcome.commit) return { ok: true, value: outcome.value }
    const parsed = DocSchema.safeParse({
      v: 1,
      partitionId: scope.partitionId,
      ownerKey: scope.ownerKey,
      tenantKey: scope.tenantKey,
      interview: outcome.next.interview,
      meter: outcome.next.meter
    })
    if (!parsed.success) return { ok: false, reason: 'unavailable' }
    if (!sameScope(scope, deps.scope())) return { ok: false, reason: 'stale' }
    try {
      await deps.io.write(scope.partitionId, deps.seal(JSON.stringify(parsed.data)))
    } catch {
      return { ok: false, reason: 'unavailable' }
    }
    if (!sameScope(scope, deps.scope())) return { ok: false, reason: 'stale' }
    return { ok: true, value: outcome.value }
  }

  return {
    transact(fn, expectedScope) {
      const result = tail.then(() => run(fn, expectedScope))
      tail = result.catch(() => undefined)
      return result
    }
  }
}
