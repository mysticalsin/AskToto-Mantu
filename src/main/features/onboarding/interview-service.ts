import { createHash } from 'node:crypto'
import { ownerCommand } from '@shared/context-authority'
import {
  InterviewConfirmRequestSchema,
  InterviewProposeRequestSchema,
  InterviewSaveRequestSchema,
  type InterviewConfirmResult,
  type InterviewLoadResult,
  type InterviewMutationResult,
  type InterviewProposeResult,
  type InterviewSetupEndedResult,
  type InterviewView
} from '@shared/onboarding-interview'
import { SETUP_METER_MAX_ENTRIES, type SetupMeterEntry, type SetupMeterSummary } from '@shared/setup-metering'
import type { AssistantScope, AssistantService } from '../assistants'
import { freshInterviewState, type InterviewDocView, type InterviewState, type InterviewStore } from './interview-store'

export type InterviewAuditPhase = 'saved' | 'proposed' | 'completed' | 'discarded' | 'setup-ended' | 'refused'

export interface InterviewServiceDeps {
  store: InterviewStore
  scope(): AssistantScope | null
  /** G48: the only path that creates assistants (propose, exact preview, confirm with its hash). */
  assistants: Pick<AssistantService, 'propose' | 'confirm'>
  now(): number
  /** Phase tokens and counts only: never an answer, a name or an instruction. */
  audit?(phase: InterviewAuditPhase, detail: { reason?: string; count?: number }): void
}

export interface InterviewService {
  load(): Promise<InterviewLoadResult>
  save(input: unknown): Promise<InterviewMutationResult>
  propose(input: unknown): Promise<InterviewProposeResult>
  confirm(input: unknown): Promise<InterviewConfirmResult>
  /** Clears answers and drafts of an unfinished interview. A completed one, and its assistants, stay. */
  discard(): Promise<InterviewMutationResult>
  /** First onboarding finish or skip: normal allowance begins. Set once, never moved by a replay. */
  setupEnded(): Promise<InterviewSetupEndedResult>
}

const viewOf = (state: InterviewState): InterviewView => ({
  status: state.status,
  step: state.step,
  answers: state.answers,
  drafts: state.drafts,
  createdIds: state.createdIds
})

const summaryOf = (doc: InterviewDocView): SetupMeterSummary => ({
  bucket: 'setup',
  assistantsCreated: doc.meter.entries.filter((e) => e.kind === 'assistant-created').length,
  interviewsCompleted: doc.meter.entries.filter((e) => e.kind === 'interview-completed').length,
  workAllowanceStartsAt: doc.meter.workAllowanceStartsAt
})

/** One meter key per real event: replays and resumed confirms land on the same key and are not counted twice. */
const meterKey = (scope: AssistantScope, subject: string): string =>
  createHash('sha256')
    .update(JSON.stringify(['metis.setup.v1', scope.tenantKey, scope.ownerKey, subject]))
    .digest('hex')

type Refusal = 'signed-out' | 'unavailable' | 'stale'

export function createInterviewService(deps: InterviewServiceDeps): InterviewService {
  const audit = (phase: InterviewAuditPhase, detail: { reason?: string; count?: number } = {}): void => {
    try {
      deps.audit?.(phase, detail)
    } catch {
      // an audit failure never changes the outcome
    }
  }
  const refused = <R extends string>(reason: R): { ok: false; reason: R } => {
    audit('refused', { reason })
    return { ok: false, reason }
  }
  const scoped = (): AssistantScope | null => deps.scope()

  /** One read-modify-write of the interview state, refused as a typed reason. */
  async function mutate(
    change: (doc: InterviewDocView) => InterviewDocView | null
  ): Promise<{ ok: true; doc: InterviewDocView } | { ok: false; reason: Refusal }> {
    const scope = scoped()
    if (scope === null) return { ok: false, reason: 'signed-out' }
    const result = await deps.store.transact((doc) => {
      const next = change(doc)
      return next === null ? { commit: false, value: doc } : { commit: true, next, value: next }
    }, scope)
    return result.ok ? { ok: true, doc: result.value } : { ok: false, reason: result.reason }
  }

  return {
    async load() {
      const scope = scoped()
      if (scope === null) return { ok: false, reason: 'signed-out' }
      const result = await deps.store.transact((doc) => ({ commit: false, value: doc }), scope)
      if (!result.ok) return { ok: false, reason: result.reason }
      return { ok: true, view: viewOf(result.value.interview), meter: summaryOf(result.value) }
    },

    async save(input) {
      const parsed = InterviewSaveRequestSchema.safeParse(input)
      if (!parsed.success) return refused('invalid')
      const now = deps.now()
      const result = await mutate((doc) =>
        // A completed interview is only reset by discard or by starting over (save from step 0).
        doc.interview.status === 'complete' && parsed.data.step !== 0
          ? null
          : {
              ...doc,
              interview: { ...parsed.data, createdIds: doc.interview.createdIds, updatedAt: now }
            }
      )
      if (!result.ok) return refused(result.reason)
      audit('saved', { count: parsed.data.step })
      return { ok: true, view: viewOf(result.doc.interview) }
    },

    async propose(input) {
      const parsed = InterviewProposeRequestSchema.safeParse(input)
      if (!parsed.success) return refused('invalid')
      const included = parsed.data.drafts.filter((draft) => draft.include)
      if (included.length === 0) return refused('nothing-included')
      const now = deps.now()
      // Keep the edited drafts first, so a quit right after this resumes on the same proposal.
      const saved = await mutate((doc) => ({
        ...doc,
        interview: {
          ...doc.interview,
          status: doc.interview.status === 'complete' ? 'complete' : 'proposed',
          step: 4,
          drafts: parsed.data.drafts,
          updatedAt: now
        }
      }))
      if (!saved.ok) return refused(saved.reason)
      const result = await deps.assistants.propose(
        ownerCommand('user-typed', 'onboarding interview'),
        included.map(({ name, base, instructions }) => ({ name, base, instructions }))
      )
      if (result.ok) audit('proposed', { count: result.items.length })
      return result
    },

    async confirm(input) {
      const parsed = InterviewConfirmRequestSchema.safeParse(input)
      if (!parsed.success) return refused('invalid')
      const scope = scoped()
      if (scope === null) return refused('signed-out')
      const created = await deps.assistants.confirm(parsed.data)
      if (!created.ok) return created
      const now = deps.now()
      const ids = created.assistants.map((entry) => entry.assistant.assistantId)
      const result = await mutate((doc) => {
        const known = new Set(doc.meter.entries.map((entry) => entry.key))
        const fresh: SetupMeterEntry[] = []
        for (const subject of [...ids.map((id) => `assistant:${id}`), 'interview']) {
          const key = meterKey(scope, subject)
          if (known.has(key)) continue
          known.add(key)
          fresh.push({ key, kind: subject === 'interview' ? 'interview-completed' : 'assistant-created', at: now })
        }
        return {
          interview: { ...doc.interview, status: 'complete', step: 4, createdIds: ids.slice(0, 3), updatedAt: now },
          meter: {
            ...doc.meter,
            entries: [...doc.meter.entries, ...fresh].slice(-SETUP_METER_MAX_ENTRIES)
          }
        }
      })
      if (!result.ok) return refused(result.reason)
      const createdCount = created.assistants.filter((entry) => entry.created).length
      audit('completed', { count: createdCount })
      return { ok: true, view: viewOf(result.doc.interview), createdCount }
    },

    async discard() {
      const now = deps.now()
      const result = await mutate((doc) =>
        doc.interview.status === 'complete' ? null : { ...doc, interview: freshInterviewState(now) }
      )
      if (!result.ok) return refused(result.reason)
      audit('discarded')
      return { ok: true, view: viewOf(result.doc.interview) }
    },

    async setupEnded() {
      const now = deps.now()
      const result = await mutate((doc) =>
        doc.meter.workAllowanceStartsAt !== null
          ? null
          : { ...doc, meter: { ...doc.meter, workAllowanceStartsAt: now } }
      )
      if (!result.ok) return refused(result.reason)
      audit('setup-ended')
      return { ok: true, workAllowanceStartsAt: result.doc.meter.workAllowanceStartsAt ?? now }
    }
  }
}
