import { issuedLicenseActive } from '../fleet'
import { json } from '../http'
import type { Env, HandleOpts } from './admin-ctx'
import type { OperatorStore } from '../store'
import { cancelSpeechSession, allocateSpeechSession } from '../speech/grants'
import { parseSpeechSessionRequest, SpeechCancelRequestSchema } from '../speech/contracts'
import { resolveSpeechPolicy, speechDeploymentIdentity } from '../speech/policy'

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

async function authorizedSpeechDevice(
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
  const policyResult = resolveSpeechPolicy(input.env, input.opts.speechPolicyEvidence)
  if (!policyResult.ok) return refusal(policyResult.code, policyResult.code === 'POLICY_UNAVAILABLE' ? 503 : 403)
  if (!input.env.DB) return refusal('DATABASE_UNAVAILABLE', 503)

  const policy = policyResult.policy
  if (parsed.request.language && !policy.allowedLanguages.includes(parsed.request.language))
    return refusal('INVALID_REQUEST', 400)
  const allocation = await allocateSpeechSession(input.env.DB, {
    tenantId: policy.tenantId,
    audience: policy.audience,
    licenseJti: input.device.licenseJti,
    deviceId: input.device.deviceId,
    captureGeneration: parsed.request.captureGeneration,
    routeId: policy.routeId,
    model: policy.modelId,
    configVersion: policy.configVersion,
    language: parsed.request.language,
    tracks: parsed.request.tracks,
    now: input.now,
    licenseExpiresAt: auth.licenseExpiresAt,
    grantTtlMs: policy.grantTtlMs,
    leaseMs: policy.maxSessionMs,
    budgetWindowMs: policy.budgetWindowMs,
    budgetMaxMs: policy.budgetMaxMs,
    maxReservedMs: policy.maxSessionMs * parsed.request.tracks.length,
    maxSessions: policy.maxConcurrentSessions,
    maxTracks: policy.maxConcurrentTracks
  })
  if (!allocation.ok) return refusal(allocation.code, allocation.code === 'DATABASE_UNAVAILABLE' ? 503 : 429)
  return json({
    ok: true,
    sessionId: allocation.sessionId,
    routeId: policy.routeId,
    model: policy.modelId,
    configVersion: policy.configVersion,
    language: parsed.request.language ?? null,
    captureGeneration: parsed.request.captureGeneration,
    grantExpiresAt: allocation.grantExpiresAt,
    leaseExpiresAt: allocation.leaseExpiresAt,
    grants: allocation.grants
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
  const auth = await authorizedSpeechDevice(input.store, input.device, input.now, false)
  if (!auth.ok) return refusal('NOT_AUTHORIZED', 403)
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
  return json({ ok: true, sessionId: input.urlSessionId, cancelled: true })
}
