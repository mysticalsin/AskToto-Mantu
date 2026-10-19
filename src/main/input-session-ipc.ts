import type { InputSessionAuthority } from './input-session-authority'
import {
  InputSessionContextSchema,
  InputSessionConfirmRequestSchema,
  InputSessionStartRequestSchema,
  InputSessionStopRequestSchema,
  type InputSessionContext,
  type InputSessionResult,
  type InputSessionStopResult,
  type TrustedInputOwner
} from '@shared/input-session'

interface FrameLike {
  readonly parent: unknown | null
  readonly url: string
  readonly processId: number
  readonly routingId: number
}

interface EventLike {
  readonly sender: { readonly id: number }
  readonly senderFrame?: FrameLike | null
}

interface Dependencies<Event extends EventLike> {
  readonly authority: InputSessionAuthority
  assertMainWindow(event: Event): void
  requireAuth(): boolean
  isWindowVisible(): boolean
  currentMainUrl(): string
  currentContext(): InputSessionContext
  captureAuthBoundary(): () => boolean
  authorizeCommandStart?(event: Event, owner: TrustedInputOwner): boolean
}

function ownerFromEvent(
  event: EventLike,
  currentMainUrl: string,
  context: InputSessionContext
): TrustedInputOwner | null {
  const frame = event.senderFrame
  if (
    !frame ||
    frame.parent !== null ||
    !currentMainUrl ||
    frame.url !== currentMainUrl ||
    !Number.isSafeInteger(frame.processId) ||
    !Number.isSafeInteger(frame.routingId)
  )
    return null
  return Object.freeze({
    webContentsId: event.sender.id,
    frameId: `${frame.processId}:${frame.routingId}`,
    isTopFrame: true,
    authSessionGeneration: context.authSessionGeneration,
    contextRevision: context.contextRevision
  })
}

/** Typed IPC adapters derive owner identity from the trusted Electron event, never request data. */
export function createInputSessionHandlers<Event extends EventLike>(dependencies: Dependencies<Event>) {
  return {
    context(event: Event): InputSessionContext | null {
      dependencies.assertMainWindow(event)
      if (!dependencies.isWindowVisible()) {
        dependencies.authority.hardStop('window-hidden')
        return null
      }
      const authorized = dependencies.requireAuth()
      const context = dependencies.currentContext()
      dependencies.authority.reconcileContext(context)
      if (!authorized) {
        dependencies.authority.hardStop('sign-out')
        return null
      }
      if (!dependencies.captureAuthBoundary()()) {
        dependencies.authority.hardStop('sign-out')
        return null
      }
      return context
    },
    start(event: Event, raw: unknown): InputSessionResult {
      dependencies.assertMainWindow(event)
      if (!dependencies.isWindowVisible()) {
        dependencies.authority.hardStop('window-hidden')
        return { ok: false, reason: 'window_hidden' }
      }
      const authorized = dependencies.requireAuth()
      const current = dependencies.currentContext()
      dependencies.authority.reconcileContext(current)
      if (!authorized) {
        dependencies.authority.hardStop('sign-out')
        return { ok: false, reason: 'unauthorized' }
      }
      const parsed = InputSessionStartRequestSchema.safeParse(raw)
      if (!parsed.success) return { ok: false, reason: 'invalid_request' }
      if (
        !InputSessionContextSchema.safeParse(parsed.data.context).success ||
        parsed.data.context.authSessionGeneration !== current.authSessionGeneration ||
        parsed.data.context.contextRevision !== current.contextRevision
      ) {
        return { ok: false, reason: 'stale_session' }
      }
      if (!dependencies.captureAuthBoundary()()) {
        dependencies.authority.hardStop('sign-out')
        return { ok: false, reason: 'stale_session' }
      }
      const owner = ownerFromEvent(event, dependencies.currentMainUrl(), current)
      if (!owner) return { ok: false, reason: 'unauthorized' }
      if (parsed.data.input.purpose === 'command' && !dependencies.authorizeCommandStart?.(event, owner)) {
        return { ok: false, reason: 'unauthorized' }
      }
      return dependencies.authority.start(owner, parsed.data.input)
    },
    stop(event: Event, raw: unknown): InputSessionStopResult {
      dependencies.assertMainWindow(event)
      const authorized = dependencies.requireAuth()
      const current = dependencies.currentContext()
      dependencies.authority.reconcileContext(current)
      if (!authorized) {
        dependencies.authority.hardStop('sign-out')
        return { ok: false, reason: 'unauthorized' }
      }
      const parsed = InputSessionStopRequestSchema.safeParse(raw)
      if (!parsed.success) return { ok: false, reason: 'invalid_request' }
      if (
        parsed.data.context.authSessionGeneration !== current.authSessionGeneration ||
        parsed.data.context.contextRevision !== current.contextRevision
      ) {
        return { ok: false, reason: 'stale_session' }
      }
      if (!dependencies.captureAuthBoundary()()) {
        dependencies.authority.hardStop('sign-out')
        return { ok: false, reason: 'stale_session' }
      }
      const owner = ownerFromEvent(event, dependencies.currentMainUrl(), current)
      if (!owner) return { ok: false, reason: 'unauthorized' }
      return dependencies.authority.stop(owner, { sessionId: parsed.data.sessionId })
    },
    confirm(event: Event, raw: unknown): boolean {
      dependencies.assertMainWindow(event)
      if (!dependencies.isWindowVisible()) return false
      const authorized = dependencies.requireAuth()
      const current = dependencies.currentContext()
      dependencies.authority.reconcileContext(current)
      if (!authorized) {
        dependencies.authority.hardStop('sign-out')
        return false
      }
      const parsed = InputSessionConfirmRequestSchema.safeParse(raw)
      if (
        !parsed.success ||
        parsed.data.context.authSessionGeneration !== current.authSessionGeneration ||
        parsed.data.context.contextRevision !== current.contextRevision
      )
        return false
      if (!dependencies.captureAuthBoundary()()) {
        dependencies.authority.hardStop('sign-out')
        return false
      }
      const owner = ownerFromEvent(event, dependencies.currentMainUrl(), current)
      return owner ? dependencies.authority.confirmCapture(owner, parsed.data.sessionId) : false
    }
  }
}
