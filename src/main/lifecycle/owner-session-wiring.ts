import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { createMainTranscriptRevision } from '../features/meetings/main-transcript-revision'
import { createLanguageChangeAudit } from '../ipc/cloud-speech-language-audit'
import { registerOwnerSessionIpc } from '../ipc/register-owner-session'
import type { AuthorizeSender } from '../ipc/sender-auth'
import { auditLog } from '../logger'
import type { SpeechDesktopHooks } from '../speech-desktop-boundary'
import { createMainOwnerSessionAuthority, type OwnerSessionAuthority } from './owner-session-authority'

export interface OwnerSessionWiringDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  assertMainWindow(event: IpcMainInvokeEvent): void
  currentInputSessionContext(): { authSessionGeneration: number; contextRevision: number }
}

export interface OwnerSessionWiring {
  readonly ownerSession: OwnerSessionAuthority
  readonly authorizeSender: AuthorizeSender
  /** Spread into `registerInputCaptureIpc`. */
  readonly inputCapture: { ownerSession: OwnerSessionAuthority; authorizeSender: AuthorizeSender }
  /** Passed to `speechDesktopBoundaryOptions`: delivered speech feeds the transcript store; language changes are audited. */
  readonly speechHooks: SpeechDesktopHooks
}

/**
 * WP02/WP03 main wiring kept out of index.ts: the owner-session authority, its `ownerSession:status` surface and
 * shared sender authorizer, and the transcript revision store fed by delivered cloud speech. Call once from
 * registerIpc, before the speech bootstrap.
 */
export function createOwnerSessionWiring(deps: OwnerSessionWiringDeps): OwnerSessionWiring {
  const { ipcMain, assertMainWindow, currentInputSessionContext } = deps
  const ownerSession = createMainOwnerSessionAuthority(() => currentInputSessionContext().contextRevision)
  const authorizeSender = registerOwnerSessionIpc({
    ipcMain,
    assertMainWindow,
    ownerSession,
    currentInputSessionContext
  })
  const transcriptRevision = createMainTranscriptRevision((frame) => ownerSession.current(frame))
  return {
    ownerSession,
    authorizeSender,
    inputCapture: { ownerSession, authorizeSender },
    speechHooks: {
      onSegmentDelivered: transcriptRevision.onSegmentDelivered,
      onLanguageChange: createLanguageChangeAudit({
        resolveOwner: (frame) => ownerSession.current(frame),
        audit: (event, record) => auditLog(event, record)
      })
    }
  }
}
