import type { IpcRenderer } from 'electron'
import {
  InterviewConfirmResultSchema,
  InterviewLoadResultSchema,
  InterviewMutationResultSchema,
  InterviewProposeResultSchema,
  InterviewSetupEndedResultSchema,
  ONBOARDING_INTERVIEW_IPC,
  type InterviewConfirmResult,
  type InterviewDraft,
  type InterviewLoadResult,
  type InterviewMutationResult,
  type InterviewProposeResult,
  type InterviewSaveRequest,
  type InterviewSetupEndedResult
} from '../shared/onboarding-interview'

const UNAVAILABLE = { ok: false, reason: 'unavailable' } as const

/**
 * The onboarding interview bridge (G56). Replies are validated strictly against the contract and a malformed one is
 * replaced by a content-free refusal, like the G48 assistants bridge.
 */
export function createOnboardingInterviewPreloadApi(ipc: Pick<IpcRenderer, 'invoke'>): {
  onboardingInterview: {
    load(): Promise<InterviewLoadResult>
    save(input: InterviewSaveRequest): Promise<InterviewMutationResult>
    propose(drafts: InterviewDraft[]): Promise<InterviewProposeResult>
    confirm(proposalId: string, previewHash: string): Promise<InterviewConfirmResult>
    discard(): Promise<InterviewMutationResult>
    setupEnded(): Promise<InterviewSetupEndedResult>
  }
} {
  const call = async <T>(
    schema: { safeParse(raw: unknown): { success: true; data: T } | { success: false } },
    channel: string,
    payload?: unknown
  ): Promise<T> => {
    try {
      const parsed = schema.safeParse(await ipc.invoke(channel, payload))
      return parsed.success ? parsed.data : (UNAVAILABLE as unknown as T)
    } catch {
      return UNAVAILABLE as unknown as T
    }
  }
  return {
    onboardingInterview: {
      load: () => call(InterviewLoadResultSchema, ONBOARDING_INTERVIEW_IPC.load),
      save: (input) => call(InterviewMutationResultSchema, ONBOARDING_INTERVIEW_IPC.save, input),
      propose: (drafts) => call(InterviewProposeResultSchema, ONBOARDING_INTERVIEW_IPC.propose, { drafts }),
      confirm: (proposalId, previewHash) =>
        call(InterviewConfirmResultSchema, ONBOARDING_INTERVIEW_IPC.confirm, { proposalId, previewHash }),
      discard: () => call(InterviewMutationResultSchema, ONBOARDING_INTERVIEW_IPC.discard),
      setupEnded: () => call(InterviewSetupEndedResultSchema, ONBOARDING_INTERVIEW_IPC.setupEnded)
    }
  }
}
