import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { IPC } from '@shared/ipc'
import { isSpeechCapturePurpose, type InputSessionContext, type TrustedInputOwner } from '@shared/input-session'
import type { OwnerSessionRef } from '@shared/contracts/owner-session'
import type { InputSessionAuthority } from '../input-session-authority'
import type { OwnerSessionAuthority } from '../lifecycle/owner-session-authority'
import type { AuthorizeSender } from './sender-auth'
import { createInputSessionHandlers } from '../input-session-ipc'

type ParseResult<T> = { success: true; data: T } | { success: false }

interface Schema<T> {
  safeParse(raw: unknown): ParseResult<T>
}

interface WindowLike {
  isDestroyed(): boolean
  isVisible(): boolean
  webContents: { getURL(): string }
}

type CommandMicAvailabilityLike = { ok: true } | { ok: false; reason: string }

/** Deliberately no mint-from-hardware here: only main's voice session may mint a hardware activation. */
interface ActivationAuthorityLike<Frame> {
  mint(frame: Frame): boolean
  hasPending(frame: Frame, kind?: 'click' | 'hardware' | 'hardware-dictation'): boolean
  consume(frame: Frame, kind?: 'click' | 'hardware' | 'hardware-dictation'): boolean
  revokeAll(): void
}

interface CommandSpeechCaptureLike<Samples> {
  start(owner: TrustedInputOwner, sessionId: string): { ok: boolean }
  frame(owner: TrustedInputOwner, sessionId: string, sequence: number, samples: Samples): { ok: boolean }
  finish(owner: TrustedInputOwner, sessionId: string, frameCount: number): Promise<{ ok: boolean }>
  cancel(owner: TrustedInputOwner, sessionId: string): { ok: boolean }
  cancelForLease(sessionId: string): void
}

interface InputCaptureIpcDependencies<Frame, Samples> {
  ipcMain: Pick<IpcMain, 'handle'>
  assertMainWindow: (event: IpcMainInvokeEvent) => void
  requireAuth: () => boolean
  inputSessionAuthority: InputSessionAuthority
  /** Absent on installs without an owner: admission is then unchanged. */
  ownerSession?: Pick<OwnerSessionAuthority, 'mint' | 'validate'>
  /** When present, the input-session handlers gate through it (audited refusals). */
  authorizeSender?: AuthorizeSender
  commandMicActivationAuthority: ActivationAuthorityLike<Frame>
  /** Read live: the main window is replaced when it is recreated. */
  getWin: () => WindowLike | null | undefined
  getCommandMicActivationLeaseId: () => string | null
  setCommandMicActivationLeaseId: (id: string | null) => void
  /** Read live: the command speech capture is assigned after registration. */
  getCommandSpeechCapture: () => CommandSpeechCaptureLike<Samples> | null | undefined
  currentInputSessionContext: () => InputSessionContext
  captureAuthSessionBoundary: () => () => boolean
  commandMicAvailability: () => CommandMicAvailabilityLike
  commandMicActivationFrameFromEvent: (event: IpcMainInvokeEvent) => Frame | null | undefined
  commandMicOwner: (frame: Frame, context: InputSessionContext) => unknown
  commandSpeechOwnerFromEvent: (event: IpcMainInvokeEvent) => TrustedInputOwner | null | undefined
  commandLeaseCurrentAndAllowed: (sessionId: string) => unknown
  armCommandMicLeaseTimeout: (sessionId: string, ms: number) => void
  clearCommandMicLeaseTimer: (sessionId: string) => void
  schemas: {
    inputSessionStop: Schema<{ sessionId: string }>
    commandSpeechStart: Schema<{ sessionId: string }>
    commandSpeechFrame: Schema<{ sessionId: string; sequence: number; samples: Samples }>
    commandSpeechFinish: Schema<{ sessionId: string; frameCount: number }>
    commandSpeechCancel: Schema<{ sessionId: string }>
  }
}

/** Input-session, command-mic and command-speech IPC registrations (moved verbatim from registerIpc). */
export function registerInputCaptureIpc<Frame, Samples>(deps: InputCaptureIpcDependencies<Frame, Samples>): void {
  const ownerRefs = new Map<string, OwnerSessionRef>()
  const gate = (event: IpcMainInvokeEvent): void => {
    if (deps.authorizeSender) {
      deps.authorizeSender(event, { surface: 'inputSession', requireOwner: false, allowedFrames: 'main-window-top' })
    } else {
      deps.assertMainWindow(event)
    }
  }
  const inputSessionHandlers = createInputSessionHandlers<IpcMainInvokeEvent>({
    authority: deps.inputSessionAuthority,
    assertMainWindow: (event) => gate(event),
    requireAuth: deps.requireAuth,
    isWindowVisible: () => {
      const win = deps.getWin()
      return Boolean(win && !win.isDestroyed() && win.isVisible())
    },
    currentMainUrl: () => {
      const win = deps.getWin()
      return win && !win.isDestroyed() ? win.webContents.getURL() : ''
    },
    currentContext: deps.currentInputSessionContext,
    captureAuthBoundary: deps.captureAuthSessionBoundary,
    authorizeCommandStart: (event, _owner, source, purpose) => {
      if (!deps.commandMicAvailability().ok) return false
      // Dictation has no panel button: only the held dictation chord can start it (G22).
      if (purpose === 'dictation' && source !== 'push-to-talk') return false
      const frame = deps.commandMicActivationFrameFromEvent(event)
      // A voice turn (push-to-talk) consumes only a grant main minted from the held chord; a dictation consumes
      // only the grant minted from the dictation chord; the panel's Start click consumes only its own click
      // grant. The three never substitute for each other.
      const kind = source !== 'push-to-talk' ? 'click' : purpose === 'dictation' ? 'hardware-dictation' : 'hardware'
      return (
        !!frame &&
        deps.commandMicOwner(frame, deps.currentInputSessionContext()) !== null &&
        deps.commandMicActivationAuthority.consume(frame, kind)
      )
    }
  })
  deps.ipcMain.handle(IPC.inputSessionContext, (event) => inputSessionHandlers.context(event))
  deps.ipcMain.handle(IPC.inputSessionStart, (event, request: unknown) => {
    const result = inputSessionHandlers.start(event, request)
    if (result.ok) {
      ownerRefs.clear()
      // Keep the rollback owner derived from the same trusted Electron event before mint can
      // reenter. The lease context is the one already admitted by inputSessionHandlers.start.
      const senderWebContentsId = event.sender.id
      const senderFrame = event.senderFrame
      const rollbackOwner: TrustedInputOwner | null = senderFrame
        ? Object.freeze({
            webContentsId: senderWebContentsId,
            frameId: `${senderFrame.processId}:${senderFrame.routingId}`,
            isTopFrame: senderFrame.parent === null,
            authSessionGeneration: result.lease.authSessionGeneration,
            contextRevision: result.lease.contextRevision
          })
        : null
      let ref: OwnerSessionRef | null | undefined
      if (senderFrame && deps.ownerSession) {
        try {
          ref = deps.ownerSession.mint(senderFrame, result.lease.contextRevision)
        } catch {
          if (deps.inputSessionAuthority.activeLease === result.lease) {
            if (!rollbackOwner) throw new Error('input-session-mint-rollback-invariant')
            const stopped = deps.inputSessionAuthority.stop(rollbackOwner, { sessionId: result.lease.sessionId })
            if (!stopped.ok && deps.inputSessionAuthority.activeLease === result.lease) {
              throw new Error('input-session-mint-rollback-invariant')
            }
          }
          return { ok: false, reason: 'stale_session' }
        }
      }
      if (ref) ownerRefs.set(result.lease.sessionId, ref)
    }
    if (result.ok && isSpeechCapturePurpose(result.lease.purpose)) {
      deps.setCommandMicActivationLeaseId(result.lease.sessionId)
      deps.armCommandMicLeaseTimeout(result.lease.sessionId, 15_000)
    }
    return result
  })
  deps.ipcMain.handle(IPC.inputSessionStop, (event, request: unknown) => {
    const result = inputSessionHandlers.stop(event, request)
    const parsed = deps.schemas.inputSessionStop.safeParse(request)
    if (result.ok && parsed.success) ownerRefs.delete(parsed.data.sessionId)
    if (result.ok && parsed.success && deps.getCommandMicActivationLeaseId() === parsed.data.sessionId) {
      deps.clearCommandMicLeaseTimer(parsed.data.sessionId)
      deps.setCommandMicActivationLeaseId(null)
      deps.getCommandSpeechCapture()?.cancelForLease(parsed.data.sessionId)
    }
    return result
  })
  deps.ipcMain.handle(IPC.inputSessionConfirm, (event, request: unknown) => {
    const rawId =
      typeof request === 'object' && request !== null ? (request as { sessionId?: unknown }).sessionId : null
    const confirmId = typeof rawId === 'string' ? rawId : null
    const storedRef = confirmId !== null ? ownerRefs.get(confirmId) : undefined
    if (confirmId !== null && storedRef && deps.ownerSession) {
      const frame = event.senderFrame
      // The ref stays stored: a refused lease remains refused until it is stopped or replaced.
      if (!frame || !deps.ownerSession.validate(storedRef, frame).ok) return false
    }
    const confirmed = inputSessionHandlers.confirm(event, request)
    const lease = deps.inputSessionAuthority.activeLease
    if (
      confirmed &&
      lease !== null &&
      isSpeechCapturePurpose(lease.purpose) &&
      lease.sessionId === deps.getCommandMicActivationLeaseId()
    ) {
      deps.armCommandMicLeaseTimeout(lease.sessionId, 15_000)
    }
    return confirmed
  })
  deps.ipcMain.handle(IPC.commandMicActivationObserved, (event) => {
    deps.assertMainWindow(event)
    const win = deps.getWin()
    if (
      !deps.commandMicAvailability().ok ||
      deps.inputSessionAuthority.isClosing ||
      !win ||
      win.isDestroyed() ||
      !win.isVisible()
    )
      return false
    const frame = deps.commandMicActivationFrameFromEvent(event)
    return frame ? deps.commandMicActivationAuthority.mint(frame) : false
  })
  deps.ipcMain.handle(IPC.commandMicActivationReady, (event) => {
    deps.assertMainWindow(event)
    const win = deps.getWin()
    if (
      !deps.commandMicAvailability().ok ||
      deps.inputSessionAuthority.isClosing ||
      !win ||
      win.isDestroyed() ||
      !win.isVisible()
    )
      return false
    const frame = deps.commandMicActivationFrameFromEvent(event)
    return frame ? deps.commandMicActivationAuthority.hasPending(frame) : false
  })
  deps.ipcMain.handle(IPC.commandMicActivationCancel, (event) => {
    deps.assertMainWindow(event)
    const frame = deps.commandMicActivationFrameFromEvent(event)
    if (!frame || !deps.commandMicActivationAuthority.hasPending(frame)) return false
    deps.commandMicActivationAuthority.revokeAll()
    return true
  })
  deps.ipcMain.handle(IPC.commandMicAvailability, (event) => {
    deps.assertMainWindow(event)
    return deps.commandMicAvailability()
  })
  deps.ipcMain.handle(IPC.commandSpeechStart, (event, raw: unknown) => {
    deps.assertMainWindow(event)
    const win = deps.getWin()
    const parsed = deps.schemas.commandSpeechStart.safeParse(raw)
    const owner = deps.commandSpeechOwnerFromEvent(event)
    if (!parsed.success || !owner || !deps.requireAuth() || !win || win.isDestroyed() || !win.isVisible()) {
      return { ok: false, reason: 'stale' }
    }
    const availability = deps.commandMicAvailability()
    if (!availability.ok)
      return availability.reason === 'unauthorized'
        ? { ok: false, reason: 'stale' }
        : { ok: false, reason: availability.reason }
    if (
      deps.getCommandMicActivationLeaseId() !== parsed.data.sessionId ||
      !deps.inputSessionAuthority.isEstablishedLease(owner, parsed.data.sessionId, 'speech')
    )
      return { ok: false, reason: 'stale' }
    const result = deps.getCommandSpeechCapture()?.start(owner, parsed.data.sessionId) ?? {
      ok: false as const,
      reason: 'stale' as const
    }
    if (result.ok) deps.clearCommandMicLeaseTimer(parsed.data.sessionId)
    return result
  })
  deps.ipcMain.handle(IPC.commandSpeechFrame, (event, raw: unknown) => {
    deps.assertMainWindow(event)
    const win = deps.getWin()
    const parsed = deps.schemas.commandSpeechFrame.safeParse(raw)
    const owner = deps.commandSpeechOwnerFromEvent(event)
    if (
      !parsed.success ||
      !owner ||
      !deps.requireAuth() ||
      !win ||
      win.isDestroyed() ||
      !win.isVisible() ||
      deps.getCommandMicActivationLeaseId() !== parsed.data.sessionId
    )
      return { ok: false, reason: 'stale' }
    const availability = deps.commandMicAvailability()
    if (!availability.ok) {
      deps.commandLeaseCurrentAndAllowed(parsed.data.sessionId)
      return availability.reason === 'unauthorized'
        ? { ok: false, reason: 'stale' }
        : { ok: false, reason: availability.reason }
    }
    return (
      deps
        .getCommandSpeechCapture()
        ?.frame(owner, parsed.data.sessionId, parsed.data.sequence, parsed.data.samples) ?? {
        ok: false,
        reason: 'stale'
      }
    )
  })
  deps.ipcMain.handle(IPC.commandSpeechFinish, async (event, raw: unknown) => {
    deps.assertMainWindow(event)
    const win = deps.getWin()
    const parsed = deps.schemas.commandSpeechFinish.safeParse(raw)
    const owner = deps.commandSpeechOwnerFromEvent(event)
    if (
      !parsed.success ||
      !owner ||
      !deps.requireAuth() ||
      !win ||
      win.isDestroyed() ||
      !win.isVisible() ||
      deps.getCommandMicActivationLeaseId() !== parsed.data.sessionId
    )
      return { ok: false, reason: 'stale' }
    const availability = deps.commandMicAvailability()
    if (!availability.ok) {
      deps.commandLeaseCurrentAndAllowed(parsed.data.sessionId)
      return availability.reason === 'unauthorized'
        ? { ok: false, reason: 'stale' }
        : { ok: false, reason: availability.reason }
    }
    return (
      (await deps.getCommandSpeechCapture()?.finish(owner, parsed.data.sessionId, parsed.data.frameCount)) ?? {
        ok: false,
        reason: 'stale'
      }
    )
  })
  deps.ipcMain.handle(IPC.commandSpeechCancel, (event, raw: unknown) => {
    deps.assertMainWindow(event)
    const parsed = deps.schemas.commandSpeechCancel.safeParse(raw)
    const owner = deps.commandSpeechOwnerFromEvent(event)
    if (!parsed.success || !owner) return { ok: false, reason: 'stale' }
    return deps.getCommandSpeechCapture()?.cancel(owner, parsed.data.sessionId) ?? { ok: false, reason: 'stale' }
  })
}
