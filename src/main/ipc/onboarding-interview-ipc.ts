import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  InterviewConfirmRequestSchema,
  InterviewNoPayloadSchema,
  InterviewProposeRequestSchema,
  InterviewSaveRequestSchema,
  ONBOARDING_INTERVIEW_IPC
} from '@shared/onboarding-interview'
import type { InterviewService } from '../features/onboarding'
import type { AuthorizeSender, SenderEventLike } from './sender-auth'

export interface OnboardingInterviewIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle'>
  /** Audited main-window top-frame gate; throws a typed refusal for any other sender. */
  authorizeSender: AuthorizeSender
  requireAuth(): boolean
  service: InterviewService
}

const INVALID = { ok: false, reason: 'invalid' } as const
const SIGNED_OUT = { ok: false, reason: 'signed-out' } as const
const UNAVAILABLE = { ok: false, reason: 'unavailable' } as const

/**
 * The renderer's seam to the onboarding role interview and setup meter (G56). Same guard shape as the G48 assistants
 * IPC: main-window top frame, owner required, signed in, strict payloads (an unknown key is invalid) and typed
 * refusals. The renderer never sees an owner, tenant or meter key, and can never mark the interview complete: only a
 * confirmed G48 creation does.
 */
export function registerOnboardingInterviewIpc(deps: OnboardingInterviewIpcDependencies): void {
  const guard = (event: IpcMainInvokeEvent, surface: string): boolean => {
    deps.authorizeSender(event as unknown as SenderEventLike, {
      surface: `onboarding-interview.${surface}`,
      requireOwner: true,
      allowedFrames: 'main-window-top'
    })
    return deps.requireAuth()
  }
  const settle = async <T>(work: () => Promise<T>): Promise<T | typeof UNAVAILABLE> => {
    try {
      return await work()
    } catch {
      return UNAVAILABLE
    }
  }
  const { ipcMain, service } = deps
  const handle = (
    channel: string,
    surface: string,
    schema: { safeParse(raw: unknown): { success: boolean } },
    work: (raw: unknown) => Promise<unknown>
  ): void => {
    ipcMain.handle(channel, async (event, raw) => {
      if (!guard(event, surface)) return SIGNED_OUT
      return schema.safeParse(raw).success ? settle(() => work(raw)) : INVALID
    })
  }

  handle(ONBOARDING_INTERVIEW_IPC.load, 'load', InterviewNoPayloadSchema, () => service.load())
  handle(ONBOARDING_INTERVIEW_IPC.save, 'save', InterviewSaveRequestSchema, (raw) => service.save(raw))
  handle(ONBOARDING_INTERVIEW_IPC.propose, 'propose', InterviewProposeRequestSchema, (raw) => service.propose(raw))
  handle(ONBOARDING_INTERVIEW_IPC.confirm, 'confirm', InterviewConfirmRequestSchema, (raw) => service.confirm(raw))
  handle(ONBOARDING_INTERVIEW_IPC.discard, 'discard', InterviewNoPayloadSchema, () => service.discard())
  handle(ONBOARDING_INTERVIEW_IPC.setupEnded, 'setupEnded', InterviewNoPayloadSchema, () => service.setupEnded())
}
