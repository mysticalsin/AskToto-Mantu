import type { IpcMain } from 'electron'
import type { CloudSpeechEvent } from '@shared/cloud-speech'
import type { OwnerSessionRef, OwnerSessionRevokeReason } from '@shared/contracts/owner-session'
import type { OwnerSessionAuthority } from '../../lifecycle/owner-session-authority'
import { registerSessionLedgerIpc } from '../../ipc/register-session-ledger'
import type { AuthorizeSender } from '../../ipc/sender-auth'
import {
  createMeetingContextRegistry,
  createMeetingScopeResolver,
  type MeetingContextRegistry,
  type MeetingContextRegistryDeps,
  type QueueHealthSink
} from './meeting-context-registry'

/**
 * The permission set a meeting's SessionContext carries. Reading the screen is a permission: turning Private View on
 * removes it, which changes the fingerprint and makes every snapshot taken before the switch stale.
 */
export function meetingPermissions(privateView: boolean): readonly string[] {
  return privateView ? ['transcript.read'] : ['screen.read', 'transcript.read']
}

export interface MeetingContextsDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  authorizeSender: AuthorizeSender
  requireAuth(): boolean
  ownerSession: Pick<OwnerSessionAuthority, 'current' | 'mint'> & {
    onRevoked(cb: (ref: OwnerSessionRef, reason: OwnerSessionRevokeReason) => void): () => void
  }
  contextRevision(): number
  privateView(): boolean
  /** True only while sign-in is not configured at all (an unconfigured build); a signed-out configured app holds nothing. */
  unsignedAllowed(): boolean
  /** Fires synchronously when a meeting's draft is finalized (saved, kept or discarded): the meeting is over. */
  onMeetingEnd(listener: (startedAt: number) => void): () => void
  /** Metadata-only ledger refusal code. */
  onDegraded(code: string): void
  /**
   * G15: tells the renderer frame that owns a meeting which of its already-delivered outputs a corrected line outdated.
   * Ids only, never text. A throwing sender is contained by the registry.
   */
  sendOutputsStale?(frame: { processId: number; routingId: number }, outputIds: readonly string[]): void
  /** G73: an applied final or retraction, for the live translation channel. Text is meeting content; never log it. */
  onUtterance?: MeetingContextRegistryDeps['onUtterance']
  /** G12 queue-health recorder (`queue_wait_ms`, `queue_depth_peak`). Typed seam: absent until G12 lands here. */
  queueHealth?: QueueHealthSink
}

/** What delivered speech must name: the frame that owns the capture and the meeting it is part of. */
export interface DeliveredSpeechOwner {
  readonly binding: { readonly processId: number; readonly routingId: number }
  readonly captureContext: { readonly listenStartedAt: number } | null
}

export interface MeetingContexts {
  readonly registry: MeetingContextRegistry
  /** Delivered relay speech: finals feed the ledger. Never throws into the delivery path. */
  onSegmentDelivered(owner: DeliveredSpeechOwner, event: CloudSpeechEvent): void
}

/**
 * Builds the main-owned transcript ledger and SessionContext registry, feeds it from delivered relay speech and from
 * renderer-committed local lines, and ends a meeting's context when the meeting ends or its owner session is revoked.
 * The disposers are discarded on purpose: these bindings live for the app lifetime.
 */
export function bindMeetingContexts(deps: MeetingContextsDeps): MeetingContexts {
  const registry = createMeetingContextRegistry({
    resolveScope: createMeetingScopeResolver({
      ownerSession: deps.ownerSession,
      contextRevision: deps.contextRevision,
      unsignedAllowed: deps.unsignedAllowed
    }),
    permissions: () => meetingPermissions(deps.privateView()),
    onDegraded: deps.onDegraded,
    queueHealth: deps.queueHealth,
    onUtterance: deps.onUtterance,
    onOutputsStale: (frame, outputIds) => deps.sendOutputsStale?.(frame, outputIds)
  })
  deps.ownerSession.onRevoked((ref) => registry.closeFrame(ref.frameOwner))
  deps.onMeetingEnd((startedAt) => registry.close(startedAt))
  registerSessionLedgerIpc({
    ipcMain: deps.ipcMain,
    authorizeSender: deps.authorizeSender,
    requireAuth: deps.requireAuth,
    registry
  })
  return {
    registry,
    onSegmentDelivered(owner, event) {
      try {
        if (owner.captureContext === null) return
        registry.ingestDelivered(
          { processId: owner.binding.processId, routingId: owner.binding.routingId },
          owner.captureContext.listenStartedAt,
          event
        )
      } catch {
        // the ledger never throws into the delivery path
      }
    }
  }
}
