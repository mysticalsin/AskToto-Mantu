import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IpcMain } from 'electron'
import type { AssistantScope, AssistantService } from '../features/assistants'
import { createInterviewService, createInterviewStore, type InterviewAuditPhase } from '../features/onboarding'
import { atomicSavedWrite } from '../infra/storage/atomic-saved-write'
import { registerOnboardingInterviewIpc } from '../ipc/onboarding-interview-ipc'
import type { AuthorizeSender } from '../ipc/sender-auth'

export interface OnboardingInterviewWiringDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  authorizeSender: AuthorizeSender
  requireAuth(): boolean
  userDataPath(): string
  seal(plain: string): Buffer
  open(sealed: Buffer): string
  /** The same scope the G48 assistant store reads. */
  scope(): AssistantScope | null
  assistants: AssistantService
  audit(record: { phase: InterviewAuditPhase; reason?: string; count?: number }): void
  now(): number
}

/**
 * Builds the onboarding interview and setup meter (G56) under `<userData>/onboarding/<partition>.bin`, sealed and
 * scoped exactly like the G48 assistants, and registers its IPC. Called from `bootstrapAssistants`, so index.ts
 * gains no lines. The interview holds no in-memory pending state: G48 forgets its proposals on owner change.
 */
export function bootstrapOnboardingInterview(deps: OnboardingInterviewWiringDeps): void {
  const dir = (): string => join(deps.userDataPath(), 'onboarding')
  const file = (partitionId: string): string => {
    if (!/^(?:legacy|[0-9a-f]{24})$/.test(partitionId)) throw new Error('invalid memory partition')
    return join(dir(), `${partitionId}.bin`)
  }
  const store = createInterviewStore({
    io: {
      async read(partitionId) {
        try {
          return await readFile(file(partitionId))
        } catch (error) {
          if ((error as { code?: unknown } | null)?.code === 'ENOENT') return null
          throw error
        }
      },
      async write(partitionId, data) {
        const target = file(partitionId)
        await mkdir(dir(), { recursive: true, mode: 0o700 })
        await atomicSavedWrite(target, data)
      }
    },
    seal: deps.seal,
    open: deps.open,
    scope: deps.scope
  })
  registerOnboardingInterviewIpc({
    ipcMain: deps.ipcMain,
    authorizeSender: deps.authorizeSender,
    requireAuth: deps.requireAuth,
    service: createInterviewService({
      store,
      scope: deps.scope,
      assistants: deps.assistants,
      now: deps.now,
      audit: (phase, detail) => deps.audit({ phase, ...detail })
    })
  })
}
