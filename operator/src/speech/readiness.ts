import type { D1DatabaseLike } from '../d1'
import { verifyNamedGatewayPrivacy } from '../ai-gateway'
import type { SpeechPolicyEnv, SpeechPolicyEvidence, SpeechRouteId } from './policy'

export interface SpeechReadinessEnv extends SpeechPolicyEnv {
  SPEECH_DEPLOYMENT_ID?: string
  SPEECH_GATEWAY_ID?: string
  SPEECH_IMPLEMENTATION_REVISION?: string
  SPEECH_GATEWAY_MANAGEMENT_TOKEN?: string
  SPEECH_GATEWAY_RUN_TOKEN?: string
  SPEECH_DEEPGRAM_API_KEY?: string
  CF_ACCOUNT_ID?: string
  SPEECH_SESSION_DO?: unknown
}

export type SpeechReadiness =
  | { ok: true; evidence: SpeechPolicyEvidence; evidenceId: string; expiresAt: number }
  | { ok: false; code: 'POLICY_UNAVAILABLE' | 'PRIVACY_UNVERIFIED' | 'TRANSPORT_UNAVAILABLE' }

interface EvidenceRow {
  id: string
  tenant_id: string
  audience: string
  deployment_id: string
  account_id: string
  gateway_id: string
  route_id: string
  model_id: string
  config_version: string
  policy_version: string
  implementation_revision: string
  reviewer_email: string
  evidence_refs_json: string
  expires_at: number
  revoked_at: number | null
}

export async function resolveSpeechReadiness(input: {
  db?: D1DatabaseLike
  env: SpeechReadinessEnv
  now: number
  fetchImpl?: typeof fetch
}): Promise<SpeechReadiness> {
  const { db, env, now } = input
  const tenantId = env.SPEECH_TENANT_ID?.trim() ?? ''
  const audience = env.SPEECH_AUDIENCE?.trim() ?? ''
  const deploymentId = env.SPEECH_DEPLOYMENT_ID?.trim() ?? ''
  const accountId = env.CF_ACCOUNT_ID?.trim() ?? ''
  const gatewayId = env.SPEECH_GATEWAY_ID?.trim() ?? ''
  const revision = env.SPEECH_IMPLEMENTATION_REVISION?.trim() ?? ''
  const policyVersion = env.SPEECH_POLICY_VERSION?.trim() ?? ''
  const routeId = env.SPEECH_ROUTE_ID as SpeechRouteId | undefined
  const modelId = env.SPEECH_MODEL_ID?.trim() ?? ''
  const configVersion = env.SPEECH_CONFIG_VERSION?.trim() ?? ''
  if (
    !db ||
    !tenantId ||
    !audience ||
    !deploymentId ||
    !accountId ||
    !gatewayId ||
    !revision ||
    !policyVersion ||
    !routeId ||
    !modelId ||
    !configVersion
  )
    return { ok: false, code: 'POLICY_UNAVAILABLE' }
  if (!env.SPEECH_SESSION_DO) return { ok: false, code: 'TRANSPORT_UNAVAILABLE' }
  const managementToken = env.SPEECH_GATEWAY_MANAGEMENT_TOKEN?.trim() ?? ''
  const runToken = env.SPEECH_GATEWAY_RUN_TOKEN?.trim() ?? ''
  if (!managementToken || !runToken || (routeId === 'deepgram-via-gateway' && !env.SPEECH_DEEPGRAM_API_KEY?.trim()))
    return { ok: false, code: 'PRIVACY_UNVERIFIED' }
  let row: EvidenceRow | null
  try {
    row = await db
      .prepare(`SELECT * FROM speech_route_evidence
      WHERE tenant_id = ? AND audience = ? AND deployment_id = ? AND account_id = ? AND gateway_id = ?
        AND route_id = ? AND model_id = ? AND config_version = ? AND policy_version = ?
        AND implementation_revision = ? AND expires_at > ? AND revoked_at IS NULL
      ORDER BY created_at DESC LIMIT 1`)
      .bind(
        tenantId,
        audience,
        deploymentId,
        accountId,
        gatewayId,
        routeId,
        modelId,
        configVersion,
        policyVersion,
        revision,
        now
      )
      .first<EvidenceRow>()
  } catch {
    return { ok: false, code: 'PRIVACY_UNVERIFIED' }
  }
  if (!row || !validEvidenceReferences(row.evidence_refs_json)) return { ok: false, code: 'PRIVACY_UNVERIFIED' }
  try {
    await verifyNamedGatewayPrivacy(managementToken, accountId, gatewayId, input.fetchImpl ?? fetch)
  } catch {
    return { ok: false, code: 'PRIVACY_UNVERIFIED' }
  }
  return {
    ok: true,
    evidenceId: row.id,
    expiresAt: row.expires_at,
    evidence: {
      routeId,
      modelId,
      configVersion,
      tenantId,
      audience,
      privacy: 'VERIFIED',
      transportConsumer: 'REGISTERED'
    }
  }
}

export function validEvidenceReferences(raw: string): boolean {
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value) || value.length !== 4) return false
    const required = new Set(['gateway-readback', 'provider-retention', 'synthetic-sink-test', 'relay-runtime-test'])
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false
      const record = item as Record<string, unknown>
      if (typeof record.kind !== 'string' || !required.delete(record.kind)) return false
      if (typeof record.reference !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(String(record.digest))) return false
      if (record.outcome !== 'passed') return false
    }
    return required.size === 0
  } catch {
    return false
  }
}
