import type { OwnerSessionRevokeReason } from '@shared/contracts/owner-session'
import type { InputSessionStopReason } from '@shared/input-session'
import type { OwnerSessionAuthority } from '../../lifecycle/owner-session-authority'
import type { TranscriptRevisionStore } from './transcript-revision-store'

/** Structural subset of Electron WebContents needed to observe renderer resets (keeps electron out of this module). */
export interface RendererResetSource {
  on(event: 'render-process-gone', listener: () => void): unknown
  on(event: 'destroyed', listener: () => void): unknown
  on(
    event: 'did-start-navigation',
    listener: (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void
  ): unknown
}

export const STOP_REASON_FOR_REVOCATION: Readonly<Record<OwnerSessionRevokeReason, InputSessionStopReason>> =
  Object.freeze({
    'sign-out': 'sign-out',
    'auth-changed': 'auth-revoked',
    'renderer-reset': 'renderer-reset',
    'lock-screen': 'screen-locked',
    suspend: 'system-suspend',
    quit: 'shutdown'
  })

/** Closes the meetings of a revoked owner session. Never throws into the authority. */
export function bindOwnerRevocationClosure(
  ownerSession: Pick<OwnerSessionAuthority, 'onRevoked'>,
  store: Pick<TranscriptRevisionStore, 'closeOwnedBy'>
): () => void {
  return ownerSession.onRevoked((ref, reason) => {
    try {
      store.closeOwnedBy(ref.sessionId, STOP_REASON_FOR_REVOCATION[reason] ?? 'auth-revoked')
    } catch {
      // closure is best effort and never reaches the authority
    }
  })
}

/** Closes a meeting as it ends: its draft cleanup, keep or discard finalizes the meeting identity. The close makes
 *  the one closing checkpoint before the seal, so a kept draft carries the final revision. */
export function bindMeetingEndClosure(
  onFinalizing: (listener: (startedAt: number) => void) => () => void,
  store: Pick<TranscriptRevisionStore, 'close'>
): () => void {
  return onFinalizing((startedAt) => {
    try {
      store.close(startedAt, 'user-stop')
    } catch {
      // closure is best effort and never blocks the seal
    }
  })
}

/** Calls `onReset` when the renderer crashes, is destroyed, or navigates its main frame away. */
export function bindRendererResetClosure(contents: RendererResetSource, onReset: () => void): void {
  const reset = (): void => {
    try {
      onReset()
    } catch {
      // a reset callback never throws into the emitter
    }
  }
  contents.on('render-process-gone', reset)
  contents.on('destroyed', reset)
  contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame === true && isInPlace === false) reset()
  })
}
