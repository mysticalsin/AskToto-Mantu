import { AuditEventRecordSchema } from '@shared/contracts/audit-event'
import type { AuditEventRecord } from '@shared/contracts/audit-event'
import type { OwnerSessionRef } from '@shared/contracts/owner-session'
import type { OwnerSessionAuthority, OwnerSessionValidation } from '../lifecycle/owner-session-authority'

export interface SenderAuthOptions {
  /** Used in the audit record only, never payload content. */
  surface: string
  requireOwner: boolean
  allowedFrames: 'main-window-top' | 'main-window-any' | 'overlay-top'
}

export type SenderRefusalReason =
  | 'wrong-window'
  | 'subframe'
  | 'destroyed'
  | 'signed-out'
  | Exclude<OwnerSessionValidation, { ok: true }>['reason']

/** Typed refusal. The message carries the reason token only. */
export class SenderRefusal extends Error {
  readonly reason: SenderRefusalReason
  readonly surface: string

  constructor(reason: SenderRefusalReason, surface: string) {
    super(`IPC refused: ${reason}`)
    this.name = 'SenderRefusal'
    this.reason = reason
    this.surface = surface
  }
}

/** Structural stand-in for Electron.IpcMainInvokeEvent so tests can use plain objects. */
export interface SenderEventLike {
  readonly sender: { readonly id: number; isDestroyed?(): boolean }
  readonly senderFrame?: {
    readonly parent: unknown | null
    readonly url: string
    readonly processId: number
    readonly routingId: number
    isDestroyed?(): boolean
  } | null
}

export interface AuthorizeSender {
  (e: SenderEventLike, o: SenderAuthOptions & { requireOwner: true }): OwnerSessionRef
  (e: SenderEventLike, o: SenderAuthOptions & { requireOwner: false }): null
}

export interface SenderAuthDeps<E extends SenderEventLike = SenderEventLike> {
  /** The existing main-window gate; throws on a wrong window or a non-main frame and records metrics. */
  assertMainWindow(event: E): void
  ownerSession: Pick<OwnerSessionAuthority, 'mint' | 'validate'>
  currentContextRevision(): number
  audit(event: 'ipc.refused', detail: AuditEventRecord): void
  now?(): number
}

export function createSenderAuthorizer<E extends SenderEventLike = SenderEventLike>(
  deps: SenderAuthDeps<E>
): AuthorizeSender {
  const now = deps.now ?? Date.now

  const authorize = (event: SenderEventLike, o: SenderAuthOptions): OwnerSessionRef | null => {
    const refuse = (reason: SenderRefusalReason): never => {
      try {
        deps.audit(
          'ipc.refused',
          AuditEventRecordSchema.parse({
            v: 1,
            event: 'ipc.refused',
            ownerKey: null,
            sessionId: null,
            surface: o.surface,
            outcome: 'refused',
            reason,
            privacyClass: 'P1',
            ts: now()
          })
        )
      } catch {
        // an audit failure never changes the refusal
      }
      throw new SenderRefusal(reason, o.surface)
    }

    const frame = event.senderFrame
    let reason: SenderRefusalReason | null = null
    if (event.sender.isDestroyed?.() === true || !frame || frame.isDestroyed?.() === true) reason = 'destroyed'
    else if (frame.parent !== null) reason = 'subframe'

    if (o.allowedFrames === 'main-window-top') {
      try {
        deps.assertMainWindow(event as E)
      } catch {
        return refuse(reason ?? 'wrong-window')
      }
    } else {
      // No consumer exists yet for 'main-window-any' or 'overlay-top': fail closed until one is wired.
      return refuse('wrong-window')
    }
    if (reason !== null) return refuse(reason)
    if (!frame) return refuse('destroyed')
    if (!o.requireOwner) return null

    const ref = deps.ownerSession.mint(frame, deps.currentContextRevision())
    if (!ref) return refuse('signed-out')
    const validation = deps.ownerSession.validate(ref, frame)
    if (!validation.ok) return refuse(validation.reason)
    return ref
  }

  return authorize as AuthorizeSender
}
