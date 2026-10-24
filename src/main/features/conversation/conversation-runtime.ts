/** Main-process composition for G28 continuous conversation. The renderer transports PCM only; main recognizes it. */
import type { IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  CONVERSATION_IPC,
  ConversationAskSchema,
  ConversationCaptureBeginSchema,
  ConversationCaptureCancelSchema,
  ConversationCaptureFailureSchema,
  ConversationCaptureFinishSchema,
  ConversationCaptureFrameSchema,
  ConversationCaptureStartSchema,
  ConversationReplyCompleteSchema,
  ConversationSnapshotSchema,
  ConversationStartResultSchema,
  ConversationStopResultSchema,
  type ConversationCaptureBinding,
  type ConversationReason,
  type ConversationSnapshot
} from '@shared/conversation/conversation-session'
import { resolveConversationEnabled } from '@shared/conversation/conversation-options'
import { AskStartSchema, type AskStart } from '@shared/ipc'
import { resolveVoiceActionsEnabled, type VoiceActionsSettings } from '@shared/voice-actions-settings'
import type {
  InputSessionContext,
  InputSessionLease,
  InputSessionStopReason,
  TrustedInputOwner
} from '@shared/input-session'
import type { CommandMicAvailabilityResult } from '@shared/command-speech'
import {
  CommandSpeechCapture,
  COMMAND_SPEECH_FINALIZATION_GRACE_MS,
  COMMAND_SPEECH_SAMPLE_RATE,
  type CommandSpeechResult
} from '../../command-speech-capture'
import {
  CommandMicActivationAuthority,
  commandMicOwner,
  type CommandMicActivationFrame
} from '../../command-mic-activation-authority'
import type { InputSessionAuthority } from '../../input-session-authority'
import type { ReplyLifecycleEvent } from '../spoken-replies'
import type { AskTurnObservation } from '../session-context'
import {
  ConversationSession,
  type ConversationReplyToken,
  type ConversationUtteranceDispatch
} from './conversation-session'

interface WindowLike {
  isDestroyed(): boolean
  isVisible(): boolean
  webContents: { id: number; send(channel: string, payload: unknown): void }
}

interface CaptureWindow {
  readonly dispatch: ConversationUtteranceDispatch
  leaseId: string | null
  transcript: string | null
  finalizing: boolean
  acceptedMaxSeconds: number | null
  acceptedSamples: number
  timer: ReturnType<typeof setTimeout> | null
}

interface PendingReply {
  readonly owner: TrustedInputOwner
  readonly token: ConversationReplyToken
  readonly text: string
  timer: ReturnType<typeof setTimeout> | null
}

const tokenKey = (token: ConversationReplyToken): string => `${token.sessionId}\u0000${token.generation}`
const PENDING_ASK_TIMEOUT_MS = 4_000

function sameOwner(left: TrustedInputOwner, right: TrustedInputOwner | null | undefined): boolean {
  return Boolean(
    right &&
      left.webContentsId === right.webContentsId &&
      left.frameId === right.frameId &&
      left.isTopFrame === right.isTopFrame &&
      left.authSessionGeneration === right.authSessionGeneration &&
      left.contextRevision === right.contextRevision
  )
}

export interface ConversationRuntimeDeps {
  frameFromEvent(event: IpcMainInvokeEvent): CommandMicActivationFrame | null
  mainFrame(): CommandMicActivationFrame | null
  currentContext(): InputSessionContext
  getSettings(): { voiceActions?: VoiceActionsSettings }
  qaIdentity: boolean
  requireAuth(): boolean
  isClosing(): boolean
  meetingReserved(): boolean
  onboardingActive(): boolean
  window(): WindowLike | null | undefined
  availability(): CommandMicAvailabilityResult
  authority: InputSessionAuthority
  ensureParakeet(): Promise<void>
  transcribe(samples: Float32Array): Promise<string>
  /** The current Ask queue. A Stop cancels only the one ask bound to its own conversation token. */
  cancelAsk(id: string): void
  audit?(phase: 'started' | 'refused' | 'ended', detail?: { reason?: string }): void
}

/**
 * Owns the bridge between main's bounded session, one ordinary input lease and local Parakeet recognition.
 * No renderer-supplied transcript or identity can create a reply correlation.
 */
export function createConversationRuntime(deps: ConversationRuntimeDeps) {
  const windows = new Map<string, CaptureWindow>()
  const byLease = new Map<string, CaptureWindow>()
  const pendingReplies = new Map<string, PendingReply>()
  const askTokens = new Map<string, ConversationReplyToken>()
  const tokenAsks = new Map<string, string>()

  const enabled = (): boolean => {
    const stored = deps.getSettings().voiceActions
    return (
      resolveVoiceActionsEnabled(stored, { qaIdentity: deps.qaIdentity }) &&
      resolveConversationEnabled(stored?.conversation, { qaIdentity: deps.qaIdentity })
    )
  }
  const ownerNow = (): TrustedInputOwner | null => {
    const frame = deps.mainFrame()
    return frame ? commandMicOwner(frame, deps.currentContext()) : null
  }
  const ownerFromEvent = (event: IpcMainInvokeEvent): TrustedInputOwner | null => {
    const frame = deps.frameFromEvent(event)
    const current = deps.mainFrame()
    if (
      !frame ||
      !current ||
      frame.webContentsId !== current.webContentsId ||
      frame.frameId !== current.frameId ||
      frame.url !== current.url ||
      !frame.isTopFrame
    )
      return null
    return commandMicOwner(frame, deps.currentContext())
  }
  const currentWindow = (): WindowLike | null => {
    const win = deps.window()
    return win && !win.isDestroyed() ? win : null
  }
  const currentDispatch = (owner: TrustedInputOwner, binding: ConversationCaptureBinding): CaptureWindow | null => {
    const record = windows.get(binding.captureToken)
    if (
      !record ||
      record.dispatch.sessionId !== binding.sessionId ||
      !sameOwner(record.dispatch.owner, owner) ||
      !sameOwner(owner, ownerNow()) ||
      !session.isCurrentCapture(owner, binding.sessionId, binding.captureToken)
    )
      return null
    return record
  }
  const captureLeaseCurrent = (owner: TrustedInputOwner, record: CaptureWindow): boolean => {
    const leaseId = record.leaseId
    const lease = deps.authority.activeLease
    return Boolean(
      leaseId &&
        lease &&
        lease.sessionId === leaseId &&
        lease.purpose === 'conversation' &&
        lease.source === 'push-to-talk' &&
        lease.activation === 'explicit' &&
        !lease.actionAuthority &&
        sameOwner(owner, record.dispatch.owner) &&
        deps.authority.isEstablishedLease(owner, leaseId, 'conversation')
    )
  }
  const forgetWindow = (record: CaptureWindow): void => {
    windows.delete(record.dispatch.captureToken)
    if (record.timer) clearTimeout(record.timer)
    record.timer = null
    if (record.leaseId) byLease.delete(record.leaseId)
    record.transcript = null
  }
  const releaseLease = (record: CaptureWindow): void => {
    const leaseId = record.leaseId
    if (!leaseId || deps.authority.activeLease?.sessionId !== leaseId) return
    deps.authority.stop(record.dispatch.owner as TrustedInputOwner, { sessionId: leaseId })
  }
  const endWindow = (record: CaptureWindow, outcome: Parameters<ConversationUtteranceDispatch['onEnded']>[0]): void => {
    forgetWindow(record)
    record.dispatch.onEnded(outcome)
  }

  let session!: ConversationSession
  const notifyCaptureCancel = (record: CaptureWindow): void => {
    const win = currentWindow()
    if (!win) return
    try {
      win.webContents.send(CONVERSATION_IPC.captureCancel, {
        sessionId: record.dispatch.sessionId,
        captureToken: record.dispatch.captureToken
      })
    } catch {
      /* renderer teardown also stops its own tracks */
    }
  }
  const closeWindow = (
    record: CaptureWindow,
    outcome?: Parameters<ConversationUtteranceDispatch['onEnded']>[0],
    revokeLease = false,
    notifyRenderer = false
  ): void => {
    if (windows.get(record.dispatch.captureToken) !== record) return
    const leaseId = record.leaseId
    forgetWindow(record)
    if (leaseId) capture.cancelForLease(leaseId)
    if (notifyRenderer) notifyCaptureCancel(record)
    if (revokeLease && leaseId && deps.authority.activeLease?.sessionId === leaseId)
      deps.authority.hardStop('cancelled')
    if (outcome) record.dispatch.onEnded(outcome)
  }
  const clearPendingReply = (key: string): PendingReply | undefined => {
    const pending = pendingReplies.get(key)
    if (pending?.timer) clearTimeout(pending.timer)
    if (pending) pending.timer = null
    pendingReplies.delete(key)
    return pending
  }
  const expirePendingReply = (key: string, pending: PendingReply): void => {
    if (pendingReplies.get(key) !== pending) return
    clearPendingReply(key)
    const askId = tokenAsks.get(key)
    if (askId) {
      tokenAsks.delete(key)
      askTokens.delete(askId)
      try {
        deps.cancelAsk(askId)
      } catch {
        /* only this exact conversation ask is cancelled */
      }
    }
    if (session.isCurrentReply(pending.owner, pending.token)) session.replyFinished(pending.token)
  }

  const capture = new CommandSpeechCapture({
    isCurrent: (owner, leaseId) => {
      const record = byLease.get(leaseId)
      const win = currentWindow()
      const available = deps.availability()
      return Boolean(
        record &&
          win?.isVisible() &&
          deps.requireAuth() &&
          available.ok &&
          captureLeaseCurrent(owner, record) &&
          session.isCurrentCapture(owner, record.dispatch.sessionId, record.dispatch.captureToken)
      )
    },
    transcribe: async (samples) => {
      const leaseId = deps.authority.activeLease?.sessionId
      const record = leaseId ? byLease.get(leaseId) : undefined
      if (!leaseId || !record || !captureLeaseCurrent(record.dispatch.owner as TrustedInputOwner, record))
        throw new Error('conversation_capture_stale')
      const availability = deps.availability()
      if (!availability.ok) throw new Error('conversation_capture_unavailable')
      await deps.ensureParakeet()
      if (!captureLeaseCurrent(record.dispatch.owner as TrustedInputOwner, record))
        throw new Error('conversation_capture_stale')
      const text = (await deps.transcribe(samples)).trim()
      if (!text || text.length > 2_000) throw new Error('conversation_transcript_invalid')
      return text
    },
    ingestTranscript: (text) => {
      const leaseId = deps.authority.activeLease?.sessionId
      const record = leaseId ? byLease.get(leaseId) : undefined
      if (record && text.trim().length <= 2_000) record.transcript = text.trim()
    },
    onExpired: (leaseId) => {
      const record = byLease.get(leaseId)
      if (record) closeWindow(record, { kind: 'failed', reason: 'recognition_unavailable' }, true, true)
    },
    onFinished: (leaseId, result) => {
      const record = byLease.get(leaseId)
      if (!record) return
      if (!result.ok) {
        releaseLease(record)
        endWindow(
          record,
          result.reason === 'no_speech' ? { kind: 'silent' } : { kind: 'failed', reason: 'recognition_unavailable' }
        )
        return
      }
      const text = record.transcript
      const { dispatch } = record
      releaseLease(record)
      forgetWindow(record)
      if (!text) {
        dispatch.onEnded({ kind: 'silent' })
        return
      }
      dispatch.onEnded({ kind: 'recognized' })
      const token = session.currentReplyToken()
      if (!token || !session.replyPending(dispatch.owner as TrustedInputOwner, token)) return
      const key = tokenKey(token)
      const pending: PendingReply = { owner: dispatch.owner as TrustedInputOwner, token, text, timer: null }
      pendingReplies.set(key, pending)
      pending.timer = setTimeout(() => expirePendingReply(key, pending), PENDING_ASK_TIMEOUT_MS)
      const win = currentWindow()
      if (!win) {
        clearPendingReply(key)
        session.replyFinished(token)
        return
      }
      try {
        win.webContents.send(CONVERSATION_IPC.ask, {
          sessionId: token.sessionId,
          replyGeneration: token.generation,
          text
        })
      } catch {
        clearPendingReply(key)
        session.replyFinished(token)
      }
    }
  })

  const activation = new CommandMicActivationAuthority({
    state: () => {
      const frame = deps.mainFrame()
      const win = currentWindow()
      return {
        mainWebContentsId: frame?.webContentsId ?? null,
        mainFrameId: frame?.frameId ?? null,
        currentUrl: frame?.url ?? '',
        isWindowVisible: Boolean(win?.isVisible()),
        isAuthenticated: deps.requireAuth() && !deps.isClosing(),
        isParakeetSelected: deps.availability().ok,
        context: deps.currentContext()
      }
    }
  })

  const allowedToStart = (): boolean => {
    const win = currentWindow()
    return (
      enabled() &&
      deps.requireAuth() &&
      !deps.isClosing() &&
      !deps.meetingReserved() &&
      !deps.onboardingActive() &&
      Boolean(win?.isVisible()) &&
      deps.authority.activeLease === null &&
      deps.availability().ok
    )
  }

  session = new ConversationSession({
    owner: ownerNow,
    settings: () => ({ enabled: enabled() }),
    gate: {
      signedIn: deps.requireAuth,
      meetingReserved: deps.meetingReserved,
      onboardingActive: deps.onboardingActive,
      windowVisible: () => Boolean(currentWindow()?.isVisible()),
      captureBusy: () => deps.authority.activeLease !== null,
      availability: () => {
        const result = deps.availability()
        return result.ok ? { ok: true } : { ok: false, reason: result.reason }
      }
    },
    utterance: {
      begin(dispatch) {
        const win = currentWindow()
        if (!win?.isVisible()) return { ok: false, reason: 'window_hidden' }
        if (windows.size > 0) return { ok: false, reason: 'capture_busy' }
        const record: CaptureWindow = {
          dispatch,
          leaseId: null,
          transcript: null,
          finalizing: false,
          acceptedMaxSeconds: null,
          acceptedSamples: 0,
          timer: null
        }
        windows.set(dispatch.captureToken, record)
        try {
          win.webContents.send(CONVERSATION_IPC.captureBegin, {
            sessionId: dispatch.sessionId,
            captureToken: dispatch.captureToken,
            maxMs: dispatch.maxMs
          })
          return { ok: true }
        } catch {
          windows.delete(dispatch.captureToken)
          return { ok: false, reason: 'not_ready' }
        }
      },
      cancel(captureToken) {
        const record = windows.get(captureToken)
        if (!record) return
        closeWindow(record, undefined, true, true)
      }
    },
    reply: {
      cancel(token) {
        const id = tokenAsks.get(tokenKey(token))
        if (!id) return
        tokenAsks.delete(tokenKey(token))
        askTokens.delete(id)
        deps.cancelAsk(id)
      }
    },
    push: {
      state(snapshot) {
        const parsed = ConversationSnapshotSchema.safeParse(snapshot)
        const win = currentWindow()
        if (!parsed.success || !win) return
        try {
          win.webContents.send(CONVERSATION_IPC.state, parsed.data)
        } catch {
          /* getState recovers state */
        }
      }
    },
    newSessionId: randomUUID,
    now: Date.now,
    audit: deps.audit,
    onEnded(sessionId) {
      for (const [token, record] of windows) {
        if (record.dispatch.sessionId === sessionId) {
          closeWindow(record, undefined, true, true)
        }
      }
      for (const [key, pending] of pendingReplies) if (pending.token.sessionId === sessionId) clearPendingReply(key)
      for (const [id, token] of askTokens) {
        if (token.sessionId !== sessionId) continue
        askTokens.delete(id)
        tokenAsks.delete(tokenKey(token))
      }
    }
  })

  function authorizeCaptureStart(event: IpcMainInvokeEvent, owner: TrustedInputOwner, captureToken: string): boolean {
    const eventOwner = ownerFromEvent(event)
    const record = windows.get(captureToken)
    const parsed = ConversationCaptureBeginSchema.safeParse({
      sessionId: record?.dispatch.sessionId,
      captureToken,
      maxMs: record?.dispatch.maxMs
    })
    return Boolean(
      parsed.success &&
        eventOwner &&
        sameOwner(owner, eventOwner) &&
        sameOwner(owner, record?.dispatch.owner as TrustedInputOwner) &&
        record?.leaseId === null &&
        allowedToStart() &&
        session.isCurrentCapture(owner, parsed.data.sessionId, captureToken)
    )
  }

  function bindInputLease(owner: TrustedInputOwner, captureToken: string, lease: InputSessionLease): boolean {
    const record = windows.get(captureToken)
    if (
      !record ||
      record.leaseId !== null ||
      !sameOwner(owner, record.dispatch.owner as TrustedInputOwner) ||
      !session.isCurrentCapture(owner, record.dispatch.sessionId, captureToken) ||
      lease.purpose !== 'conversation' ||
      lease.source !== 'push-to-talk' ||
      lease.activation !== 'explicit' ||
      lease.actionAuthority ||
      lease.authSessionGeneration !== owner.authSessionGeneration ||
      lease.contextRevision !== owner.contextRevision
    )
      return false
    record.leaseId = lease.sessionId
    byLease.set(lease.sessionId, record)
    return true
  }

  function stopInputLease(sessionId: string): void {
    const record = byLease.get(sessionId)
    if (!record) return
    capture.cancelForLease(sessionId)
    notifyCaptureCancel(record)
    endWindow(record, { kind: 'cancelled' })
  }

  function currentCapture(
    event: IpcMainInvokeEvent,
    binding: ConversationCaptureBinding
  ): { owner: TrustedInputOwner; record: CaptureWindow } | null {
    const owner = ownerFromEvent(event)
    const record = owner ? currentDispatch(owner, binding) : null
    return owner && record && captureLeaseCurrent(owner, record) ? { owner, record } : null
  }

  // IPC registration lives in src/main/ipc/conversation-ipc.ts; each handler runs after assertMainWindow.
  const handlers = {
    startActivationObserved(event: IpcMainInvokeEvent) {
      const frame = deps.frameFromEvent(event)
      if (!frame || !allowedToStart()) return false
      return activation.mint(frame)
    },
    startActivationCancel(_event: IpcMainInvokeEvent) {
      activation.revokeAll()
      return true
    },
    start(event: IpcMainInvokeEvent) {
      const frame = deps.frameFromEvent(event)
      const owner = ownerFromEvent(event)
      const current = ownerNow()
      if (!frame || !owner || !sameOwner(owner, current) || !activation.consume(frame))
        return { ok: false, reason: 'policy_blocked' }
      return ConversationStartResultSchema.parse(session.start())
    },
    stop(event: IpcMainInvokeEvent) {
      const owner = ownerFromEvent(event)
      if (!owner || !sameOwner(owner, ownerNow())) return { ok: false }
      return ConversationStopResultSchema.parse(session.stop())
    },
    getState(event: IpcMainInvokeEvent) {
      const owner = ownerFromEvent(event)
      if (!owner || !sameOwner(owner, ownerNow())) return null
      session.refresh()
      return ConversationSnapshotSchema.parse(session.snapshot())
    },
    captureStart(event: IpcMainInvokeEvent, raw: unknown) {
      const parsed = ConversationCaptureStartSchema.safeParse(raw)
      if (!parsed.success) return { ok: false, reason: 'not_ready' }
      const current = currentCapture(event, parsed.data)
      if (!current) return { ok: false, reason: 'not_ready' }
      const availability = deps.availability()
      if (!availability.ok)
        return { ok: false, reason: availability.reason === 'unauthorized' ? 'not_ready' : availability.reason }
      const record = current.record
      if (parsed.data.maxSeconds * 1_000 > record.dispatch.maxMs || record.acceptedMaxSeconds !== null) {
        closeWindow(record, { kind: 'cancelled' }, true, true)
        return { ok: false, reason: 'invalid' }
      }
      const result = capture.start(current.owner, record.leaseId!)
      if (result.ok) {
        record.acceptedMaxSeconds = parsed.data.maxSeconds
        record.acceptedSamples = 0
        record.timer = setTimeout(
          () => closeWindow(record, { kind: 'cancelled' }, true, true),
          parsed.data.maxSeconds * 1_000 + COMMAND_SPEECH_FINALIZATION_GRACE_MS
        )
      }
      return result
    },
    captureFrame(event: IpcMainInvokeEvent, raw: unknown) {
      const parsed = ConversationCaptureFrameSchema.safeParse(raw)
      if (!parsed.success) return { ok: false, reason: 'not_ready' }
      const current = currentCapture(event, parsed.data)
      if (!current) return { ok: false, reason: 'not_ready' }
      const record = current.record
      const sampleLimit = (record.acceptedMaxSeconds ?? 0) * COMMAND_SPEECH_SAMPLE_RATE
      if (record.acceptedMaxSeconds === null || record.acceptedSamples + parsed.data.samples.length > sampleLimit) {
        closeWindow(record, { kind: 'cancelled' }, true, true)
        return { ok: false, reason: 'invalid' }
      }
      const result = capture.frame(current.owner, record.leaseId!, parsed.data.sequence, parsed.data.samples)
      if (result.ok) record.acceptedSamples += parsed.data.samples.length
      return result
    },
    async captureFinish(event: IpcMainInvokeEvent, raw: unknown) {
      const parsed = ConversationCaptureFinishSchema.safeParse(raw)
      if (!parsed.success) return { ok: false, reason: 'not_ready' }
      const current = currentCapture(event, parsed.data)
      if (!current || current.record.finalizing) return { ok: false, reason: 'not_ready' }
      if (current.record.timer) clearTimeout(current.record.timer)
      current.record.timer = null
      current.record.finalizing = true
      return capture.finish(current.owner, current.record.leaseId!, parsed.data.frameCount)
    },
    captureCancelRequest(event: IpcMainInvokeEvent, raw: unknown) {
      const parsed = ConversationCaptureCancelSchema.safeParse(raw)
      if (!parsed.success) return { ok: false, reason: 'not_ready' }
      const current = currentCapture(event, parsed.data)
      if (!current) return { ok: false, reason: 'not_ready' }
      const result = capture.cancel(current.owner, current.record.leaseId!)
      releaseLease(current.record)
      notifyCaptureCancel(current.record)
      endWindow(current.record, { kind: 'cancelled' })
      return result
    },
    captureFailure(event: IpcMainInvokeEvent, raw: unknown) {
      const parsed = ConversationCaptureFailureSchema.safeParse(raw)
      if (!parsed.success) return false
      const owner = ownerFromEvent(event)
      const record = owner ? currentDispatch(owner, parsed.data) : null
      if (!record || !sameOwner(owner!, record.dispatch.owner as TrustedInputOwner)) return false
      closeWindow(record, { kind: 'failed', reason: parsed.data.reason }, true, true)
      return true
    },
    replyFinished(event: IpcMainInvokeEvent, raw: unknown) {
      const parsed = ConversationReplyCompleteSchema.safeParse(raw)
      const owner = ownerFromEvent(event)
      if (!parsed.success || !owner) return false
      const token = { sessionId: parsed.data.sessionId, generation: parsed.data.replyGeneration }
      if (!session.isCurrentReply(owner, token) || askTokens.size > 0) return false
      session.replyFinished(token)
      clearPendingReply(tokenKey(token))
      return true
    }
  }

  function authorizeAsk(event: IpcMainInvokeEvent, request: AskStart): boolean {
    const owner = ownerFromEvent(event)
    if (!owner || !sameOwner(owner, ownerNow())) return false
    const duplicate = askTokens.has(request.id)
    if (!request.conversationReply) return !duplicate
    const token: ConversationReplyToken = {
      sessionId: request.conversationReply.sessionId,
      generation: request.conversationReply.replyGeneration
    }
    const key = tokenKey(token)
    const pending = pendingReplies.get(key)
    if (
      !pending ||
      duplicate ||
      !sameOwner(pending.owner, owner) ||
      !session.isCurrentReply(owner, token) ||
      request.mode !== 'answer' ||
      request.inputOrigin !== 'user-spoken-by-owner' ||
      request.prompt !== pending.text ||
      request.image !== undefined ||
      request.transcript !== undefined ||
      request.wantsScreenContext ||
      request.screenContext !== undefined ||
      request.agentOverride !== undefined ||
      request.providerOverride !== undefined
    )
      return false
    askTokens.set(request.id, token)
    tokenAsks.set(key, request.id)
    // This timeout only bounds delivery of the recognized Ask to main. Once
    // accepted, normal Ask lifecycle events own timeout/cancellation; synthesis
    // can legitimately take longer than the handoff window.
    if (pending.timer) clearTimeout(pending.timer)
    pending.timer = null
    return true
  }

  function failAsk(id: string): void {
    const token = askTokens.get(id)
    if (!token) return
    askTokens.delete(id)
    tokenAsks.delete(tokenKey(token))
    clearPendingReply(tokenKey(token))
    session.replyFinished(token)
  }

  function observeAsk(event: AskTurnObservation): void {
    if (event.type === 'cancel') failAsk(event.id)
    else if (event.type === 'event' && event.channel.endsWith(':error')) failAsk(event.id)
  }

  function onReplyLifecycle(event: ReplyLifecycleEvent): void {
    const token = askTokens.get(event.askId)
    if (!token) return
    if (event.phase === 'started') {
      clearPendingReply(tokenKey(token))
      session.replyStarted(token)
    } else if (event.phase === 'settled') {
      askTokens.delete(event.askId)
      tokenAsks.delete(tokenKey(token))
      clearPendingReply(tokenKey(token))
      session.replyFinished(token)
    }
  }

  function onHardStop(reason: InputSessionStopReason): void {
    session.onHardStop(reason)
  }
  function onMeetingReserved(): void {
    session.onMeetingReserved()
  }
  function onInputLeaseRevoked(
    owner: TrustedInputOwner,
    lease: InputSessionLease,
    _reason: InputSessionStopReason
  ): void {
    if (lease.purpose !== 'conversation') return
    const record = byLease.get(lease.sessionId)
    if (!record || !sameOwner(owner, record.dispatch.owner as TrustedInputOwner)) return
    capture.cancelForLease(lease.sessionId)
    notifyCaptureCancel(record)
    endWindow(record, { kind: 'cancelled' })
  }
  function refresh(): void {
    session.refresh()
  }
  function dispose(): void {
    session.dispose()
    capture.cancelAll()
    activation.revokeAll()
    for (const key of pendingReplies.keys()) clearPendingReply(key)
    askTokens.clear()
    tokenAsks.clear()
    windows.clear()
    byLease.clear()
  }

  return {
    handlers,
    session,
    capture,
    activation,
    refresh,
    dispose,
    ownerFromEvent,
    authorizeAsk,
    failAsk,
    observeAsk,
    onReplyLifecycle,
    onHardStop,
    onMeetingReserved,
    onInputLeaseRevoked,
    authorizeInputStart: authorizeCaptureStart,
    bindInputLease,
    stopInputLease
  }
}

export type ConversationIpcHandlers = ReturnType<typeof createConversationRuntime>['handlers']
