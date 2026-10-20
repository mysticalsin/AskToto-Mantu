import { randomBytes } from 'node:crypto'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { OWNER_SESSION_IPC, OwnerSessionStatusSchema } from '@shared/contracts/owner-session'
import type { OwnerSessionRef } from '@shared/contracts/owner-session'
import { authStatus } from '../auth'
import type { OwnerSessionAuthority } from '../lifecycle/owner-session-authority'
import { auditLog } from '../logger'
import { createSenderAuthorizer } from './sender-auth'
import type { AuthorizeSender, SenderAuthDeps } from './sender-auth'

export interface RegisterOwnerSessionDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  assertMainWindow(event: IpcMainInvokeEvent): void
  ownerSession: OwnerSessionAuthority
  currentInputSessionContext(): { authSessionGeneration: number; contextRevision: number }
  audit?: SenderAuthDeps['audit']
  signedIn?(): boolean
  randomHandle?(): string
}

const HEX_ONLY = /^[0-9a-fA-F]+$/
const MAX_HANDLE_TRIES = 4

/** Registers `ownerSession:status` and returns the shared sender authorizer for other handlers. */
export function registerOwnerSessionIpc(deps: RegisterOwnerSessionDeps): AuthorizeSender {
  const audit = deps.audit ?? ((event, detail) => auditLog(event, detail))
  const signedIn = deps.signedIn ?? (() => authStatus().signedIn)
  const randomHandle = deps.randomHandle ?? (() => randomBytes(32).toString('base64url'))

  const authorizeSender = createSenderAuthorizer({
    assertMainWindow: deps.assertMainWindow,
    ownerSession: deps.ownerSession,
    currentContextRevision: () => deps.currentInputSessionContext().contextRevision,
    audit
  })

  const handleBySession = new Map<string, string>()
  const refByHandle = new Map<string, OwnerSessionRef>()
  const sessionByFrame = new Map<string, string>()

  const dropSession = (sessionId: string): void => {
    const handle = handleBySession.get(sessionId)
    if (handle === undefined) return
    const ref = refByHandle.get(handle)
    handleBySession.delete(sessionId)
    refByHandle.delete(handle)
    if (ref && sessionByFrame.get(ref.frameOwner) === sessionId) sessionByFrame.delete(ref.frameOwner)
  }

  const newHandle = (): string => {
    let handle = randomHandle()
    for (let tries = 1; tries < MAX_HANDLE_TRIES && HEX_ONLY.test(handle); tries++) handle = randomHandle()
    return handle
  }

  const handleFor = (ref: OwnerSessionRef): string => {
    const existing = handleBySession.get(ref.sessionId)
    if (existing !== undefined) return existing
    const older = sessionByFrame.get(ref.frameOwner)
    if (older !== undefined && older !== ref.sessionId) dropSession(older)
    const handle = newHandle()
    handleBySession.set(ref.sessionId, handle)
    refByHandle.set(handle, ref)
    sessionByFrame.set(ref.frameOwner, ref.sessionId)
    return handle
  }

  deps.ownerSession.onRevoked((ref) => dropSession(ref.sessionId))

  deps.ipcMain.handle(OWNER_SESSION_IPC.status, (event: IpcMainInvokeEvent, payload?: unknown) => {
    authorizeSender(event, { surface: 'ownerSession.status', requireOwner: false, allowedFrames: 'main-window-top' })
    if (payload !== undefined) throw new Error('invalid_request')
    const context = deps.currentInputSessionContext()
    const frame = event.senderFrame
    const ref = frame ? deps.ownerSession.mint(frame, context.contextRevision) : null
    const isSignedIn = signedIn()
    return OwnerSessionStatusSchema.parse({
      signedIn: isSignedIn,
      handle: isSignedIn && ref ? handleFor(ref) : null,
      authGeneration: context.authSessionGeneration
    })
  })

  return authorizeSender
}
