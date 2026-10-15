import { createHash } from 'node:crypto'
import WebSocket from 'ws'
import { z } from 'zod'
import { parseOperatorLicense } from '../../shared/operator-license'
import { operatorHmacHeaders } from '../operator-hmac-sign'

export const SPEECH_BROKER_MAX_REQUEST_BYTES = 8_192
export const SPEECH_BROKER_MAX_RESPONSE_BYTES = 32 * 1024
export const SPEECH_BROKER_WS_MAX_PAYLOAD = 64 * 1024
export const SPEECH_BROKER_MAX_OWNER_OPERATION_MS = 2_000

const RouteSchema = z.enum(['deepgram-via-gateway', 'workers-ai-nova3'])
const ModelSchema = z.enum(['nova-3', '@cf/deepgram/nova-3'])
const TrackSchema = z.enum(['microphone', 'system'])
const LanguageSchema = z
  .string()
  .regex(/^(?:multi|[a-z]{2}(?:-[A-Z]{2})?)$/)
  .max(5)
const DeploymentVersionSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
const TimestampSchema = z.number().int().positive().safe()
const LimitsSchema = z
  .object({
    maxStreamMs: z.number().int().positive().safe(),
    drainWindowMs: z.number().int().positive().safe(),
    maxInputBytesPerTrack: z.number().int().positive().safe(),
    maxClientFrameBytes: z.number().int().positive().safe().max(SPEECH_BROKER_WS_MAX_PAYLOAD),
    maxOutputBytesPerTrack: z.number().int().positive().safe()
  })
  .strict()
const CreateLimitsSchema = LimitsSchema.extend({ audioDeadlineAt: TimestampSchema }).strict()
const RouteSelectionSchema = z.object({ routeId: RouteSchema, modelId: ModelSchema }).strict()

const ReadyCapabilitySchema = z
  .object({
    ok: z.literal(true),
    protocolVersion: z.literal(1),
    selected: RouteSelectionSchema,
    allowed: z.array(RouteSelectionSchema).min(1).max(2),
    ready: z.literal(true),
    routeId: RouteSchema,
    modelId: ModelSchema,
    configVersion: DeploymentVersionSchema,
    policyVersion: DeploymentVersionSchema,
    languages: z.array(LanguageSchema).min(1).max(32),
    format: z
      .object({ encoding: z.literal('pcm_s16le'), sampleRate: z.literal(16_000), channels: z.literal(1) })
      .strict(),
    validUntil: TimestampSchema,
    limits: LimitsSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.selected.routeId !== value.routeId || value.selected.modelId !== value.modelId)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['selected'] })
    if (!value.allowed.some((item) => item.routeId === value.routeId && item.modelId === value.modelId))
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['allowed'] })
    if (value.routeId === 'deepgram-via-gateway' && value.modelId !== 'nova-3')
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['modelId'] })
    if (value.routeId === 'workers-ai-nova3' && value.modelId !== '@cf/deepgram/nova-3')
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['modelId'] })
  })

const RefusedCapabilitySchema = z
  .object({
    ok: z.literal(true),
    protocolVersion: z.literal(1),
    selected: z.null(),
    allowed: z.array(z.never()).length(0),
    ready: z.literal(false),
    code: z.enum([
      'INVALID_REQUEST',
      'CONSENT_REQUIRED',
      'CONSENT_EXPIRED',
      'AUTH_REQUIRED',
      'NOT_AUTHORIZED',
      'POLICY_UNAVAILABLE',
      'ROUTE_NOT_READY',
      'PRIVACY_UNVERIFIED',
      'TRANSPORT_UNAVAILABLE',
      'DATABASE_UNAVAILABLE',
      'CONCURRENCY_LIMIT',
      'BUDGET_LIMIT',
      'SESSION_NOT_FOUND',
      'GRANT_REJECTED'
    ]),
    validUntil: TimestampSchema
  })
  .strict()
const CapabilitySchema = z.union([ReadyCapabilitySchema, RefusedCapabilitySchema])

const CreateRequestSchema = z
  .object({
    operation: z.literal('create-session'),
    captureGeneration: z.number().int().positive().safe(),
    tracks: z.array(TrackSchema).min(1).max(2),
    language: LanguageSchema.optional(),
    consent: z
      .object({
        accepted: z.literal(true),
        captureGeneration: z.number().int().positive().safe(),
        tracks: z.array(TrackSchema).min(1).max(2),
        issuedAt: TimestampSchema,
        expiresAt: TimestampSchema
      })
      .strict()
  })
  .strict()
  .superRefine((request, context) => {
    if (request.captureGeneration !== request.consent.captureGeneration)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['consent', 'captureGeneration'] })
    if (
      request.tracks.length !== request.consent.tracks.length ||
      request.tracks.some((track, index) => track !== request.consent.tracks[index])
    )
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['consent', 'tracks'] })
    if (new Set(request.tracks).size !== request.tracks.length)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['tracks'] })
  })

const GrantSchema = z
  .object({
    track: TrackSchema,
    streamEpoch: z.number().int().positive().safe(),
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
  })
  .strict()
const CreatedSessionSchema = z
  .object({
    ok: z.literal(true),
    protocolVersion: z.literal(1),
    sessionId: z.string().uuid(),
    routeId: RouteSchema,
    model: ModelSchema,
    configVersion: DeploymentVersionSchema,
    policyVersion: DeploymentVersionSchema,
    language: LanguageSchema,
    captureGeneration: z.number().int().positive().safe(),
    grantExpiresAt: TimestampSchema,
    leaseExpiresAt: TimestampSchema,
    limits: CreateLimitsSchema,
    grants: z.array(GrantSchema).min(1).max(2)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.routeId === 'deepgram-via-gateway' && value.model !== 'nova-3')
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['model'] })
    if (value.routeId === 'workers-ai-nova3' && value.model !== '@cf/deepgram/nova-3')
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['model'] })
    const grantTracks = value.grants.map((grant) => grant.track)
    if (new Set(grantTracks).size !== grantTracks.length)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['grants'] })
  })

const TrackStatusSchema = z
  .object({
    track: TrackSchema,
    streamEpoch: z.number().int().positive().safe(),
    phase: z.enum(['ready', 'opening', 'open', 'finishing', 'stopping', 'closed']),
    closeConfirmed: z.boolean(),
    tail: z.enum(['complete', 'incomplete']).nullable(),
    lastSequence: z.number().int().nonnegative().safe()
  })
  .strict()
const StatusSchema = z
  .object({
    ok: z.literal(true),
    protocolVersion: z.literal(1),
    sessionId: z.string().uuid(),
    captureGeneration: z.number().int().positive().safe(),
    status: z.enum(['active', 'cancelled', 'expired']),
    cancellationRequested: z.boolean(),
    tracks: z.array(TrackStatusSchema).min(1).max(2)
  })
  .strict()
const CancelSchema = z
  .object({
    ok: z.literal(true),
    protocolVersion: z.literal(1),
    sessionId: z.string().uuid(),
    cancelled: z.boolean(),
    cancellationRequested: z.boolean()
  })
  .strict()

export type SpeechTrack = z.infer<typeof TrackSchema>
export type SpeechCapability = z.infer<typeof CapabilitySchema>
export type ReadySpeechCapability = z.infer<typeof ReadyCapabilitySchema>
export type SpeechCreateRequest = z.input<typeof CreateRequestSchema>
export type CreatedSpeechSession = z.infer<typeof CreatedSessionSchema>
export type SpeechSessionStatus = z.infer<typeof StatusSchema>
export type BrokerFailureCode =
  | 'CONFIG'
  | 'AUTH'
  | 'TRANSPORT'
  | 'RESPONSE'
  | 'REFUSED'
  | 'SCHEMA'
  | 'WS_CONNECT'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'UNKNOWN_ALLOCATION'
export type BrokerResult<T> = { ok: true; value: T } | { ok: false; code: BrokerFailureCode }

export function normalizeSpeechOperatorOrigin(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (
      url.protocol !== 'https:' ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      return null
    return url.origin
  } catch {
    return null
  }
}

export type SpeechBrokerClientOptions = {
  operatorUrl: string
  operatorLicenseToken: string
  deviceIdHash: string
  fetchImpl?: typeof fetch
  WebSocketImpl?: typeof WebSocket
  now?: () => number
  monotonicNow?: () => number
}

type BoundedJsonResult =
  | { ok: true; value: unknown; lateFailure?: BrokerFailureCode }
  | { ok: false; code: BrokerFailureCode }

export type SpeechBrokerOperation = {
  signal?: AbortSignal
  /** Monotonic absolute deadline shared by every create/open operation in one handoff. */
  deadlineAt?: number
}

type OperationScope = {
  signal: AbortSignal
  failure: () => BrokerFailureCode | null
  cleanup: () => void
}

function createOperationScope(
  operation: SpeechBrokerOperation | undefined,
  stageLimitMs: number,
  monotonicNow: () => number
): { ok: true; value: OperationScope } | { ok: false; code: BrokerFailureCode } {
  const startedAt = monotonicNow()
  if (!Number.isFinite(startedAt) || startedAt < 0) return { ok: false, code: 'CONFIG' }
  if (operation?.signal?.aborted) return { ok: false, code: 'CANCELLED' }
  let timeoutMs = stageLimitMs
  if (operation?.deadlineAt !== undefined) {
    if (!Number.isFinite(operation.deadlineAt) || operation.deadlineAt < 0) return { ok: false, code: 'SCHEMA' }
    const remaining = operation.deadlineAt - startedAt
    if (remaining <= 0) return { ok: false, code: 'TIMEOUT' }
    if (remaining > SPEECH_BROKER_MAX_OWNER_OPERATION_MS) return { ok: false, code: 'SCHEMA' }
    timeoutMs = Math.min(timeoutMs, remaining)
  }

  const controller = new AbortController()
  let timeoutElapsed = false
  const onOwnerAbort = (): void => controller.abort()
  operation?.signal?.addEventListener('abort', onOwnerAbort, { once: true })
  const timer = setTimeout(
    () => {
      timeoutElapsed = true
      controller.abort()
    },
    Math.max(1, timeoutMs)
  )
  let cleaned = false
  return {
    ok: true,
    value: {
      signal: controller.signal,
      failure: () => {
        if (operation?.signal?.aborted) return 'CANCELLED'
        if (operation?.deadlineAt !== undefined && monotonicNow() >= operation.deadlineAt) return 'TIMEOUT'
        return timeoutElapsed ? (operation ? 'TIMEOUT' : 'TRANSPORT') : null
      },
      cleanup: () => {
        if (cleaned) return
        cleaned = true
        clearTimeout(timer)
        operation?.signal?.removeEventListener('abort', onOwnerAbort)
      }
    }
  }
}

async function readBoundedResponse(response: Response): Promise<BoundedJsonResult> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    await response.body?.cancel().catch(() => undefined)
    return { ok: false, code: 'RESPONSE' }
  }
  const reader = response.body?.getReader()
  if (!reader) return { ok: false, code: 'RESPONSE' }
  const chunks: Uint8Array[] = []
  let total = 0
  let complete = false
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) {
        complete = true
        break
      }
      total += part.value.byteLength
      if (total > SPEECH_BROKER_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        complete = true
        return { ok: false, code: 'RESPONSE' }
      }
      chunks.push(part.value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return { ok: false, code: 'RESPONSE' }
    }
    try {
      return { ok: true, value: JSON.parse(text) }
    } catch {
      return { ok: false, code: 'RESPONSE' }
    }
  } catch {
    return { ok: false, code: 'TRANSPORT' }
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** Main-process-only signed client for the Operator speech relay. */
export class SpeechBrokerClient {
  private readonly origin: string | null
  private readonly fetchImpl: typeof fetch
  private readonly WebSocketImpl: typeof WebSocket
  private readonly now: () => number
  private readonly monotonicNow: () => number

  constructor(private readonly options: SpeechBrokerClientOptions) {
    this.origin = normalizeSpeechOperatorOrigin(options.operatorUrl)
    this.fetchImpl = options.fetchImpl ?? fetch
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket
    this.now = options.now ?? Date.now
    this.monotonicNow = options.monotonicNow ?? (() => performance.now())
  }

  operationFailure(operation?: SpeechBrokerOperation): BrokerFailureCode | null {
    if (operation?.signal?.aborted) return 'CANCELLED'
    if (operation?.deadlineAt === undefined) return null
    const now = this.monotonicNow()
    if (!Number.isFinite(operation.deadlineAt) || operation.deadlineAt < 0) return 'SCHEMA'
    const remaining = operation.deadlineAt - now
    if (remaining <= 0) return 'TIMEOUT'
    if (remaining > SPEECH_BROKER_MAX_OWNER_OPERATION_MS) return 'SCHEMA'
    return null
  }

  operationBudgetMs(operation: SpeechBrokerOperation | undefined, stageLimitMs: number): number {
    const failure = this.operationFailure(operation)
    if (failure) return 0
    const remaining = operation?.deadlineAt === undefined ? stageLimitMs : operation.deadlineAt - this.monotonicNow()
    return Math.max(0, Math.min(stageLimitMs, remaining))
  }

  async capability(operation?: SpeechBrokerOperation): Promise<BrokerResult<SpeechCapability>> {
    const response = await this.postJson(
      '/v1/speech/capability',
      { operation: 'speech-capability' },
      false,
      12_000,
      operation
    )
    if (!response.ok) return response
    if (response.lateFailure) return { ok: false, code: response.lateFailure }
    const parsed = CapabilitySchema.safeParse(response.value)
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, code: 'SCHEMA' }
  }

  async createSession(value: unknown, operation?: SpeechBrokerOperation): Promise<BrokerResult<CreatedSpeechSession>> {
    const operationFailure = this.operationFailure(operation)
    if (operationFailure) return { ok: false, code: operationFailure }
    const now = this.now()
    const request = CreateRequestSchema.safeParse(value)
    if (
      !request.success ||
      request.data.consent.issuedAt > now ||
      request.data.consent.expiresAt <= now ||
      request.data.consent.expiresAt - request.data.consent.issuedAt > 120_000
    )
      return { ok: false, code: 'SCHEMA' }
    const response = await this.postJson('/v1/speech/sessions', request.data, false, 12_000, operation)
    if (!response.ok) return response
    const parsed = CreatedSessionSchema.safeParse(response.value)
    if (!parsed.success) return { ok: false, code: 'SCHEMA' }
    if (
      parsed.data.captureGeneration !== request.data.captureGeneration ||
      parsed.data.grants.length !== request.data.tracks.length ||
      request.data.tracks.some((track, index) => parsed.data.grants[index]?.track !== track)
    )
      return { ok: false, code: 'SCHEMA' }
    const lateFailure = response.lateFailure ?? this.operationFailure(operation)
    if (lateFailure) {
      await this.cancel(parsed.data.sessionId, 1_000)
      return { ok: false, code: lateFailure }
    }
    return { ok: true, value: parsed.data }
  }

  async openTrack(
    session: CreatedSpeechSession,
    track: SpeechTrack,
    onSocketOpen?: (socket: WebSocket) => void,
    operation?: SpeechBrokerOperation
  ): Promise<BrokerResult<WebSocket>> {
    const scope = createOperationScope(operation, 10_000, this.monotonicNow)
    if (!scope.ok) return { ok: false, code: scope.code }
    if (scope.value.failure()) {
      scope.value.cleanup()
      return { ok: false, code: scope.value.failure() ?? 'TIMEOUT' }
    }
    const grant = session.grants.find((item) => item.track === track)
    if (!grant || !this.isActiveConfigured()) {
      scope.value.cleanup()
      return { ok: false, code: 'CONFIG' }
    }
    const grantDigest = createHash('sha256').update(grant.token, 'utf8').digest('hex')
    const descriptor = {
      operation: 'open-track',
      sessionId: session.sessionId,
      track,
      captureGeneration: session.captureGeneration,
      streamEpoch: grant.streamEpoch,
      grantDigest
    }
    const descriptorText = JSON.stringify(descriptor)
    const headers = {
      ...operatorHmacHeaders(this.options.operatorLicenseToken, this.options.deviceIdHash, descriptorText, this.now()),
      'x-metis-speech-descriptor': descriptorText,
      'x-metis-speech-grant': grant.token
    }
    const url = new URL(`/v1/speech/sessions/${session.sessionId}/tracks/${track}`, this.origin!)
    url.protocol = 'wss:'
    return new Promise((resolve) => {
      let socket: WebSocket
      try {
        socket = new this.WebSocketImpl(url.toString(), {
          headers,
          followRedirects: false,
          handshakeTimeout: Math.max(
            1,
            Math.min(10_000, operation?.deadlineAt === undefined ? 10_000 : operation.deadlineAt - this.monotonicNow())
          ),
          maxPayload: SPEECH_BROKER_WS_MAX_PAYLOAD,
          perMessageDeflate: false,
          rejectUnauthorized: true
        })
      } catch {
        scope.value.cleanup()
        resolve({ ok: false, code: 'WS_CONNECT' })
        return
      }
      let opened = false
      let settled = false
      const safeErrorSink = (): void => undefined
      const finish = (result: BrokerResult<WebSocket>): void => {
        if (settled) return
        settled = true
        scope.value.signal.removeEventListener('abort', onAbort)
        socket.removeListener('open', onOpen)
        socket.removeListener('error', onError)
        socket.removeListener('close', onClose)
        scope.value.cleanup()
        resolve(result)
      }
      const onError = (): void => {
        if (opened) return
        try {
          socket.terminate()
        } catch {
          /* no grant is retained after an unsuccessful upgrade */
        }
        finish({ ok: false, code: scope.value.failure() ?? 'WS_CONNECT' })
      }
      const onClose = (): void => {
        if (opened) return
        finish({ ok: false, code: scope.value.failure() ?? 'WS_CONNECT' })
      }
      const onAbort = (): void => {
        try {
          socket.terminate()
        } catch {
          /* abort keeps the remote grant unusable even if local teardown fails */
        }
        finish({ ok: false, code: scope.value.failure() ?? 'TIMEOUT' })
      }
      const onOpen = (): void => {
        const failed = scope.value.failure()
        if (failed) {
          try {
            socket.terminate()
          } catch {
            /* late success is rejected and locally torn down */
          }
          finish({ ok: false, code: failed })
          return
        }
        opened = true
        try {
          onSocketOpen?.(socket)
        } catch {
          try {
            socket.terminate()
          } catch {
            /* failed handoff cannot retain an open grant */
          }
          finish({ ok: false, code: 'WS_CONNECT' })
          return
        }
        finish({ ok: true, value: socket })
      }
      socket.on('error', safeErrorSink)
      socket.once('error', onError)
      socket.once('open', onOpen)
      socket.once('close', onClose)
      scope.value.signal.addEventListener('abort', onAbort, { once: true })
      if (scope.value.signal.aborted) onAbort()
    })
  }

  async status(
    sessionId: string,
    timeoutMs = 12_000,
    operation?: SpeechBrokerOperation
  ): Promise<BrokerResult<SpeechSessionStatus>> {
    if (!z.string().uuid().safeParse(sessionId).success) return { ok: false, code: 'SCHEMA' }
    const body = { operation: 'session-status', sessionId }
    const response = await this.postJson(`/v1/speech/sessions/${sessionId}/status`, body, true, timeoutMs, operation)
    if (!response.ok) return response
    if (response.lateFailure) return { ok: false, code: response.lateFailure }
    const parsed = StatusSchema.safeParse(response.value)
    return parsed.success && parsed.data.sessionId === sessionId
      ? { ok: true, value: parsed.data }
      : { ok: false, code: 'SCHEMA' }
  }

  async cancel(sessionId: string, timeoutMs = 1_000): Promise<BrokerResult<z.infer<typeof CancelSchema>>> {
    if (!z.string().uuid().safeParse(sessionId).success) return { ok: false, code: 'SCHEMA' }
    const body = { operation: 'cancel-session', sessionId }
    const response = await this.postJson(`/v1/speech/sessions/${sessionId}/cancel`, body, true, timeoutMs)
    if (!response.ok) return response
    const parsed = CancelSchema.safeParse(response.value)
    return parsed.success && parsed.data.sessionId === sessionId
      ? { ok: true, value: parsed.data }
      : { ok: false, code: 'SCHEMA' }
  }

  private async postJson(
    path: string,
    body: unknown,
    allowExpiredLicense = false,
    timeoutMs = 12_000,
    operation?: SpeechBrokerOperation
  ): Promise<BoundedJsonResult> {
    if (!(allowExpiredLicense ? this.hasSignedOwnerCredentials() : this.isActiveConfigured()))
      return { ok: false, code: 'CONFIG' }
    const bodyText = JSON.stringify(body)
    if (new TextEncoder().encode(bodyText).byteLength > SPEECH_BROKER_MAX_REQUEST_BYTES)
      return { ok: false, code: 'SCHEMA' }
    const headers = {
      'content-type': 'application/json',
      ...operatorHmacHeaders(this.options.operatorLicenseToken, this.options.deviceIdHash, bodyText, this.now())
    }
    const scope = createOperationScope(operation, Math.max(1, Math.min(12_000, timeoutMs)), this.monotonicNow)
    if (!scope.ok) return { ok: false, code: scope.code }
    let response: Response
    try {
      response = await this.fetchImpl(new URL(path, this.origin!), {
        method: 'POST',
        headers,
        body: bodyText,
        redirect: 'manual',
        signal: scope.value.signal
      })
    } catch {
      const failure = scope.value.failure() ?? 'TRANSPORT'
      scope.value.cleanup()
      return { ok: false, code: path === '/v1/speech/sessions' ? 'UNKNOWN_ALLOCATION' : failure }
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined)
      scope.value.cleanup()
      return { ok: false, code: 'RESPONSE' }
    }
    let parsed: BoundedJsonResult
    try {
      parsed = await readBoundedResponse(response)
    } finally {
      scope.value.cleanup()
    }
    if (!parsed.ok) return { ok: false, code: path === '/v1/speech/sessions' ? 'UNKNOWN_ALLOCATION' : parsed.code }
    if (!response.ok) return { ok: false, code: 'REFUSED' }
    const lateFailure = scope.value.failure()
    return lateFailure ? { ...parsed, lateFailure } : parsed
  }

  private hasSignedOwnerCredentials(): boolean {
    const token = parseOperatorLicense(this.options.operatorLicenseToken)
    return Boolean(this.origin && token && /^[a-f0-9]{32}$/.test(this.options.deviceIdHash))
  }

  private isActiveConfigured(): boolean {
    const token = parseOperatorLicense(this.options.operatorLicenseToken)
    return this.hasSignedOwnerCredentials() && Boolean(token && token.exp * 1_000 > this.now())
  }
}
