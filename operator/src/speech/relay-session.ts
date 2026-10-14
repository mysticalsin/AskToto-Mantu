import { hmacHex, timingSafeEqualHex } from '../hmac'
import { sha256Hex } from '../crypto'
import type { D1DatabaseLike } from '../d1'
import type { Env } from '../routes/admin-ctx'
import { resolveSpeechPolicy } from './policy'
import { resolveSpeechReadiness } from './readiness'
import {
  consumeSpeechGrantForRelay,
  confirmSpeechStreamClosed,
  markSpeechTransportAttempted,
  releaseSpeechStreamBeforeDial
} from './grants'
import {
  accountSpeechOutput,
  createSpeechStreamBudget,
  discardSpeechAudio,
  enqueueSpeechProviderFrame,
  enqueueSpeechAudio,
  finishSpeechProviderFrame,
  finishSpeechAudio,
  MAX_OUTPUT_FRAME_BYTES,
  SPEECH_DRAIN_WINDOW_MS,
  type SpeechStreamBudget
} from './limits'
import { normalizeSpeechProviderFrame, openSpeechUpstream, type SpeechTransportConfig } from './transport'
import { parseSpeechTrackDescriptor, type SpeechTrackDescriptor } from './contracts'

interface DOStorage {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  setAlarm?(time: number): Promise<void>
  getAlarm?(): Promise<number | null>
}
interface DurableState {
  storage: DOStorage
}
interface Attachment {
  role: 'client' | 'upstream'
  streamId: string
  sessionId: string
  routeEvidenceId: string
  captureGeneration: number
  streamEpoch: number
  track: 'microphone' | 'system'
  deadlineAt: number
  authorizedUntil: number
  budget: SpeechStreamBudget
  finishQueued: boolean
  finishRequested: boolean
  finishRequestedAt: number | null
  audioDrained: boolean
  providerCompleteAt: number | null
  upstreamErrorObserved: boolean
  stopRequested: boolean
  stopReason: SpeechTerminalReason | null
  stopDeadlineAt: number | null
  closeControlSent: boolean
  upstreamCloseRequested: boolean
  closeConfirmed: boolean
  lastSequence: number
  segmentStartMs: number
  segmentIndex: number
  segmentRevision: number
  segmentStates: Map<number, { index: number; revision: number; final: boolean }>
}
type SpeechTerminalReason =
  | 'normal'
  | 'cancelled'
  | 'lease-expired'
  | 'upstream-error'
  | 'client-disconnected'
  | 'limit'
  | 'revoked'
  | 'unknown'
interface SocketPairEndpoint extends WebSocket {
  accept?: () => void
}
declare const WebSocketPair: new () => { 0: SocketPairEndpoint; 1: SocketPairEndpoint }
interface OpenEnvelope {
  operation: 'open-track'
  descriptor: SpeechTrackDescriptor
  grant: string
  deviceId: string
  licenseJti: string
}
interface GrantRow {
  id: string
  session_id: string
  tenant_id: string
  audience: string
  license_jti: string
  device_id: string
  capture_generation: number
  track: 'microphone' | 'system'
  route_id: 'deepgram-via-gateway' | 'workers-ai-nova3'
  model_id: string
  config_version: string
  policy_version: string
  implementation_revision: string
  route_evidence_id: string
  language: string | null
  consent_issued_at: number
  consent_expires_at: number
  evidence_expires_at: number
  lease_expires_at: number
  license_expires_at: number
  grant_expires_at: number
  stream_epoch: number
}
type RelayEnv = Env & { SPEECH_UPSTREAM_FETCH?: typeof fetch }

const INTERNAL_TS = 'x-metis-speech-internal-ts'
const INTERNAL_SIG = 'x-metis-speech-internal-sig'
const INTERNAL_PAYLOAD = 'x-metis-speech-internal-payload'
const INTERNAL_MAX_AGE_MS = 10_000

function safeJson(value: unknown): string {
  return JSON.stringify(value)
}

function bytesOf(data: unknown): number {
  if (typeof data === 'string') return new TextEncoder().encode(data).byteLength
  if (data instanceof ArrayBuffer) return data.byteLength
  if (ArrayBuffer.isView(data)) return data.byteLength
  return Number.MAX_SAFE_INTEGER
}

function socketSend(socket: WebSocket, data: string | ArrayBuffer): boolean {
  try {
    socket.send(data)
    return true
  } catch {
    return false
  }
}

function closeSocket(socket: WebSocket | undefined, code = 1000): void {
  if (!socket) return
  try {
    socket.close(code, 'speech session ended')
  } catch {
    /* close is only a request; the close event is authoritative */
  }
}

function pair(): { client: WebSocket; server: SocketPairEndpoint } {
  const value = new WebSocketPair()
  return { client: value[0], server: value[1] }
}

export class SpeechSessionDurableObject {
  private readonly state: DurableState
  private readonly env: RelayEnv
  private readonly liveStreams = new Map<string, Omit<Attachment, 'role'>>()
  private readonly socketBindings = new WeakMap<WebSocket, { streamId: string; role: Attachment['role'] }>()
  private readonly runtimeSockets = new Map<string, Set<WebSocket>>()
  private readonly streamTails = new Map<string, Promise<void>>()

  constructor(state: DurableState, env: RelayEnv) {
    this.state = state
    this.env = env
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const isOpenUpgrade =
      url.pathname === '/open' &&
      request.method === 'GET' &&
      request.headers.get('upgrade')?.toLowerCase() === 'websocket' &&
      request.body === null
    const bodyText = isOpenUpgrade
      ? boundedHeaderText(request.headers.get(INTERNAL_PAYLOAD), 4_096)
      : await boundedText(request, 4_096)
    if (bodyText === null) return safeFailure(413)
    if (!(await this.verifyInternal(request, bodyText))) return safeFailure(401)
    if (url.pathname === '/open' && isOpenUpgrade) return this.open(bodyText)
    if (url.pathname === '/stop' && request.method === 'POST') return this.stop(bodyText)
    return safeFailure(404)
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = this.attachment(socket)
    if (!attachment) return closeSocket(socket, 1008)
    if (
      attachment.closeConfirmed ||
      attachment.upstreamErrorObserved ||
      (attachment.stopRequested && (attachment.role === 'client' || !this.leaseDrainActive(attachment)))
    )
      return
    if (attachment.role === 'client') {
      if (typeof message === 'string') {
        if (!isFinishControl(message) || attachment.finishQueued) return this.stopStream(attachment, 'limit')
        attachment.finishQueued = true
        this.updateAttachments(attachment)
        return this.enqueueStreamTask(attachment, () => this.finishTrack(attachment))
      }
      if (attachment.finishQueued || attachment.finishRequested) return
      const size = bytesOf(message)
      const decision = enqueueSpeechAudio(attachment.budget, size, Date.now())
      if (!decision.ok) return this.stopStream(attachment, 'limit')
      this.updateAttachments(attachment)
      return this.enqueueStreamTask(attachment, async () => {
        if (attachment.stopRequested || attachment.closeConfirmed) {
          discardSpeechAudio(attachment.budget, size)
          this.updateAttachments(attachment)
          return
        }
        if (!(await this.currentAuthority(attachment)) || attachment.stopRequested || attachment.closeConfirmed) {
          discardSpeechAudio(attachment.budget, size)
          this.updateAttachments(attachment)
          return this.stopStream(attachment, 'revoked')
        }
        const upstream = this.sockets(attachment.streamId).find((item) => this.attachment(item)?.role === 'upstream')
        if (!upstream) {
          discardSpeechAudio(attachment.budget, size)
          this.updateAttachments(attachment)
          return this.stopStream(attachment, 'unknown')
        }
        const forwarded = socketSend(upstream, message)
        finishSpeechAudio(attachment.budget, size)
        this.updateAttachments(attachment)
        if (!forwarded || !(await this.writeCounters(attachment))) return this.stopStream(attachment, 'unknown')
      })
    }
    if (typeof message === 'string' && message.length > MAX_OUTPUT_FRAME_BYTES)
      return this.stopStream(attachment, 'limit')
    const rawSize = bytesOf(message)
    const output = typeof message === 'string' ? normalizeSpeechProviderFrame(message) : null
    if (!output) return this.stopStream(attachment, 'upstream-error')
    if (attachment.closeConfirmed) return
    if (!enqueueSpeechProviderFrame(attachment.budget, rawSize).ok) return this.stopStream(attachment, 'limit')
    return this.enqueueStreamTask(
      attachment,
      async () => {
        if (output.type === 'provider-complete') {
          if (
            (!attachment.finishRequested && !this.leaseDrainActive(attachment)) ||
            (attachment.stopRequested && !this.leaseDrainActive(attachment))
          )
            return
          if (!(await this.currentAuthority(attachment, true)) || !this.providerOutputAllowed(attachment))
            return this.stopStream(attachment, 'revoked')
          const completedAt = Date.now()
          const result =
            (await this.env.DB?.prepare(`UPDATE speech_streams SET provider_complete_at = COALESCE(provider_complete_at, ?)
          WHERE id = ? AND (finish_requested_at IS NOT NULL OR terminal_reason = 'lease-expired')
            AND close_confirmed_at IS NULL`)
              .bind(completedAt, attachment.streamId)
              .run()) as { meta?: { changes?: number } } | undefined
          if (result?.meta?.changes !== 1) return this.stopStream(attachment, 'unknown')
          attachment.providerCompleteAt = completedAt
          this.updateAttachments(attachment)
          return
        }
        if (!(await this.currentAuthority(attachment, true)) || !this.providerOutputAllowed(attachment))
          return this.stopStream(attachment, 'revoked')
        if (output.type === 'transcript') {
          const prior = attachment.segmentStates.get(output.startMs)
          if (prior?.final) return
          const segment = prior ?? { index: attachment.segmentIndex + 1, revision: 0, final: false }
          segment.revision += 1
          segment.final = output.final
          attachment.segmentStates.set(output.startMs, segment)
          attachment.segmentStartMs = output.startMs
          attachment.segmentIndex = Math.max(attachment.segmentIndex, segment.index)
          attachment.segmentRevision = segment.revision
          attachment.lastSequence += 1
          const normalized = safeJson({
            type: 'transcript',
            protocolVersion: 1,
            sessionId: attachment.sessionId,
            captureGeneration: attachment.captureGeneration,
            track: attachment.track,
            streamEpoch: attachment.streamEpoch,
            sequence: attachment.lastSequence,
            segmentIndex: segment.index,
            revision: segment.revision,
            text: output.text,
            startMs: output.startMs,
            endMs: output.endMs,
            final: output.final,
            ...(output.languages ? { languages: output.languages } : {}),
            ...(output.words ? { words: output.words } : {})
          })
          const normalizedBytes = new TextEncoder().encode(normalized).byteLength
          if (!accountSpeechOutput(attachment.budget, normalizedBytes, false).ok)
            return this.stopStream(attachment, 'limit')
          this.updateAttachments(attachment)
          if (!(await this.writeCounters(attachment))) return this.stopStream(attachment, 'unknown')
          const client = this.sockets(attachment.streamId).find((item) => this.attachment(item)?.role === 'client')
          if (!client || !socketSend(client, normalized)) return this.stopStream(attachment, 'unknown')
        } else {
          const normalized = safeJson({
            type: 'error',
            protocolVersion: 1,
            sessionId: attachment.sessionId,
            captureGeneration: attachment.captureGeneration,
            track: attachment.track,
            streamEpoch: attachment.streamEpoch,
            code: 'UPSTREAM_UNAVAILABLE'
          })
          if (!accountSpeechOutput(attachment.budget, new TextEncoder().encode(normalized).byteLength, false).ok)
            return this.stopStream(attachment, 'limit')
          this.updateAttachments(attachment)
          if (!(await this.writeCounters(attachment))) return this.stopStream(attachment, 'unknown')
          const client = this.sockets(attachment.streamId).find((item) => this.attachment(item)?.role === 'client')
          if (!client || !socketSend(client, normalized)) return this.stopStream(attachment, 'unknown')
          return this.stopStream(attachment, 'upstream-error')
        }
      },
      () => {
        finishSpeechProviderFrame(attachment.budget, rawSize)
        this.updateAttachments(attachment)
      }
    )
  }

  async webSocketClose(socket: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    const attachment = this.attachment(socket)
    if (!attachment) return
    try {
      if (attachment.role === 'upstream') {
        await this.enqueueStreamTask(attachment, () => this.confirmClose(attachment, attachment.stopReason ?? 'normal'))
      } else if (!attachment.closeConfirmed) {
        await this.requestStop(attachment, 'client-disconnected')
      }
    } finally {
      this.removeSocket(socket, attachment.streamId)
    }
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    const attachment = this.attachment(socket)
    if (!attachment) return
    if (attachment.role !== 'upstream') return this.requestStop(attachment, 'unknown')
    if (attachment.upstreamErrorObserved || attachment.closeConfirmed) return
    attachment.upstreamErrorObserved = true
    this.updateAttachments(attachment)
    await this.enqueueStreamTask(attachment, async () => {
      if (!attachment.closeConfirmed) await this.requestStop(attachment, 'unknown')
    })
  }

  async alarm(): Promise<void> {
    const sockets = Array.from(this.runtimeSockets.values()).flatMap((items) => Array.from(items))
    let nextAlarmAt = Number.POSITIVE_INFINITY
    const seen = new Set<string>()
    for (const socket of sockets) {
      const attachment = this.attachment(socket)
      if (!attachment || seen.has(attachment.streamId)) continue
      seen.add(attachment.streamId)
      const now = Date.now()
      if (attachment.stopRequested) {
        if (
          attachment.stopDeadlineAt !== null &&
          now >= attachment.stopDeadlineAt &&
          !attachment.upstreamCloseRequested
        ) {
          const upstream = this.sockets(attachment.streamId).find((item) => this.attachment(item)?.role === 'upstream')
          attachment.upstreamCloseRequested = true
          this.updateAttachments(attachment)
          closeSocket(upstream, 1011)
        } else if (attachment.stopDeadlineAt !== null && now < attachment.stopDeadlineAt) {
          nextAlarmAt = Math.min(nextAlarmAt, now + 1_000, attachment.stopDeadlineAt)
        }
        continue
      }
      const audioDeadlineAt = attachment.deadlineAt - SPEECH_DRAIN_WINDOW_MS
      if (now >= audioDeadlineAt || !(await this.currentAuthority(attachment))) {
        await this.requestStop(attachment, now >= audioDeadlineAt ? 'lease-expired' : 'revoked')
        if (attachment.stopDeadlineAt !== null && attachment.stopDeadlineAt > now)
          nextAlarmAt = Math.min(nextAlarmAt, now + 1_000, attachment.stopDeadlineAt)
        continue
      }
      nextAlarmAt = Math.min(nextAlarmAt, now + 1_000, audioDeadlineAt)
    }
    if (Number.isFinite(nextAlarmAt)) await this.state.storage.setAlarm?.(nextAlarmAt)
  }

  private async verifyInternal(request: Request, body: string): Promise<boolean> {
    const secret = this.env.OPERATOR_INGEST_SECRET?.trim() ?? ''
    const tsText = request.headers.get(INTERNAL_TS) ?? ''
    const signature = request.headers.get(INTERNAL_SIG) ?? ''
    const ts = Number(tsText)
    if (
      !secret ||
      !/^\d{10,16}$/.test(tsText) ||
      !Number.isSafeInteger(ts) ||
      Math.abs(Date.now() - ts) > INTERNAL_MAX_AGE_MS ||
      !/^[a-f0-9]{64}$/.test(signature)
    )
      return false
    const expected = await hmacHex(secret, `${tsText}\n${body}`)
    return timingSafeEqualHex(expected, signature)
  }

  private async open(bodyText: string): Promise<Response> {
    let envelope: OpenEnvelope
    try {
      envelope = JSON.parse(bodyText) as OpenEnvelope
    } catch {
      return safeFailure(400)
    }
    const descriptor =
      envelope.descriptor && typeof envelope.descriptor === 'object'
        ? parseSpeechTrackDescriptor(JSON.stringify(envelope.descriptor))
        : null
    if (
      !envelope ||
      typeof envelope !== 'object' ||
      Array.isArray(envelope) ||
      Object.keys(envelope).sort().join(',') !== 'descriptor,deviceId,grant,licenseJti,operation' ||
      envelope.operation !== 'open-track' ||
      !descriptor ||
      !/^[A-Za-z0-9_-]{43}$/.test(envelope.grant) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(envelope.deviceId) ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(envelope.licenseJti)
    )
      return safeFailure(400)
    const db = this.env.DB
    if (!db) return safeFailure(503)
    const tokenHash = await sha256Hex(envelope.grant)
    let row: GrantRow | null
    try {
      row = await db
        .prepare(`SELECT g.id, g.session_id, g.tenant_id, g.audience, g.license_jti, g.device_id,
        g.capture_generation, g.track, g.route_id, g.model_id, g.config_version, g.stream_epoch,
        g.language, ss.policy_version, ss.implementation_revision, ss.route_evidence_id,
        ss.consent_issued_at, ss.consent_expires_at, ss.evidence_expires_at, ss.lease_expires_at,
        ss.license_expires_at, g.expires_at AS grant_expires_at
        FROM speech_grants g JOIN speech_sessions ss ON ss.id = g.session_id
        WHERE g.token_hash = ? AND g.session_id = ? AND g.track = ? AND g.capture_generation = ? AND g.stream_epoch = ?
          AND g.device_id = ? AND g.license_jti = ? AND g.revoked_at IS NULL AND g.redeemed_at IS NULL`)
        .bind(
          tokenHash,
          descriptor.sessionId,
          descriptor.track,
          descriptor.captureGeneration,
          descriptor.streamEpoch,
          envelope.deviceId,
          envelope.licenseJti
        )
        .first<GrantRow>()
    } catch {
      return safeFailure(503)
    }
    if (
      !row ||
      row.tenant_id !== this.env.SPEECH_TENANT_ID ||
      row.audience !== this.env.SPEECH_AUDIENCE ||
      row.route_id !== this.env.SPEECH_ROUTE_ID ||
      row.model_id !== this.env.SPEECH_MODEL_ID ||
      row.config_version !== this.env.SPEECH_CONFIG_VERSION ||
      descriptor.grantDigest !== tokenHash ||
      row.consent_issued_at > Date.now() ||
      row.consent_expires_at <= Date.now() ||
      row.evidence_expires_at <= Date.now() ||
      row.lease_expires_at <= Date.now() ||
      row.license_expires_at <= Date.now() ||
      row.grant_expires_at <= Date.now()
    )
      return safeFailure(403)
    const readiness = await resolveSpeechReadiness({ db, env: this.env, now: Date.now() })
    if (!readiness.ok || readiness.evidenceId !== row.route_evidence_id) return safeFailure(403)
    const policy = resolveSpeechPolicy(this.env, readiness.evidence)
    if (!policy.ok) return safeFailure(403)
    const sourceDeadline = Math.min(
      row.lease_expires_at,
      row.license_expires_at,
      row.evidence_expires_at,
      row.consent_expires_at
    )
    const provisionalDeadline = Math.min(Date.now() + 60_000, sourceDeadline)
    if (provisionalDeadline <= Date.now()) return safeFailure(403)
    const binding = {
      tenantId: row.tenant_id,
      audience: row.audience,
      licenseJti: row.license_jti,
      deviceId: row.device_id,
      sessionId: row.session_id,
      captureGeneration: row.capture_generation,
      routeId: row.route_id,
      model: row.model_id,
      configVersion: row.config_version,
      language: row.language ?? undefined,
      track: row.track,
      now: Date.now(),
      streamEpoch: descriptor.streamEpoch,
      policyVersion: row.policy_version,
      implementationRevision: row.implementation_revision,
      routeEvidenceId: row.route_evidence_id
    } as const
    const consumed = await consumeSpeechGrantForRelay(db, envelope.grant, binding)
    if (!consumed.ok) return safeFailure(consumed.code === 'DATABASE_UNAVAILABLE' ? 503 : 403)
    const provisional = {
      streamId: consumed.streamId,
      sessionId: row.session_id,
      routeEvidenceId: row.route_evidence_id,
      captureGeneration: row.capture_generation,
      streamEpoch: descriptor.streamEpoch,
      track: row.track,
      deadlineAt: provisionalDeadline,
      authorizedUntil: 0,
      budget: createSpeechStreamBudget(Date.now(), provisionalDeadline),
      finishQueued: false,
      finishRequested: false,
      finishRequestedAt: null,
      audioDrained: false,
      providerCompleteAt: null,
      upstreamErrorObserved: false,
      stopRequested: false,
      stopReason: null,
      stopDeadlineAt: null,
      closeControlSent: false,
      upstreamCloseRequested: false,
      closeConfirmed: false,
      lastSequence: 0,
      segmentStartMs: -1,
      segmentIndex: 0,
      segmentRevision: 0,
      segmentStates: new Map(),
      role: 'client' as const
    }
    if (!(await this.currentAuthority(provisional))) {
      await releaseSpeechStreamBeforeDial(db, consumed.streamId, Date.now())
      return safeFailure(403)
    }
    const config: SpeechTransportConfig = {
      accountId: this.env.CF_ACCOUNT_ID ?? '',
      gatewayId: this.env.SPEECH_GATEWAY_ID ?? '',
      routeId: row.route_id,
      modelId: row.model_id,
      configVersion: row.config_version,
      allowedLanguages: policy.policy.allowedLanguages,
      language: row.language ?? undefined,
      gatewayRunToken: this.env.SPEECH_GATEWAY_RUN_TOKEN ?? '',
      deepgramApiKey: this.env.SPEECH_DEEPGRAM_API_KEY
    }
    const dialRemaining = provisionalDeadline - Date.now()
    if (dialRemaining < 100 || !(await this.currentAuthority(provisional)) || Date.now() >= provisionalDeadline) {
      await releaseSpeechStreamBeforeDial(db, consumed.streamId, Date.now())
      return safeFailure(403)
    }
    if (!(await markSpeechTransportAttempted(db, consumed.streamId, { ...binding, now: Date.now() }))) {
      await releaseSpeechStreamBeforeDial(db, consumed.streamId, Date.now())
      return safeFailure(403)
    }
    if (Date.now() >= provisionalDeadline) return safeFailure(403)
    const opened = await openSpeechUpstream(
      config,
      this.env.SPEECH_UPSTREAM_FETCH ?? fetch,
      Math.max(100, Math.min(5_000, provisionalDeadline - Date.now()))
    )
    if (!opened.ok) {
      if (opened.definitelyClosed) {
        await confirmSpeechStreamClosed(db, consumed.streamId, Date.now(), 'upstream-error', {
          inputBytes: 0,
          inputMessages: 0,
          outputBytes: 0,
          outputMessages: 0
        })
      }
      // Failed/ambiguous fetches remain charged and hold concurrency until reviewed reconciliation.
      return safeFailure(502)
    }
    const { client, server } = pair()
    if (
      Date.now() >= provisionalDeadline ||
      !(await this.currentAuthority(provisional)) ||
      Date.now() >= provisionalDeadline
    ) {
      closeSocket(opened.socket, 1000)
      return safeFailure(403)
    }
    try {
      const accept = (opened.socket as SocketPairEndpoint).accept
      if (typeof accept !== 'function') throw new Error('ordinary WebSocket accept unavailable')
      accept.call(opened.socket)
    } catch {
      closeSocket(opened.socket, 1011)
      const now = Date.now()
      await db
        .prepare(`UPDATE speech_streams SET stop_requested_at = COALESCE(stop_requested_at, ?),
          terminal_reason = COALESCE(terminal_reason, 'unknown') WHERE id = ? AND close_confirmed_at IS NULL`)
        .bind(now, consumed.streamId)
        .run()
        .catch(() => undefined)
      await db
        .prepare(`UPDATE speech_sessions SET stop_requested_at = COALESCE(stop_requested_at, ?)
          WHERE id = ? AND status = 'active'`)
        .bind(now, row.session_id)
        .run()
        .catch(() => undefined)
      return safeFailure(502)
    }
    const deadlineAt = provisionalDeadline
    const budget = provisional.budget
    const common = {
      streamId: consumed.streamId,
      sessionId: row.session_id,
      routeEvidenceId: row.route_evidence_id,
      captureGeneration: row.capture_generation,
      streamEpoch: descriptor.streamEpoch,
      track: row.track,
      deadlineAt,
      authorizedUntil: provisional.authorizedUntil,
      budget,
      finishQueued: false,
      finishRequested: false,
      finishRequestedAt: null,
      audioDrained: false,
      providerCompleteAt: null,
      upstreamErrorObserved: false,
      stopRequested: false,
      stopReason: null,
      stopDeadlineAt: null,
      closeControlSent: false,
      upstreamCloseRequested: false,
      closeConfirmed: false,
      lastSequence: 0,
      segmentStartMs: -1,
      segmentIndex: 0,
      segmentRevision: 0,
      segmentStates: new Map<number, { index: number; revision: number; final: boolean }>()
    }
    this.liveStreams.set(consumed.streamId, common)
    opened.socket.binaryType = 'arraybuffer'
    server.binaryType = 'arraybuffer'
    this.bindSocket(server, consumed.streamId, 'client')
    this.bindSocket(opened.socket, consumed.streamId, 'upstream')
    const liveAttachment = this.attachment(server)
    if (!liveAttachment) {
      closeSocket(client, 1011)
      closeSocket(opened.socket, 1011)
      return safeFailure(502)
    }
    try {
      if (typeof server.accept !== 'function') throw new Error('WebSocketPair accept unavailable')
      server.accept()
    } catch {
      closeSocket(client, 1011)
      await this.requestStop(liveAttachment, 'unknown')
      return safeFailure(502)
    }
    try {
      const update = (await db
        .prepare(`UPDATE speech_streams SET opened_at = COALESCE(opened_at, ?)
        WHERE id = ? AND transport_attempted_at IS NOT NULL AND close_confirmed_at IS NULL
          AND EXISTS (SELECT 1 FROM speech_sessions WHERE id = speech_streams.session_id
            AND status = 'active' AND stop_requested_at IS NULL AND lease_expires_at > ?)`)
        .bind(Date.now(), consumed.streamId, Date.now())
        .run()) as { meta?: { changes?: number } }
      if (update.meta?.changes !== 1) {
        await this.requestStop(liveAttachment, 'revoked')
        return safeFailure(503)
      }
    } catch {
      await this.requestStop(liveAttachment, 'unknown')
      return safeFailure(503)
    }
    if (Date.now() >= deadlineAt || !(await this.currentAuthority(liveAttachment)) || Date.now() >= deadlineAt) {
      await this.requestStop(liveAttachment, 'revoked')
      return safeFailure(403)
    }
    const upgraded = new Response(null, { status: 101, webSocket: client } as ResponseInit & {
      webSocket: WebSocket
    }) as Response & { webSocket?: WebSocket }
    await this.state.storage.setAlarm?.(Math.min(Date.now() + 1_000, deadlineAt))
    return upgraded
  }

  private async stop(bodyText: string): Promise<Response> {
    let value: { operation?: string; sessionId?: string } | null
    try {
      value = JSON.parse(bodyText) as { operation?: string; sessionId?: string } | null
    } catch {
      return safeFailure(400)
    }
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      value.operation !== 'stop-session' ||
      !value.sessionId ||
      Object.keys(value).sort().join(',') !== 'operation,sessionId'
    )
      return safeFailure(400)
    const sockets = Array.from(this.runtimeSockets.values()).flatMap((items) => Array.from(items))
    for (const socket of sockets) {
      const attachment = this.attachment(socket)
      if (attachment?.sessionId === value.sessionId) await this.requestStop(attachment, 'cancelled')
    }
    return Response.json({ ok: true, requested: true })
  }

  private attachment(socket: WebSocket): Attachment | null {
    try {
      const binding = this.socketBindings.get(socket)
      if (!binding) return null
      let shared = this.liveStreams.get(binding.streamId)
      if (!shared) {
        return null
      }
      return new Proxy(shared as Attachment, {
        get(target, property, receiver) {
          return property === 'role' ? binding.role : Reflect.get(target, property, receiver)
        },
        set(target, property, value, receiver) {
          if (property === 'role') return false
          return Reflect.set(target, property, value, receiver)
        }
      })
    } catch {
      return null
    }
  }

  private sockets(streamId: string): WebSocket[] {
    return Array.from(this.runtimeSockets.get(streamId) ?? [])
  }

  private updateAttachments(source: Attachment): void {
    const shared = this.liveStreams.get(source.streamId)
    if (shared && shared !== source) Object.assign(shared, source)
  }

  private bindSocket(socket: WebSocket, streamId: string, role: Attachment['role']): void {
    this.socketBindings.set(socket, { streamId, role })
    let sockets = this.runtimeSockets.get(streamId)
    if (!sockets) {
      sockets = new Set()
      this.runtimeSockets.set(streamId, sockets)
    }
    sockets.add(socket)
    socket.addEventListener('message', (event) => {
      const data = event.data
      if (typeof data === 'string' || data instanceof ArrayBuffer) {
        void this.webSocketMessage(socket, data).catch(() => this.webSocketError(socket))
      } else {
        void this.webSocketError(socket)
      }
    })
    socket.addEventListener('close', (event) => {
      void this.webSocketClose(socket, event.code, event.reason, event.wasClean).catch(() =>
        this.webSocketError(socket)
      )
    })
    socket.addEventListener('error', () => void this.webSocketError(socket))
  }

  private removeSocket(socket: WebSocket, streamId: string): void {
    this.socketBindings.delete(socket)
    const sockets = this.runtimeSockets.get(streamId)
    sockets?.delete(socket)
    if (sockets?.size === 0) {
      this.runtimeSockets.delete(streamId)
      this.liveStreams.delete(streamId)
    }
  }

  private leaseDrainActive(attachment: Attachment): boolean {
    return (
      attachment.stopRequested &&
      attachment.stopReason === 'lease-expired' &&
      attachment.stopDeadlineAt !== null &&
      Date.now() < attachment.stopDeadlineAt
    )
  }

  private providerOutputAllowed(attachment: Attachment): boolean {
    return !attachment.closeConfirmed && (!attachment.stopRequested || this.leaseDrainActive(attachment))
  }

  private async currentAuthority(attachment: Attachment, allowLeaseDrain = false): Promise<boolean> {
    const checkedAt = Date.now()
    const draining = allowLeaseDrain && this.leaseDrainActive(attachment)
    if ((attachment.stopRequested && !draining) || attachment.closeConfirmed || checkedAt >= attachment.deadlineAt)
      return false
    if (checkedAt < attachment.authorizedUntil) return true
    const db = this.env.DB
    if (!db) return false
    try {
      const check = db
        .prepare(`SELECT 1 AS ok FROM speech_sessions ss
        JOIN speech_streams st ON st.session_id = ss.id
        JOIN issued_licenses il ON il.jti = ss.license_jti JOIN seats s ON s.device_id = ss.device_id
        JOIN speech_route_evidence e ON e.id = ss.route_evidence_id
        JOIN tiers t ON t.id = COALESCE(il.tier, 'metis')
        WHERE ss.id = ? AND st.id = ? AND ss.status = 'active'
          AND (ss.stop_requested_at IS NULL OR (? = 1 AND st.terminal_reason = 'lease-expired'
            AND ss.stop_requested_at IS NOT NULL AND ss.stop_requested_at <= ?))
          AND ss.tenant_id = ? AND ss.audience = ? AND ss.route_id = ? AND ss.model_id = ? AND ss.config_version = ?
          AND ss.policy_version = ? AND ss.implementation_revision = ? AND ss.route_evidence_id = ?
          AND st.tenant_id = ss.tenant_id AND st.audience = ss.audience AND st.license_jti = ss.license_jti
          AND st.device_id = ss.device_id AND st.capture_generation = ss.capture_generation
          AND ss.capture_generation = ? AND st.track = ? AND st.stream_epoch = ?
          AND st.route_id = ss.route_id AND st.model_id = ss.model_id AND st.config_version = ss.config_version
          AND st.policy_version = ss.policy_version AND st.implementation_revision = ss.implementation_revision
          AND ss.lease_expires_at > ? AND ss.license_expires_at > ? AND ss.consent_issued_at <= ?
          AND ss.consent_expires_at > ? AND ss.evidence_expires_at > ?
          AND il.revoked = 0 AND il.activated_device = ss.device_id AND il.exp * 1000 > ?
          AND s.license_jti = ss.license_jti AND LOWER(TRIM(COALESCE(s.approval, ''))) != 'revoked'
          AND e.tenant_id = ss.tenant_id AND e.audience = ss.audience AND e.route_id = ss.route_id
          AND e.model_id = ss.model_id AND e.config_version = ss.config_version
          AND e.policy_version = ss.policy_version AND e.implementation_revision = ss.implementation_revision
          AND e.revoked_at IS NULL AND e.expires_at > ?
          AND CASE WHEN json_valid(ss.consented_tracks_json) = 1 THEN CASE WHEN json_type(ss.consented_tracks_json) = 'array'
            THEN json_array_length(ss.consented_tracks_json) = ss.track_count
              AND NOT EXISTS (SELECT 1 FROM json_each(ss.consented_tracks_json) WHERE type != 'text')
              AND EXISTS (SELECT 1 FROM json_each(ss.consented_tracks_json) WHERE value = st.track)
            ELSE 0 END ELSE 0 END = 1
          AND CASE WHEN json_valid(t.entitlements_json) = 1 THEN CASE WHEN json_type(t.entitlements_json) = 'array'
            THEN NOT EXISTS (SELECT 1 FROM json_each(t.entitlements_json) WHERE type != 'text')
              AND (SELECT COUNT(DISTINCT value) FROM json_each(t.entitlements_json) WHERE value IN ('listen','operator_keys')) = 2
            ELSE 0 END ELSE 0 END = 1`)
        .bind(
          attachment.sessionId,
          attachment.streamId,
          draining ? 1 : 0,
          attachment.stopDeadlineAt ?? checkedAt,
          this.env.SPEECH_TENANT_ID,
          this.env.SPEECH_AUDIENCE,
          this.env.SPEECH_ROUTE_ID,
          this.env.SPEECH_MODEL_ID,
          this.env.SPEECH_CONFIG_VERSION,
          this.env.SPEECH_POLICY_VERSION,
          this.env.SPEECH_IMPLEMENTATION_REVISION,
          attachment.routeEvidenceId,
          attachment.captureGeneration,
          attachment.track,
          attachment.streamEpoch,
          checkedAt,
          checkedAt,
          checkedAt,
          checkedAt,
          checkedAt,
          checkedAt,
          checkedAt
        )
        .first()
      let timeout: ReturnType<typeof setTimeout> | undefined
      const result = await Promise.race([
        check,
        new Promise<null>((resolve) => {
          timeout = setTimeout(() => resolve(null), 1_000)
        })
      ])
      if (timeout) clearTimeout(timeout)
      if (
        !result ||
        (attachment.stopRequested && !(allowLeaseDrain && this.leaseDrainActive(attachment))) ||
        attachment.closeConfirmed ||
        Date.now() >= attachment.deadlineAt ||
        Date.now() >= checkedAt + 1_000
      )
        return false
      attachment.authorizedUntil = Math.min(checkedAt + 1_000, attachment.deadlineAt)
      this.updateAttachments(attachment)
      return true
    } catch {
      return false
    }
  }

  private enqueueStreamTask(attachment: Attachment, task: () => Promise<void>, after?: () => void): Promise<void> {
    const prior = this.streamTails.get(attachment.streamId) ?? Promise.resolve()
    let current: Promise<void>
    current = prior
      .then(async () => {
        try {
          await task()
        } finally {
          after?.()
        }
      })
      .catch(() => this.requestStop(attachment, 'unknown'))
      .finally(() => {
        if (this.streamTails.get(attachment.streamId) === current) this.streamTails.delete(attachment.streamId)
      })
    this.streamTails.set(attachment.streamId, current)
    return current
  }

  private async finishTrack(attachment: Attachment): Promise<void> {
    if (attachment.stopRequested || attachment.closeConfirmed || attachment.finishRequested) return
    if (!(await this.currentAuthority(attachment)) || attachment.stopRequested || attachment.closeConfirmed)
      return this.requestStop(attachment, 'revoked')
    const upstream = this.sockets(attachment.streamId).find((socket) => this.attachment(socket)?.role === 'upstream')
    if (!upstream) return this.requestStop(attachment, 'unknown')
    const now = Date.now()
    attachment.finishRequested = true
    attachment.audioDrained = true
    attachment.finishRequestedAt = now
    attachment.stopReason = 'normal'
    this.updateAttachments(attachment)
    try {
      const result =
        (await this.env.DB?.prepare(`UPDATE speech_streams SET finish_requested_at = COALESCE(finish_requested_at, ?)
        WHERE id = ? AND close_confirmed_at IS NULL AND stop_requested_at IS NULL
          AND EXISTS (SELECT 1 FROM speech_sessions WHERE id = speech_streams.session_id
            AND status = 'active' AND stop_requested_at IS NULL AND lease_expires_at > ?)`)
          .bind(now, attachment.streamId, now)
          .run()) as { meta?: { changes?: number } } | undefined
      if (result?.meta?.changes !== 1) return this.requestStop(attachment, 'revoked')
    } catch {
      return this.requestStop(attachment, 'unknown')
    }
    attachment.closeControlSent = true
    this.updateAttachments(attachment)
    if (!socketSend(upstream, JSON.stringify({ type: 'CloseStream' }))) return this.requestStop(attachment, 'unknown')
  }

  private async writeCounters(attachment: Attachment): Promise<boolean> {
    try {
      const result = (await this.env.DB?.prepare(`UPDATE speech_streams SET
          input_bytes = ?, input_messages = ?, output_bytes = ?, output_messages = ?, last_sequence = MAX(last_sequence, ?)
        WHERE id = ? AND close_confirmed_at IS NULL`)
        .bind(
          attachment.budget.inputBytes,
          attachment.budget.clientMessages,
          attachment.budget.outputBytes,
          attachment.budget.providerMessages,
          attachment.lastSequence,
          attachment.streamId
        )
        .run()) as { meta?: { changes?: number } } | undefined
      return result?.meta?.changes === 1
    } catch {
      return false
    }
  }

  private async stopStream(attachment: Attachment, reason: SpeechTerminalReason): Promise<void> {
    await this.requestStop(attachment, reason)
  }

  private async requestStop(attachment: Attachment, reason: SpeechTerminalReason): Promise<void> {
    if (attachment.closeConfirmed) return
    if (attachment.stopRequested) {
      if (attachment.stopReason === 'lease-expired' && reason !== 'lease-expired') {
        attachment.stopReason = reason
        attachment.stopDeadlineAt = Math.min(attachment.stopDeadlineAt ?? Date.now(), Date.now())
        this.updateAttachments(attachment)
        await this.env.DB?.prepare(`UPDATE speech_streams SET
            terminal_reason = CASE WHEN terminal_reason = 'lease-expired' THEN ? ELSE terminal_reason END
          WHERE id = ? AND close_confirmed_at IS NULL`)
          .bind(reason, attachment.streamId)
          .run()
          .catch(() => undefined)
        await this.state.storage.setAlarm?.(Date.now())
      }
      return
    }
    attachment.stopRequested = true
    attachment.stopReason = reason
    attachment.stopDeadlineAt = Math.min(attachment.deadlineAt, Date.now() + SPEECH_DRAIN_WINDOW_MS)
    this.updateAttachments(attachment)
    const now = Date.now()
    await this.env.DB?.prepare(`UPDATE speech_streams SET stop_requested_at = COALESCE(stop_requested_at, ?), terminal_reason = COALESCE(terminal_reason, ?)
      WHERE id = ? AND close_confirmed_at IS NULL`)
      .bind(now, reason, attachment.streamId)
      .run()
      .catch(() => undefined)
    await this.env.DB?.prepare(`UPDATE speech_sessions SET stop_requested_at = COALESCE(stop_requested_at, ?)
      WHERE id = ? AND status = 'active'`)
      .bind(now, attachment.sessionId)
      .run()
      .catch(() => undefined)
    const sockets = this.sockets(attachment.streamId)
    const upstream = sockets.find((socket) => this.attachment(socket)?.role === 'upstream')
    if (upstream && !attachment.closeControlSent) {
      attachment.closeControlSent = true
      this.updateAttachments(attachment)
      if (!socketSend(upstream, JSON.stringify({ type: 'CloseStream' }))) {
        attachment.upstreamCloseRequested = true
        this.updateAttachments(attachment)
        closeSocket(upstream, 1011)
      }
    }
    await this.state.storage.setAlarm?.(Math.min(Date.now() + 1_000, attachment.stopDeadlineAt))
  }

  private async confirmClose(attachment: Attachment, reason: SpeechTerminalReason): Promise<void> {
    if (attachment.closeConfirmed) return
    const now = Date.now()
    const effectiveReason = attachment.stopReason ?? reason
    const tailStatus =
      attachment.finishRequested && attachment.audioDrained && attachment.providerCompleteAt !== null
        ? 'complete'
        : 'incomplete'
    const terminal = safeJson({
      type: 'terminal',
      protocolVersion: 1,
      sessionId: attachment.sessionId,
      captureGeneration: attachment.captureGeneration,
      track: attachment.track,
      streamEpoch: attachment.streamEpoch,
      lastSequence: attachment.lastSequence,
      closeConfirmed: true,
      tail: tailStatus,
      reason: effectiveReason
    })
    const terminalBytes = new TextEncoder().encode(terminal).byteLength
    if (terminalBytes > 1_024) return
    const persisted = await confirmSpeechStreamClosed(this.env.DB, attachment.streamId, now, effectiveReason, {
      inputBytes: attachment.budget.inputBytes,
      inputMessages: attachment.budget.clientMessages,
      outputBytes: attachment.budget.outputBytes + terminalBytes,
      outputMessages: attachment.budget.providerMessages + 1,
      lastSequence: attachment.lastSequence,
      tailStatus,
      finishRequestedAt: attachment.finishRequestedAt,
      providerCompleteAt: attachment.providerCompleteAt
    })
    if (!persisted) return
    attachment.budget.outputBytes += terminalBytes
    attachment.closeConfirmed = true
    this.updateAttachments(attachment)
    const client = this.sockets(attachment.streamId).find((socket) => this.attachment(socket)?.role === 'client')
    if (client) socketSend(client, terminal)
    for (const socket of this.sockets(attachment.streamId)) closeSocket(socket)
  }
}

async function boundedText(request: Request, maxBytes: number): Promise<string | null> {
  const reader = request.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  let cancel = false
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maxBytes) {
        cancel = true
        return null
      }
      chunks.push(next.value)
    }
  } catch {
    cancel = true
    return null
  } finally {
    if (cancel) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

function safeFailure(status: number): Response {
  return Response.json(
    { ok: false, code: status === 503 ? 'DATABASE_UNAVAILABLE' : 'SPEECH_RELAY_REFUSED' },
    { status }
  )
}

function boundedHeaderText(value: string | null, maxBytes: number): string | null {
  if (value === null || value.length > maxBytes) return null
  const size = new TextEncoder().encode(value).byteLength
  return size <= maxBytes ? value : null
}

function isFinishControl(value: string): boolean {
  return value === '{"type":"finish"}'
}
