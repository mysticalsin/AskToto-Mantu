import { sha256Hex } from '../crypto'
import { json } from '../http'
import { resolveSpeechReadiness } from '../speech/readiness'
import type { SpeechRouteId } from '../speech/policy'
import { validEvidenceReferences } from '../speech/readiness'
import { defineRoute } from './registry'
import { auditLog, safeAuditText, type AdminCtx } from './admin-ctx'
import { isOwnerEmail } from '../access'
import { verifyNamedGatewayPrivacy } from '../ai-gateway'

const MAX_BODY = 8 * 1024
const evidenceKinds = ['gateway-readback', 'provider-retention', 'synthetic-sink-test', 'relay-runtime-test'] as const

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedText(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && value.length <= 256 && pattern.test(value)
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get('content-length'))
  if (Number.isFinite(length) && length > MAX_BODY) return null
  const reader = request.body?.getReader()
  if (!reader) return null
  let cancel = false
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_BODY) {
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
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    return record(value) ? value : null
  } catch {
    return null
  }
}

function fail(status: number, code: string): Response {
  return json({ ok: false, code }, status)
}

function evidenceRefs(value: unknown): string | null {
  if (!Array.isArray(value) || value.length !== evidenceKinds.length) return null
  const normalized: Array<{ kind: string; reference: string; digest: string; outcome: 'passed' }> = []
  const remaining = new Set<string>(evidenceKinds)
  for (const item of value) {
    if (!record(item) || typeof item.kind !== 'string' || !remaining.delete(item.kind)) return null
    if (
      !boundedText(item.reference, /^https:\/\/[^\s?#]{1,220}$/) ||
      !boundedText(item.digest, /^sha256:[a-f0-9]{64}$/) ||
      item.outcome !== 'passed'
    )
      return null
    normalized.push({ kind: item.kind, reference: item.reference, digest: item.digest, outcome: 'passed' })
  }
  return remaining.size === 0 && validEvidenceReferences(JSON.stringify(normalized)) ? JSON.stringify(normalized) : null
}

async function importEvidence(request: Request, ctx: AdminCtx): Promise<Response> {
  if (!isOwnerEmail(ctx.email, ctx.env)) return fail(403, 'OWNER_REQUIRED')
  const body = await readBody(request)
  if (!body) return fail(400, 'INVALID_EVIDENCE')
  const expectedVersion = body.expectedVersion
  const expiresAt = body.expiresAt
  const reviewer = body.reviewerEmail
  const refs = evidenceRefs(body.references)
  const routeId = body.routeId
  const modelId = body.modelId
  const configVersion = body.configVersion
  const tenantId = ctx.env.SPEECH_TENANT_ID
  const audience = ctx.env.SPEECH_AUDIENCE
  const deploymentId = ctx.env.SPEECH_DEPLOYMENT_ID
  const accountId = ctx.env.CF_ACCOUNT_ID
  const gatewayId = ctx.env.SPEECH_GATEWAY_ID
  const policyVersion = ctx.env.SPEECH_POLICY_VERSION
  const revision = ctx.env.SPEECH_IMPLEMENTATION_REVISION
  if (
    !ctx.env.DB ||
    !refs ||
    !Number.isSafeInteger(expectedVersion) ||
    Number(expectedVersion) < 0 ||
    !Number.isSafeInteger(expiresAt) ||
    Number(expiresAt) <= ctx.now ||
    Number(expiresAt) > ctx.now + 30 * 24 * 60 * 60 * 1000 ||
    typeof reviewer !== 'string' ||
    reviewer.trim().toLowerCase() === ctx.email.toLowerCase() ||
    !isOwnerEmail(reviewer, ctx.env) ||
    !boundedText(tenantId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/) ||
    !boundedText(audience, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/) ||
    !boundedText(deploymentId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/) ||
    !boundedText(accountId, /^[A-Za-z0-9_-]{1,128}$/) ||
    !boundedText(gatewayId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/) ||
    !boundedText(policyVersion, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/) ||
    !boundedText(revision, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/) ||
    !boundedText(configVersion, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/) ||
    configVersion !== ctx.env.SPEECH_CONFIG_VERSION ||
    routeId !== ctx.env.SPEECH_ROUTE_ID ||
    modelId !== ctx.env.SPEECH_MODEL_ID ||
    !['deepgram-via-gateway', 'workers-ai-nova3'].includes(String(routeId))
  )
    return fail(400, 'INVALID_EVIDENCE')
  try {
    await verifyNamedGatewayPrivacy(
      ctx.env.SPEECH_GATEWAY_MANAGEMENT_TOKEN ?? '',
      accountId,
      gatewayId,
      ctx.opts.cfFetch ?? fetch
    )
  } catch {
    return fail(403, 'GATEWAY_PRIVACY_UNVERIFIED')
  }
  const evidenceKey = await sha256Hex(
    JSON.stringify([
      tenantId,
      audience,
      deploymentId,
      accountId,
      gatewayId,
      routeId,
      modelId,
      configVersion,
      policyVersion,
      revision
    ])
  )
  const id = crypto.randomUUID()
  try {
    const result = await ctx.env.DB.prepare(`INSERT INTO speech_route_evidence (
      id, evidence_key, tenant_id, audience, deployment_id, account_id, gateway_id, route_id, model_id,
      config_version, policy_version, implementation_revision, reviewer_email, imported_by, evidence_refs_json,
      expires_at, version, created_at, revoked_at, revoked_by
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL
    ON CONFLICT(evidence_key) DO UPDATE SET id = excluded.id, reviewer_email = excluded.reviewer_email,
      imported_by = excluded.imported_by, evidence_refs_json = excluded.evidence_refs_json,
      expires_at = excluded.expires_at, version = speech_route_evidence.version + 1,
      created_at = excluded.created_at, revoked_at = NULL, revoked_by = NULL
      WHERE speech_route_evidence.version = ?`)
      .bind(
        id,
        evidenceKey,
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
        reviewer.trim().toLowerCase(),
        ctx.email,
        refs,
        expiresAt,
        ctx.now,
        Number(expectedVersion)
      )
      .run()
    const changes = (result as { meta?: { changes?: number } }).meta?.changes
    if (changes !== 1) return fail(409, 'EVIDENCE_VERSION_CONFLICT')
    await auditLog(ctx, 'speech-evidence-import', null, safeAuditText(String(routeId)))
    return json({ ok: true, id, version: Number(expectedVersion) + 1, expiresAt })
  } catch {
    return fail(503, 'EVIDENCE_UNAVAILABLE')
  }
}

async function revokeEvidence(request: Request, ctx: AdminCtx, evidenceId: string): Promise<Response> {
  if (!isOwnerEmail(ctx.email, ctx.env)) return fail(403, 'OWNER_REQUIRED')
  const body = await readBody(request)
  if (!ctx.env.DB || !body || !Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) <= 0)
    return fail(400, 'INVALID_EVIDENCE')
  try {
    const result = await ctx.env.DB.prepare(`UPDATE speech_route_evidence
      SET revoked_at = ?, revoked_by = ?, version = version + 1
      WHERE id = ? AND version = ? AND revoked_at IS NULL`)
      .bind(ctx.now, ctx.email, evidenceId, Number(body.expectedVersion))
      .run()
    if ((result as { meta?: { changes?: number } }).meta?.changes !== 1) return fail(409, 'EVIDENCE_VERSION_CONFLICT')
    await auditLog(ctx, 'speech-evidence-revoke', null, safeAuditText(evidenceId))
    return json({ ok: true, id: evidenceId, version: Number(body.expectedVersion) + 1 })
  } catch {
    return fail(503, 'EVIDENCE_UNAVAILABLE')
  }
}

async function status(_request: Request, ctx: AdminCtx): Promise<Response> {
  const result = await resolveSpeechReadiness({
    db: ctx.env.DB,
    env: ctx.env,
    now: ctx.now,
    fetchImpl: ctx.opts.cfFetch
  })
  return json({
    ok: true,
    readiness: result.ok ? 'CONFIGURED' : result.code,
    routeId: ctx.env.SPEECH_ROUTE_ID ?? null,
    modelId: ctx.env.SPEECH_MODEL_ID ?? null
  })
}

export function registerAdminSpeechEvidenceRoutes(): void {
  defineRoute<AdminCtx>({ method: 'GET', pattern: '/v1/admin/speech/readiness', auth: 'admin', handler: status })
  defineRoute<AdminCtx>({
    method: 'POST',
    pattern: '/v1/admin/speech/evidence',
    auth: 'admin',
    handler: importEvidence
  })
  defineRoute<AdminCtx>({
    method: 'POST',
    pattern: /^\/v1\/admin\/speech\/evidence\/(?<id>[0-9a-f-]{36})\/revoke$/,
    auth: 'admin',
    handler: (request, ctx, match) => revokeEvidence(request, ctx, match.params.id ?? '')
  })
}
