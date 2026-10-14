import { issuedLicenseActive } from '../fleet'
import { json } from '../http'
import type { Env, HandleOpts } from './admin-ctx'
import type { OperatorStore } from '../store'
import { cancelSpeechSession, allocateSpeechSession } from '../speech/grants'
import { parseSpeechSessionRequest, SpeechCancelRequestSchema } from '../speech/contracts'
import { resolveSpeechPolicy, speechDeploymentIdentity } from '../speech/policy'
import { resolveSpeechReadiness } from '../speech/readiness'
import { sha256Hex } from '../crypto'
import { hmacHex } from '../hmac'
import {
  MAX_CLIENT_FRAME_BYTES,
  MAX_INPUT_BYTES_PER_TRACK,
  MAX_OUTPUT_BYTES_PER_TRACK,
  SPEECH_DRAIN_WINDOW_MS,
  SPEECH_STREAM_AUTHORITY_MS
} from '../speech/limits'

type VerifiedSpeechDevice = { deviceId: string; licenseJti: string }

const REFUSAL_TEXT: Record<string, string> = {
  INVALID_REQUEST: 'Speech request was rejected.',
  CONSENT_REQUIRED: 'Current consent is required for the requested tracks.',
  CONSENT_EXPIRED: 'Speech consent is stale or invalid.',
  NOT_AUTHORIZED: 'This device is not authorized for speech.',
  POLICY_UNAVAILABLE: 'Speech policy is unavailable.',
  ROUTE_NOT_READY: 'The configured speech route is not ready.',
  PRIVACY_UNVERIFIED: 'Speech privacy readiness is not verified.',
  TRANSPORT_UNAVAILABLE: 'No approved speech transport is available.',
  DATABASE_UNAVAILABLE: 'Speech service is temporarily unavailable.',
  CONCURRENCY_LIMIT: 'Speech session limit reached.',
  BUDGET_LIMIT: 'Speech budget limit reached.',
  SESSION_NOT_FOUND: 'Speech session was not found.',
  GRANT_REJECTED: 'Speech grant was rejected.'
}

function refusal(code: keyof typeof REFUSAL_TEXT, status = 403): Response {
  return json({ ok: false, code, error: REFUSAL_TEXT[code] }, status)
}

export async function authorizedSpeechDevice(
  store: OperatorStore,
  device: VerifiedSpeechDevice,
  now: number,
  requireEntitlements = true
): Promise<{ ok: true; licenseExpiresAt: number } | { ok: false }> {
  const [seat, issued] = await Promise.all([store.getSeat(device.deviceId), store.getIssuedLicense(device.licenseJti)])
  if (
    !seat ||
    !issued ||
    !issuedLicenseActive(issued, now) ||
    issued.activated_device !== device.deviceId ||
    seat.license_jti !== device.licenseJti ||
    (seat.approval || '').trim().toLowerCase() === 'revoked'
  )
    return { ok: false }
  if (requireEntitlements) {
    try {
      const tiers = await store.listTiers()
      const tierId = issued.tier ?? 'metis'
      const tier = tiers.find((candidate) => candidate.id === tierId)
      if (!tier) return { ok: false }
      const entitlements: unknown = JSON.parse(tier.entitlements_json)
      if (!Array.isArray(entitlements) || entitlements.some((value) => typeof value !== 'string')) return { ok: false }
      if (!entitlements.includes('listen') || !entitlements.includes('operator_keys')) return { ok: false }
    } catch {
      return { ok: false }
    }
  }
  return { ok: true, licenseExpiresAt: issued.exp * 1000 }
}

/** Cleanup/status may use an expired or revoked token, but it still needs an issued credential that was
 * originally bound to this device. The handler then scopes every read/write to that exact principal. */
async function authorizedSpeechSessionOwner(store: OperatorStore, device: VerifiedSpeechDevice): Promise<boolean> {
  try {
    const issued = await store.getIssuedLicense(device.licenseJti)
    return Boolean(issued && issued.activated_device === device.deviceId)
  } catch {
    return false
  }
}

export async function handleSpeechSessionCreate(input: {
  store: OperatorStore
  env: Env
  opts: HandleOpts
  bodyText: string
  now: number
  device: VerifiedSpeechDevice
}): Promise<Response> {
  let value: unknown
  try {
    value = JSON.parse(input.bodyText)
  } catch {
    return refusal('INVALID_REQUEST', 400)
  }
  const parsed = parseSpeechSessionRequest(value, input.now)
  if (!parsed.ok) return refusal(parsed.code, 400)

  const auth = await authorizedSpeechDevice(input.store, input.device, input.now)
  if (!auth.ok) return refusal('NOT_AUTHORIZED', 403)
  const readiness = input.opts.speechPolicyEvidence
    ? {
        ok: true as const,
        evidence: input.opts.speechPolicyEvidence,
        evidenceId: 'synthetic-test-evidence',
        expiresAt: input.now + 1_000
      }
    : await resolveSpeechReadiness({ db: input.env.DB, env: input.env, now: input.now, fetchImpl: input.opts.cfFetch })
  if (!readiness.ok) return refusal(readiness.code, readiness.code === 'POLICY_UNAVAILABLE' ? 503 : 403)
  const policyResult = resolveSpeechPolicy(input.env, readiness.evidence)
  if (!policyResult.ok) return refusal(policyResult.code, policyResult.code === 'POLICY_UNAVAILABLE' ? 503 : 403)
  if (!input.env.DB) return refusal('DATABASE_UNAVAILABLE', 503)

  const policy = policyResult.policy
  const language = parsed.request.language ?? (policy.routeId === 'deepgram-via-gateway' ? 'multi' : undefined)
  if (!language || !policy.allowedLanguages.includes(language)) return refusal('INVALID_REQUEST', 400)
  const leaseMs = Math.min(
    policy.maxSessionMs,
    SPEECH_STREAM_AUTHORITY_MS,
    parsed.request.consent.expiresAt - input.now,
    readiness.expiresAt - input.now
  )
  if (leaseMs <= 0) return refusal('CONSENT_EXPIRED', 400)
  const allocation = await allocateSpeechSession(input.env.DB, {
    tenantId: policy.tenantId,
    audience: policy.audience,
    licenseJti: input.device.licenseJti,
    deviceId: input.device.deviceId,
    captureGeneration: parsed.request.captureGeneration,
    routeId: policy.routeId,
    model: policy.modelId,
    configVersion: policy.configVersion,
    policyVersion: policy.policyVersion,
    implementationRevision: input.env.SPEECH_IMPLEMENTATION_REVISION || 'synthetic-test-revision',
    routeEvidenceId: readiness.evidenceId,
    evidenceExpiresAt: readiness.expiresAt,
    consentIssuedAt: parsed.request.consent.issuedAt,
    consentExpiresAt: parsed.request.consent.expiresAt,
    language,
    tracks: parsed.request.tracks,
    now: input.now,
    licenseExpiresAt: auth.licenseExpiresAt,
    grantTtlMs: policy.grantTtlMs,
    leaseMs,
    budgetWindowMs: policy.budgetWindowMs,
    budgetMaxMs: policy.budgetMaxMs,
    maxReservedMs: leaseMs * parsed.request.tracks.length,
    maxSessions: policy.maxConcurrentSessions,
    maxTracks: policy.maxConcurrentTracks
  })
  if (!allocation.ok) return refusal(allocation.code, allocation.code === 'DATABASE_UNAVAILABLE' ? 503 : 429)
  const maxStreamMs = Math.min(SPEECH_STREAM_AUTHORITY_MS, leaseMs)
  const drainWindowMs = Math.min(SPEECH_DRAIN_WINDOW_MS, maxStreamMs)
  return json({
    ok: true,
    protocolVersion: 1,
    sessionId: allocation.sessionId,
    routeId: policy.routeId,
    model: policy.modelId,
    configVersion: policy.configVersion,
    language,
    captureGeneration: parsed.request.captureGeneration,
    grantExpiresAt: allocation.grantExpiresAt,
    leaseExpiresAt: allocation.leaseExpiresAt,
    limits: {
      maxStreamMs,
      audioDeadlineAt: allocation.leaseExpiresAt - drainWindowMs,
      drainWindowMs,
      maxInputBytesPerTrack: MAX_INPUT_BYTES_PER_TRACK,
      maxClientFrameBytes: MAX_CLIENT_FRAME_BYTES,
      maxOutputBytesPerTrack: MAX_OUTPUT_BYTES_PER_TRACK
    },
    grants: allocation.grants
  })
}

export async function handleSpeechCapabilities(input: {
  store: OperatorStore
  env: Env
  opts: HandleOpts
  bodyText: string
  now: number
  device: VerifiedSpeechDevice
}): Promise<Response> {
  let body: unknown
  try {
    body = JSON.parse(input.bodyText)
  } catch {
    return refusal('INVALID_REQUEST', 400)
  }
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    (body as { operation?: unknown }).operation !== 'speech-capability'
  )
    return refusal('INVALID_REQUEST', 400)
  const auth = await authorizedSpeechDevice(input.store, input.device, input.now)
  if (!auth.ok) return refusal('NOT_AUTHORIZED', 403)
  const readiness = input.opts.speechPolicyEvidence
    ? {
        ok: true as const,
        evidence: input.opts.speechPolicyEvidence,
        evidenceId: 'synthetic-test-evidence',
        expiresAt: input.now + 1_000
      }
    : await resolveSpeechReadiness({ db: input.env.DB, env: input.env, now: input.now, fetchImpl: input.opts.cfFetch })
  if (!readiness.ok)
    return json({
      ok: true,
      protocolVersion: 1,
      selected: null,
      allowed: [],
      ready: false,
      code: readiness.code,
      validUntil: input.now
    })
  const policyResult = resolveSpeechPolicy(input.env, readiness.evidence)
  if (!policyResult.ok)
    return json({
      ok: true,
      protocolVersion: 1,
      selected: null,
      allowed: [],
      ready: false,
      code: policyResult.code,
      validUntil: input.now
    })
  return json({
    ok: true,
    protocolVersion: 1,
    selected: { routeId: policyResult.policy.routeId, modelId: policyResult.policy.modelId },
    allowed: [{ routeId: policyResult.policy.routeId, modelId: policyResult.policy.modelId }],
    ready: true,
    routeId: policyResult.policy.routeId,
    modelId: policyResult.policy.modelId,
    languages: policyResult.policy.allowedLanguages,
    format: { encoding: 'pcm_s16le', sampleRate: 16_000, channels: 1 },
    validUntil: Math.min(readiness.expiresAt, input.now + 60_000),
    limits: {
      maxStreamMs: SPEECH_STREAM_AUTHORITY_MS,
      drainWindowMs: SPEECH_DRAIN_WINDOW_MS,
      maxInputBytesPerTrack: MAX_INPUT_BYTES_PER_TRACK,
      maxClientFrameBytes: MAX_CLIENT_FRAME_BYTES,
      maxOutputBytesPerTrack: MAX_OUTPUT_BYTES_PER_TRACK
    }
  })
}

export async function handleSpeechSessionCancel(input: {
  store: OperatorStore
  env: Env
  bodyText: string
  urlSessionId: string
  now: number
  device: VerifiedSpeechDevice
}): Promise<Response> {
  let value: unknown
  try {
    value = JSON.parse(input.bodyText)
  } catch {
    return refusal('INVALID_REQUEST', 400)
  }
  const parsed = SpeechCancelRequestSchema.safeParse(value)
  if (!parsed.success || parsed.data.sessionId !== input.urlSessionId) return refusal('INVALID_REQUEST', 400)
  if (!(await authorizedSpeechSessionOwner(input.store, input.device))) return refusal('NOT_AUTHORIZED', 403)
  const identity = speechDeploymentIdentity(input.env)
  if (!identity) return refusal('POLICY_UNAVAILABLE', 503)
  if (!input.env.DB) return refusal('DATABASE_UNAVAILABLE', 503)
  const cancelled = await cancelSpeechSession(input.env.DB, input.urlSessionId, {
    tenantId: identity.tenantId,
    audience: identity.audience,
    licenseJti: input.device.licenseJti,
    deviceId: input.device.deviceId,
    now: input.now
  })
  if (!cancelled.ok) return refusal(cancelled.code, cancelled.code === 'DATABASE_UNAVAILABLE' ? 503 : 404)
  if (cancelled.status === 'cancellation-requested' && input.env.SPEECH_SESSION_DO) {
    try {
      const namespace = input.env.SPEECH_SESSION_DO
      const name = await sha256Hex(`${identity.tenantId}\n${identity.audience}\n${input.urlSessionId}`)
      const bodyText = JSON.stringify({ operation: 'stop-session', sessionId: input.urlSessionId })
      const tsText = String(input.now)
      const signature = await hmacHex(input.env.OPERATOR_INGEST_SECRET, `${tsText}\n${bodyText}`)
      const stub = namespace.get(namespace.idFromName(name))
      await stub.fetch(
        new Request('https://speech-session.internal/stop', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-metis-speech-internal-ts': tsText,
            'x-metis-speech-internal-sig': signature
          },
          body: bodyText
        })
      )
    } catch {
      /* durable stop_requested_at is polled by the session object */
    }
  }
  return json({
    ok: true,
    protocolVersion: 1,
    sessionId: input.urlSessionId,
    cancelled: cancelled.status === 'cancelled',
    cancellationRequested: cancelled.status === 'cancellation-requested'
  })
}

export async function handleSpeechSessionStatus(input: {
  store: OperatorStore
  env: Env
  bodyText: string
  urlSessionId: string
  now: number
  device: VerifiedSpeechDevice
}): Promise<Response> {
  let value: unknown
  try {
    value = JSON.parse(input.bodyText)
  } catch {
    return refusal('INVALID_REQUEST', 400)
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'operation,sessionId' ||
    (value as { operation?: unknown }).operation !== 'session-status' ||
    (value as { sessionId?: unknown }).sessionId !== input.urlSessionId
  )
    return refusal('INVALID_REQUEST', 400)
  if (!(await authorizedSpeechSessionOwner(input.store, input.device))) return refusal('NOT_AUTHORIZED', 403)
  const identity = speechDeploymentIdentity(input.env)
  if (!identity) return refusal('POLICY_UNAVAILABLE', 503)
  const db = input.env.DB
  if (!db) return refusal('DATABASE_UNAVAILABLE', 503)
  try {
    const session = await db
      .prepare(`SELECT status, stop_requested_at, capture_generation
      FROM speech_sessions WHERE id = ? AND tenant_id = ? AND audience = ? AND license_jti = ? AND device_id = ?`)
      .bind(input.urlSessionId, identity.tenantId, identity.audience, input.device.licenseJti, input.device.deviceId)
      .first<{
        status: 'active' | 'cancelled' | 'expired'
        stop_requested_at: number | null
        capture_generation: number
      }>()
    if (!session) return refusal('SESSION_NOT_FOUND', 404)
    const streams = await db
      .prepare(`SELECT g.track, g.stream_epoch, st.transport_attempted_at, st.opened_at,
        st.stop_requested_at, st.finish_requested_at, st.provider_complete_at, st.close_confirmed_at,
        st.last_sequence, st.tail_status
      FROM speech_grants g LEFT JOIN speech_streams st ON st.grant_id = g.id
      WHERE g.session_id = ? AND g.tenant_id = ? AND g.audience = ? AND g.license_jti = ? AND g.device_id = ?
      ORDER BY g.track`)
      .bind(input.urlSessionId, identity.tenantId, identity.audience, input.device.licenseJti, input.device.deviceId)
      .all<{
        track: 'microphone' | 'system'
        stream_epoch: number
        transport_attempted_at: number | null
        opened_at: number | null
        stop_requested_at: number | null
        finish_requested_at: number | null
        provider_complete_at: number | null
        close_confirmed_at: number | null
        last_sequence: number | null
        tail_status: 'complete' | 'incomplete' | null
      }>()
    if (streams.results.length < 1 || streams.results.length > 2) return refusal('DATABASE_UNAVAILABLE', 503)
    return json({
      ok: true,
      protocolVersion: 1,
      sessionId: input.urlSessionId,
      captureGeneration: session.capture_generation,
      status: session.status,
      cancellationRequested: session.stop_requested_at !== null,
      tracks: streams.results.map((stream) => ({
        track: stream.track,
        streamEpoch: stream.stream_epoch,
        phase:
          stream.close_confirmed_at !== null
            ? 'closed'
            : stream.stop_requested_at !== null
              ? 'stopping'
              : stream.finish_requested_at !== null
                ? 'finishing'
                : stream.opened_at !== null
                  ? 'open'
                  : stream.transport_attempted_at !== null
                    ? 'opening'
                    : 'ready',
        closeConfirmed: stream.close_confirmed_at !== null,
        tail: stream.close_confirmed_at === null ? null : (stream.tail_status ?? 'incomplete'),
        lastSequence: stream.last_sequence ?? 0
      }))
    })
  } catch {
    return refusal('DATABASE_UNAVAILABLE', 503)
  }
}
