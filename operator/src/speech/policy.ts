export type SpeechRouteId = 'deepgram-via-gateway' | 'workers-ai-nova3'

export interface SpeechPolicyEnv {
  SPEECH_TENANT_ID?: string
  SPEECH_AUDIENCE?: string
  SPEECH_POLICY_VERSION?: string
  SPEECH_ROUTE_ID?: string
  SPEECH_MODEL_ID?: string
  SPEECH_CONFIG_VERSION?: string
  SPEECH_ALLOWED_LANGUAGES?: string
  SPEECH_MAX_CONCURRENT_SESSIONS?: string
  SPEECH_MAX_CONCURRENT_TRACKS?: string
  SPEECH_BUDGET_WINDOW_MS?: string
  SPEECH_BUDGET_MAX_MS?: string
  SPEECH_MAX_SESSION_MS?: string
}

export interface SpeechPolicyEvidence {
  routeId: SpeechRouteId
  modelId: string
  configVersion: string
  tenantId: string
  audience: string
  privacy: 'VERIFIED' | 'UNVERIFIED'
  transportConsumer: 'REGISTERED' | 'UNAVAILABLE'
  /** Marks test-only evidence; production evidence comes from the D1 readiness resolver. */
  synthetic?: true
}

export interface ResolvedSpeechPolicy {
  tenantId: string
  audience: string
  policyVersion: string
  routeId: SpeechRouteId
  modelId: string
  configVersion: string
  allowedLanguages: readonly string[]
  maxConcurrentSessions: number
  maxConcurrentTracks: number
  budgetWindowMs: number
  budgetMaxMs: number
  maxSessionMs: number
  grantTtlMs: 60_000
}

export type SpeechPolicyResult =
  | { ok: true; policy: ResolvedSpeechPolicy }
  | { ok: false; code: 'POLICY_UNAVAILABLE' | 'ROUTE_NOT_READY' | 'PRIVACY_UNVERIFIED' | 'TRANSPORT_UNAVAILABLE' }

export type SpeechDeploymentIdentity = { tenantId: string; audience: string } | null

function boundedInt(value: string | undefined, min: number, max: number): number | null {
  if (!value || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null
}

function deploymentId(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(trimmed) ? trimmed : null
}

function configuredRoute(
  routeId: string | undefined,
  modelId: string | undefined
): { routeId: SpeechRouteId; modelId: string } | null {
  if (routeId === 'deepgram-via-gateway' && modelId === 'nova-3') return { routeId, modelId }
  if (routeId === 'workers-ai-nova3' && modelId === '@cf/deepgram/nova-3') return { routeId, modelId }
  return null
}

/**
 * Resolves only explicit finite server configuration. Gateway configuration readback is not privacy
 * verification, so a separate exact route/config/deployment evidence provider is mandatory. This
 * callers supply exact route evidence only after the real resolver or an isolated test fixture.
 */
export function resolveSpeechPolicy(env: SpeechPolicyEnv, evidence?: SpeechPolicyEvidence): SpeechPolicyResult {
  const tenantId = deploymentId(env.SPEECH_TENANT_ID)
  const audience = deploymentId(env.SPEECH_AUDIENCE)
  const policyVersion = deploymentId(env.SPEECH_POLICY_VERSION)
  const configVersion = deploymentId(env.SPEECH_CONFIG_VERSION)
  const allowedLanguages = (env.SPEECH_ALLOWED_LANGUAGES || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const route = configuredRoute(env.SPEECH_ROUTE_ID, env.SPEECH_MODEL_ID)
  const maxConcurrentSessions = boundedInt(env.SPEECH_MAX_CONCURRENT_SESSIONS, 1, 10_000)
  const maxConcurrentTracks = boundedInt(env.SPEECH_MAX_CONCURRENT_TRACKS, 1, 20_000)
  const budgetWindowMs = boundedInt(env.SPEECH_BUDGET_WINDOW_MS, 1_000, 31_536_000_000)
  const budgetMaxMs = boundedInt(env.SPEECH_BUDGET_MAX_MS, 1, 31_536_000_000)
  const maxSessionMs = boundedInt(env.SPEECH_MAX_SESSION_MS, 1, 86_400_000)
  if (
    !tenantId ||
    !audience ||
    !policyVersion ||
    !configVersion ||
    !route ||
    !maxConcurrentSessions ||
    !maxConcurrentTracks ||
    !budgetWindowMs ||
    !budgetMaxMs ||
    !maxSessionMs ||
    allowedLanguages.length === 0 ||
    allowedLanguages.some((language) => !/^(?:multi|[a-z]{2}(?:-[A-Z]{2})?)$/.test(language)) ||
    new Set(allowedLanguages).size !== allowedLanguages.length
  ) {
    return { ok: false, code: route ? 'POLICY_UNAVAILABLE' : 'ROUTE_NOT_READY' }
  }
  if (!Number.isSafeInteger(maxSessionMs * 2) || maxSessionMs * 2 > budgetMaxMs || budgetMaxMs > budgetWindowMs)
    return { ok: false, code: 'POLICY_UNAVAILABLE' }
  if (
    !evidence ||
    evidence.privacy !== 'VERIFIED' ||
    evidence.routeId !== route.routeId ||
    evidence.modelId !== route.modelId ||
    evidence.configVersion !== configVersion ||
    evidence.tenantId !== tenantId ||
    evidence.audience !== audience
  ) {
    return { ok: false, code: 'PRIVACY_UNVERIFIED' }
  }
  if (evidence.transportConsumer !== 'REGISTERED') return { ok: false, code: 'TRANSPORT_UNAVAILABLE' }
  return {
    ok: true,
    policy: {
      tenantId,
      audience,
      policyVersion,
      routeId: route.routeId,
      modelId: route.modelId,
      configVersion,
      allowedLanguages,
      maxConcurrentSessions,
      maxConcurrentTracks,
      budgetWindowMs,
      budgetMaxMs,
      maxSessionMs,
      grantTtlMs: 60_000
    }
  }
}

export function speechDeploymentIdentity(env: SpeechPolicyEnv): SpeechDeploymentIdentity {
  const tenantId = deploymentId(env.SPEECH_TENANT_ID)
  const audience = deploymentId(env.SPEECH_AUDIENCE)
  return tenantId && audience ? { tenantId, audience } : null
}
