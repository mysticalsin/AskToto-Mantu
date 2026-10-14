import type { D1DatabaseLike } from '../d1'
import { sha256Hex } from '../crypto'
import type { SpeechTrack } from './contracts'
import type { SpeechRouteId } from './policy'

export interface AllocateSpeechSessionInput {
  tenantId: string
  audience: string
  licenseJti: string
  deviceId: string
  captureGeneration: number
  routeId: SpeechRouteId
  model: string
  configVersion: string
  policyVersion?: string
  implementationRevision?: string
  routeEvidenceId?: string
  evidenceExpiresAt?: number
  consentIssuedAt?: number
  consentExpiresAt?: number
  streamEpoch?: number
  language?: string
  tracks: readonly SpeechTrack[]
  now: number
  licenseExpiresAt: number
  grantTtlMs: number
  leaseMs: number
  budgetWindowMs: number
  budgetMaxMs: number
  maxReservedMs: number
  maxSessions: number
  maxTracks: number
}

export interface SpeechGrantBinding {
  tenantId: string
  audience: string
  licenseJti: string
  deviceId: string
  sessionId: string
  captureGeneration: number
  routeId: SpeechRouteId
  model: string
  configVersion: string
  streamEpoch?: number
  language?: string
  track: SpeechTrack
  now: number
}

export interface SpeechRelayBinding extends SpeechGrantBinding {
  policyVersion: string
  implementationRevision: string
  routeEvidenceId: string
  now: number
}

export type GrantFailureCode =
  | 'DATABASE_UNAVAILABLE'
  | 'CONCURRENCY_LIMIT'
  | 'BUDGET_LIMIT'
  | 'GRANT_REJECTED'
  | 'SESSION_NOT_FOUND'

export type AllocationResult =
  | {
      ok: true
      sessionId: string
      grantExpiresAt: number
      leaseExpiresAt: number
      grants: Array<{ track: SpeechTrack; streamEpoch: number; token: string }>
    }
  | { ok: false; code: GrantFailureCode }

function hasAtomicBatch(db: D1DatabaseLike | undefined): db is D1DatabaseLike & {
  batch(statements: Parameters<NonNullable<D1DatabaseLike['batch']>>[0]): Promise<Array<{ success?: boolean }>>
} {
  return Boolean(db && typeof db.batch === 'function')
}

function newOpaqueToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function dbChanges(result: unknown): number | null {
  if (!result || typeof result !== 'object') return null
  const meta = (result as { meta?: unknown }).meta
  if (!meta || typeof meta !== 'object') return null
  const changes = (meta as { changes?: unknown }).changes
  return typeof changes === 'number' && Number.isSafeInteger(changes) ? changes : null
}

function validAllocation(input: AllocateSpeechSessionInput): boolean {
  return Boolean(
    input.tenantId &&
      input.audience &&
      input.licenseJti &&
      input.deviceId &&
      input.policyVersion &&
      input.implementationRevision &&
      input.routeEvidenceId &&
      Number.isSafeInteger(input.captureGeneration) &&
      input.captureGeneration > 0 &&
      input.tracks.length >= 1 &&
      input.tracks.length <= 2 &&
      input.tracks.every((track) => track === 'microphone' || track === 'system') &&
      new Set(input.tracks).size === input.tracks.length &&
      Number.isSafeInteger(input.now) &&
      Number.isSafeInteger(input.licenseExpiresAt) &&
      input.licenseExpiresAt > input.now &&
      Number.isSafeInteger(input.evidenceExpiresAt) &&
      (input.evidenceExpiresAt ?? 0) > input.now &&
      Number.isSafeInteger(input.consentIssuedAt) &&
      Number.isSafeInteger(input.consentExpiresAt) &&
      (input.consentIssuedAt ?? Number.MAX_SAFE_INTEGER) <= input.now &&
      (input.consentExpiresAt ?? 0) > input.now &&
      Number.isSafeInteger(input.streamEpoch ?? 1) &&
      (input.streamEpoch ?? 1) > 0 &&
      Number.isSafeInteger(input.grantTtlMs) &&
      input.grantTtlMs > 0 &&
      Number.isSafeInteger(input.leaseMs) &&
      input.leaseMs > 0 &&
      Number.isSafeInteger(input.budgetWindowMs) &&
      input.budgetWindowMs > 0 &&
      Number.isSafeInteger(input.budgetMaxMs) &&
      input.budgetMaxMs > 0 &&
      Number.isSafeInteger(input.maxReservedMs) &&
      input.maxReservedMs > 0 &&
      Number.isSafeInteger(input.maxSessions) &&
      input.maxSessions > 0 &&
      Number.isSafeInteger(input.maxTracks) &&
      input.maxTracks > 0 &&
      Number.isSafeInteger(input.leaseMs * input.tracks.length) &&
      input.maxReservedMs >= input.leaseMs * input.tracks.length &&
      Number.isSafeInteger(input.now + input.leaseMs) &&
      Number.isSafeInteger(input.now + input.grantTtlMs)
  )
}

export async function allocateSpeechSession(
  db: D1DatabaseLike | undefined,
  input: AllocateSpeechSessionInput
): Promise<AllocationResult> {
  if (!hasAtomicBatch(db) || !validAllocation(input)) return { ok: false, code: 'DATABASE_UNAVAILABLE' }
  const sessionId = crypto.randomUUID()
  const grantExpiresAt = Math.min(
    input.now + input.grantTtlMs,
    input.licenseExpiresAt,
    input.evidenceExpiresAt ?? input.now,
    input.consentExpiresAt ?? input.now,
    input.now + input.leaseMs
  )
  const leaseExpiresAt = Math.min(input.now + input.leaseMs, input.licenseExpiresAt)
  if (
    grantExpiresAt <= input.now ||
    leaseExpiresAt <= input.now ||
    input.maxReservedMs > input.budgetMaxMs ||
    input.budgetMaxMs > input.budgetWindowMs
  ) {
    return { ok: false, code: 'BUDGET_LIMIT' }
  }
  const expiry = await expireSpeechSessions(db, input.now, input.tenantId, input.audience)
  if (!expiry.ok) return { ok: false, code: 'DATABASE_UNAVAILABLE' }
  const budgetWindowStart = Math.floor(input.now / input.budgetWindowMs) * input.budgetWindowMs
  const grants = await Promise.all(
    input.tracks.map(async (track) => {
      const token = newOpaqueToken()
      return { id: crypto.randomUUID(), track, token, tokenHash: await sha256Hex(token) }
    })
  )
  const reserve = db
    .prepare(`
    INSERT INTO speech_sessions (
      id, tenant_id, audience, license_jti, device_id, capture_generation, route_id, model_id,
      config_version, language, status, track_count, reserved_ms, settled_ms, consent_issued_at,
      consent_expires_at, consented_tracks_json, policy_version, implementation_revision, route_evidence_id, evidence_expires_at,
      budget_window_start,
      created_at, grant_expires_at, lease_expires_at, license_expires_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE
      (SELECT COUNT(*) FROM speech_sessions ss WHERE tenant_id = ? AND audience = ? AND status = 'active'
        AND (lease_expires_at > ? OR EXISTS (SELECT 1 FROM speech_streams st WHERE st.session_id = ss.id
          AND st.transport_attempted_at IS NOT NULL AND st.close_confirmed_at IS NULL))) < ?
      AND COALESCE((SELECT SUM(track_count) FROM speech_sessions ss WHERE tenant_id = ? AND audience = ? AND status = 'active'
        AND (lease_expires_at > ? OR EXISTS (SELECT 1 FROM speech_streams st WHERE st.session_id = ss.id
          AND st.transport_attempted_at IS NOT NULL AND st.close_confirmed_at IS NULL))), 0) + ? <= ?
      AND COALESCE((SELECT SUM(reserved_ms + settled_ms) FROM speech_sessions WHERE tenant_id = ? AND audience = ? AND budget_window_start = ?), 0) + ? <= ?
      AND EXISTS (
        SELECT 1 FROM issued_licenses il
        JOIN seats s ON s.device_id = ?
        JOIN tiers t ON t.id = COALESCE(il.tier, 'metis')
        WHERE il.jti = ? AND il.revoked = 0 AND il.exp * 1000 = ? AND il.exp * 1000 > ?
          AND il.activated_device = ? AND s.license_jti = il.jti
          AND LOWER(TRIM(COALESCE(s.approval, ''))) != 'revoked'
          AND CASE WHEN json_valid(t.entitlements_json) = 1 THEN
            CASE WHEN json_type(t.entitlements_json) = 'array' THEN
              NOT EXISTS (SELECT 1 FROM json_each(t.entitlements_json) WHERE type != 'text')
              AND (SELECT COUNT(DISTINCT value) FROM json_each(t.entitlements_json)
                   WHERE value IN ('listen', 'operator_keys')) = 2
            ELSE 0 END
          ELSE 0 END = 1
      )
      AND EXISTS (SELECT 1 FROM speech_route_evidence e
        WHERE e.id = ? AND e.tenant_id = ? AND e.audience = ? AND e.route_id = ? AND e.model_id = ?
          AND e.config_version = ? AND e.policy_version = ? AND e.implementation_revision = ?
          AND e.expires_at > ? AND e.revoked_at IS NULL)
  `)
    .bind(
      sessionId,
      input.tenantId,
      input.audience,
      input.licenseJti,
      input.deviceId,
      input.captureGeneration,
      input.routeId,
      input.model,
      input.configVersion,
      input.language ?? null,
      input.tracks.length,
      input.maxReservedMs,
      input.consentIssuedAt,
      input.consentExpiresAt,
      JSON.stringify(input.tracks),
      input.policyVersion,
      input.implementationRevision,
      input.routeEvidenceId,
      input.evidenceExpiresAt,
      budgetWindowStart,
      input.now,
      grantExpiresAt,
      leaseExpiresAt,
      input.licenseExpiresAt,
      input.tenantId,
      input.audience,
      input.now,
      input.maxSessions,
      input.tenantId,
      input.audience,
      input.now,
      input.tracks.length,
      input.maxTracks,
      input.tenantId,
      input.audience,
      budgetWindowStart,
      input.maxReservedMs,
      input.budgetMaxMs,
      input.deviceId,
      input.licenseJti,
      input.licenseExpiresAt,
      input.now,
      input.deviceId,
      input.routeEvidenceId,
      input.tenantId,
      input.audience,
      input.routeId,
      input.model,
      input.configVersion,
      input.policyVersion,
      input.implementationRevision,
      input.now
    )
  const grantStatements = grants.flatMap((grant) => [
    db
      .prepare(`INSERT INTO speech_capture_epochs (
      tenant_id, audience, license_jti, device_id, capture_generation, track, last_epoch, expires_at, updated_at
    ) SELECT ?, ?, ?, ?, ?, ?, 1, ?, ? WHERE EXISTS (
      SELECT 1 FROM speech_sessions WHERE id = ? AND status = 'active'
    ) ON CONFLICT(tenant_id, audience, license_jti, device_id, capture_generation, track)
      DO UPDATE SET last_epoch = speech_capture_epochs.last_epoch + 1,
        expires_at = MAX(speech_capture_epochs.expires_at, excluded.expires_at), updated_at = excluded.updated_at`)
      .bind(
        input.tenantId,
        input.audience,
        input.licenseJti,
        input.deviceId,
        input.captureGeneration,
        grant.track,
        leaseExpiresAt,
        input.now,
        sessionId
      ),
    db
      .prepare(`
    INSERT INTO speech_grants (
      id, session_id, token_hash, tenant_id, audience, license_jti, device_id, track,
      capture_generation, route_id, model_id, config_version, stream_epoch, language, issued_at, expires_at, redeemed_at, revoked_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ce.last_epoch, ?, ?, ?, NULL, NULL
    FROM speech_capture_epochs ce
    WHERE ce.tenant_id = ? AND ce.audience = ? AND ce.license_jti = ? AND ce.device_id = ?
      AND ce.capture_generation = ? AND ce.track = ? AND ce.updated_at = ?
      AND EXISTS (SELECT 1 FROM speech_sessions WHERE id = ? AND status = 'active')
  `)
      .bind(
        grant.id,
        sessionId,
        grant.tokenHash,
        input.tenantId,
        input.audience,
        input.licenseJti,
        input.deviceId,
        grant.track,
        input.captureGeneration,
        input.routeId,
        input.model,
        input.configVersion,
        input.language ?? null,
        input.now,
        grantExpiresAt,
        input.tenantId,
        input.audience,
        input.licenseJti,
        input.deviceId,
        input.captureGeneration,
        grant.track,
        input.now,
        sessionId
      )
  ])
  try {
    const results = await db.batch([reserve, ...grantStatements])
    if (
      results.length !== grantStatements.length + 1 ||
      results.some((result) => result.success !== true || dbChanges(result) !== 1)
    ) {
      return { ok: false, code: 'DATABASE_UNAVAILABLE' }
    }
  } catch {
    return { ok: false, code: 'DATABASE_UNAVAILABLE' }
  }
  let created: { id: string; grant_count: number } | null
  try {
    created = await db
      .prepare(`SELECT s.id,
      (SELECT COUNT(*) FROM speech_grants g WHERE g.session_id = s.id) AS grant_count
      FROM speech_sessions s WHERE s.id = ? AND s.status = ?`)
      .bind(sessionId, 'active')
      .first<{ id: string; grant_count: number }>()
  } catch {
    return { ok: false, code: 'DATABASE_UNAVAILABLE' }
  }
  if (!created || created.grant_count !== input.tracks.length) {
    if (created) {
      try {
        await db.batch([
          db
            .prepare(
              'UPDATE speech_grants SET revoked_at = COALESCE(revoked_at, ?) WHERE session_id = ? AND redeemed_at IS NULL'
            )
            .bind(input.now, sessionId),
          db
            .prepare(
              "UPDATE speech_sessions SET status = 'cancelled', reserved_ms = 0 WHERE id = ? AND status = 'active'"
            )
            .bind(sessionId)
        ])
      } catch {
        /* the absent token response is still safe; lease expiry also closes the reservation */
      }
    }
    try {
      const active = await db
        .prepare(`
        SELECT
          (SELECT COUNT(*) FROM speech_sessions ss WHERE tenant_id = ? AND audience = ? AND status = 'active'
            AND (lease_expires_at > ? OR EXISTS (SELECT 1 FROM speech_streams st WHERE st.session_id = ss.id
              AND st.transport_attempted_at IS NOT NULL AND st.close_confirmed_at IS NULL))) AS sessions,
          COALESCE((SELECT SUM(track_count) FROM speech_sessions ss WHERE tenant_id = ? AND audience = ? AND status = 'active'
            AND (lease_expires_at > ? OR EXISTS (SELECT 1 FROM speech_streams st WHERE st.session_id = ss.id
              AND st.transport_attempted_at IS NOT NULL AND st.close_confirmed_at IS NULL))), 0) AS tracks,
          COALESCE((SELECT SUM(reserved_ms + settled_ms) FROM speech_sessions WHERE tenant_id = ? AND audience = ? AND budget_window_start = ?), 0) AS budget
      `)
        .bind(
          input.tenantId,
          input.audience,
          input.now,
          input.tenantId,
          input.audience,
          input.now,
          input.tenantId,
          input.audience,
          budgetWindowStart
        )
        .first<{ sessions: number; tracks: number; budget: number }>()
      if (!active) return { ok: false, code: 'DATABASE_UNAVAILABLE' }
      if (active.sessions >= input.maxSessions || active.tracks + input.tracks.length > input.maxTracks) {
        return { ok: false, code: 'CONCURRENCY_LIMIT' }
      }
      return { ok: false, code: 'BUDGET_LIMIT' }
    } catch {
      return { ok: false, code: 'DATABASE_UNAVAILABLE' }
    }
  }
  let epochs: Array<{ track: SpeechTrack; stream_epoch: number }>
  try {
    const rows = await db
      .prepare(`SELECT track, stream_epoch FROM speech_grants WHERE session_id = ? ORDER BY track`)
      .bind(sessionId)
      .all<{ track: SpeechTrack; stream_epoch: number }>()
    epochs = rows.results
    if (
      epochs.length !== input.tracks.length ||
      epochs.some((row) => !Number.isSafeInteger(row.stream_epoch) || row.stream_epoch <= 0)
    )
      return { ok: false, code: 'DATABASE_UNAVAILABLE' }
  } catch {
    return { ok: false, code: 'DATABASE_UNAVAILABLE' }
  }
  return {
    ok: true,
    sessionId,
    grantExpiresAt,
    leaseExpiresAt,
    grants: grants.map(({ track, token }) => ({
      track,
      token,
      streamEpoch: epochs.find((row) => row.track === track)!.stream_epoch
    }))
  }
}

/**
 * Consumes one token exactly once. The SQL checks every immutable grant binding plus the current
 * device/license binding and both required entitlements in the same conditional write. The relay
 * must resolve current route privacy/consumer policy before calling this function.
 */
export async function redeemSpeechGrant(
  db: D1DatabaseLike | undefined,
  token: string,
  binding: SpeechGrantBinding
): Promise<{ ok: true } | { ok: false; code: GrantFailureCode }> {
  if (!db || !Number.isSafeInteger(binding.now)) return { ok: false, code: 'DATABASE_UNAVAILABLE' }
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { ok: false, code: 'GRANT_REJECTED' }
  const tokenHash = await sha256Hex(token)
  try {
    const result = await db
      .prepare(`
      UPDATE speech_grants SET redeemed_at = ?
      WHERE token_hash = ? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?
        AND tenant_id = ? AND audience = ? AND license_jti = ? AND device_id = ?
        AND session_id = ? AND track = ? AND capture_generation = ? AND route_id = ?
        AND model_id = ? AND config_version = ? AND language IS ?
        AND EXISTS (
          SELECT 1 FROM speech_sessions ss
          JOIN issued_licenses il ON il.jti = ss.license_jti
          JOIN seats s ON s.device_id = ss.device_id
          JOIN tiers t ON t.id = COALESCE(il.tier, 'metis')
          WHERE ss.id = speech_grants.session_id AND ss.status = 'active'
            AND ss.tenant_id = ? AND ss.audience = ? AND ss.license_jti = ? AND ss.device_id = ?
            AND ss.capture_generation = ? AND ss.route_id = ? AND ss.model_id = ? AND ss.config_version = ? AND ss.language IS ?
            AND CASE WHEN json_valid(ss.consented_tracks_json) = 1 THEN CASE WHEN json_type(ss.consented_tracks_json) = 'array'
              THEN json_array_length(ss.consented_tracks_json) = ss.track_count
                AND NOT EXISTS (SELECT 1 FROM json_each(ss.consented_tracks_json) WHERE type != 'text')
                AND EXISTS (SELECT 1 FROM json_each(ss.consented_tracks_json) WHERE value = speech_grants.track)
              ELSE 0 END ELSE 0 END = 1
            AND ss.lease_expires_at > ? AND ss.license_expires_at > ?
            AND il.revoked = 0 AND il.exp * 1000 > ? AND il.activated_device = ss.device_id
            AND s.license_jti = ss.license_jti AND LOWER(TRIM(COALESCE(s.approval, ''))) != 'revoked'
            AND CASE WHEN json_valid(t.entitlements_json) = 1 THEN
              CASE WHEN json_type(t.entitlements_json) = 'array' THEN
                NOT EXISTS (SELECT 1 FROM json_each(t.entitlements_json) WHERE type != 'text')
                AND (SELECT COUNT(DISTINCT value) FROM json_each(t.entitlements_json)
                     WHERE value IN ('listen', 'operator_keys')) = 2
              ELSE 0 END
            ELSE 0 END = 1
        )
    `)
      .bind(
        binding.now,
        tokenHash,
        binding.now,
        binding.tenantId,
        binding.audience,
        binding.licenseJti,
        binding.deviceId,
        binding.sessionId,
        binding.track,
        binding.captureGeneration,
        binding.routeId,
        binding.model,
        binding.configVersion,
        binding.language ?? null,
        binding.tenantId,
        binding.audience,
        binding.licenseJti,
        binding.deviceId,
        binding.captureGeneration,
        binding.routeId,
        binding.model,
        binding.configVersion,
        binding.language ?? null,
        binding.now,
        binding.now,
        binding.now
      )
      .run()
    const changes = dbChanges(result)
    return changes === 1 ? { ok: true } : { ok: false, code: 'GRANT_REJECTED' }
  } catch {
    return { ok: false, code: 'DATABASE_UNAVAILABLE' }
  }
}

/** Consumes a grant and durably creates its attempted stream row in one D1 transaction. */
export async function consumeSpeechGrantForRelay(
  db: D1DatabaseLike | undefined,
  token: string,
  binding: SpeechRelayBinding
): Promise<{ ok: true; streamId: string } | { ok: false; code: GrantFailureCode }> {
  if (!hasAtomicBatch(db)) return { ok: false, code: 'DATABASE_UNAVAILABLE' }
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    !Number.isSafeInteger(binding.now) ||
    !Number.isSafeInteger(binding.streamEpoch ?? 1)
  )
    return { ok: false, code: 'GRANT_REJECTED' }
  const tokenHash = await sha256Hex(token)
  const streamId = crypto.randomUUID()
  try {
    const results = await db.batch([
      db
        .prepare(`UPDATE speech_grants SET redeemed_at = ?
        WHERE token_hash = ? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?
          AND tenant_id = ? AND audience = ? AND license_jti = ? AND device_id = ? AND session_id = ?
          AND track = ? AND capture_generation = ? AND route_id = ? AND model_id = ? AND config_version = ?
          AND stream_epoch = ? AND language IS ?
          AND EXISTS (SELECT 1 FROM speech_sessions ss
            JOIN issued_licenses il ON il.jti = ss.license_jti
            JOIN seats s ON s.device_id = ss.device_id
            JOIN tiers t ON t.id = COALESCE(il.tier, 'metis')
            JOIN speech_route_evidence e ON e.id = ss.route_evidence_id
            WHERE ss.id = speech_grants.session_id AND ss.status = 'active' AND ss.stop_requested_at IS NULL
              AND ss.tenant_id = ? AND ss.audience = ? AND ss.license_jti = ? AND ss.device_id = ?
              AND ss.capture_generation = ? AND ss.route_id = ? AND ss.model_id = ? AND ss.config_version = ?
              AND ss.policy_version = ? AND ss.implementation_revision = ? AND ss.route_evidence_id = ?
              AND ss.language IS ? AND speech_grants.stream_epoch = ?
              AND CASE WHEN json_valid(ss.consented_tracks_json) = 1 THEN CASE WHEN json_type(ss.consented_tracks_json) = 'array'
                THEN json_array_length(ss.consented_tracks_json) = ss.track_count
                  AND NOT EXISTS (SELECT 1 FROM json_each(ss.consented_tracks_json) WHERE type != 'text')
                  AND EXISTS (SELECT 1 FROM json_each(ss.consented_tracks_json) WHERE value = speech_grants.track)
                ELSE 0 END ELSE 0 END = 1
              AND ss.lease_expires_at > ? AND ss.license_expires_at > ?
              AND ss.consent_issued_at <= ? AND ss.consent_expires_at > ? AND ss.evidence_expires_at > ?
              AND e.tenant_id = ss.tenant_id AND e.audience = ss.audience AND e.route_id = ss.route_id
              AND e.model_id = ss.model_id AND e.config_version = ss.config_version
              AND e.policy_version = ss.policy_version AND e.implementation_revision = ss.implementation_revision
              AND e.expires_at > ? AND e.revoked_at IS NULL
              AND il.revoked = 0 AND il.exp * 1000 > ? AND il.activated_device = ss.device_id
              AND s.license_jti = ss.license_jti AND LOWER(TRIM(COALESCE(s.approval, ''))) != 'revoked'
              AND CASE WHEN json_valid(t.entitlements_json) = 1 THEN CASE WHEN json_type(t.entitlements_json) = 'array' THEN
                NOT EXISTS (SELECT 1 FROM json_each(t.entitlements_json) WHERE type != 'text')
                AND (SELECT COUNT(DISTINCT value) FROM json_each(t.entitlements_json) WHERE value IN ('listen','operator_keys')) = 2
                ELSE 0 END ELSE 0 END = 1)`)
        .bind(
          binding.now,
          tokenHash,
          binding.now,
          binding.tenantId,
          binding.audience,
          binding.licenseJti,
          binding.deviceId,
          binding.sessionId,
          binding.track,
          binding.captureGeneration,
          binding.routeId,
          binding.model,
          binding.configVersion,
          binding.streamEpoch ?? 1,
          binding.language ?? null,
          binding.tenantId,
          binding.audience,
          binding.licenseJti,
          binding.deviceId,
          binding.captureGeneration,
          binding.routeId,
          binding.model,
          binding.configVersion,
          binding.policyVersion,
          binding.implementationRevision,
          binding.routeEvidenceId,
          binding.language ?? null,
          binding.streamEpoch ?? 1,
          binding.now,
          binding.now,
          binding.now,
          binding.now,
          binding.now,
          binding.now,
          binding.now
        ),
      db
        .prepare(`INSERT INTO speech_streams (
        id, session_id, grant_id, tenant_id, audience, license_jti, device_id, track, capture_generation,
        stream_epoch, route_id, model_id, config_version, policy_version, implementation_revision,
        created_at
      ) SELECT ?, ?, g.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM speech_grants g WHERE g.token_hash = ? AND g.redeemed_at = ? AND g.revoked_at IS NULL`)
        .bind(
          streamId,
          binding.sessionId,
          binding.tenantId,
          binding.audience,
          binding.licenseJti,
          binding.deviceId,
          binding.track,
          binding.captureGeneration,
          binding.streamEpoch ?? 1,
          binding.routeId,
          binding.model,
          binding.configVersion,
          binding.policyVersion,
          binding.implementationRevision,
          binding.now,
          tokenHash,
          binding.now
        )
    ])
    if (
      results.length !== 2 ||
      results.some((result) => result.success !== true) ||
      dbChanges(results[0]) !== 1 ||
      dbChanges(results[1]) !== 1
    )
      return { ok: false, code: 'GRANT_REJECTED' }
    return { ok: true, streamId }
  } catch {
    return { ok: false, code: 'DATABASE_UNAVAILABLE' }
  }
}

export async function markSpeechTransportAttempted(
  db: D1DatabaseLike | undefined,
  streamId: string,
  binding: SpeechRelayBinding
): Promise<boolean> {
  const now = binding.now
  if (!db || !streamId || !Number.isSafeInteger(now)) return false
  try {
    const result = await db
      .prepare(`UPDATE speech_streams SET transport_attempted_at = ?
      WHERE id = ? AND tenant_id = ? AND audience = ? AND license_jti = ? AND device_id = ?
        AND capture_generation = ? AND route_id = ? AND model_id = ? AND config_version = ? AND policy_version = ?
        AND implementation_revision = ? AND stream_epoch = ? AND track = ?
        AND transport_attempted_at IS NULL AND close_confirmed_at IS NULL
        AND EXISTS (SELECT 1 FROM speech_sessions ss JOIN issued_licenses il ON il.jti = ss.license_jti
          JOIN seats s ON s.device_id = ss.device_id JOIN tiers t ON t.id = COALESCE(il.tier, 'metis')
          JOIN speech_route_evidence e ON e.id = ss.route_evidence_id
          WHERE ss.id = speech_streams.session_id AND ss.id = ? AND ss.status = 'active' AND ss.stop_requested_at IS NULL
            AND ss.tenant_id = ? AND ss.audience = ? AND ss.license_jti = ? AND ss.device_id = ?
            AND ss.capture_generation = ? AND ss.route_id = ? AND ss.model_id = ? AND ss.config_version = ?
            AND ss.policy_version = ? AND ss.implementation_revision = ? AND ss.route_evidence_id = ?
            AND ss.language IS ? AND speech_streams.stream_epoch = ? AND speech_streams.track = ?
            AND ss.lease_expires_at > ? AND ss.license_expires_at > ? AND ss.consent_issued_at <= ? AND ss.consent_expires_at > ?
            AND ss.evidence_expires_at > ? AND il.revoked = 0 AND il.exp * 1000 > ?
            AND il.activated_device = ss.device_id AND s.license_jti = ss.license_jti
            AND LOWER(TRIM(COALESCE(s.approval, ''))) != 'revoked'
            AND e.tenant_id = ss.tenant_id AND e.audience = ss.audience AND e.route_id = ss.route_id
            AND e.model_id = ss.model_id AND e.config_version = ss.config_version
            AND e.policy_version = ss.policy_version AND e.implementation_revision = ss.implementation_revision
            AND e.revoked_at IS NULL AND e.expires_at > ?
            AND CASE WHEN json_valid(ss.consented_tracks_json) = 1 THEN CASE WHEN json_type(ss.consented_tracks_json) = 'array'
              THEN json_array_length(ss.consented_tracks_json) = ss.track_count
                AND NOT EXISTS (SELECT 1 FROM json_each(ss.consented_tracks_json) WHERE type != 'text')
                AND EXISTS (SELECT 1 FROM json_each(ss.consented_tracks_json) WHERE value = speech_streams.track)
              ELSE 0 END ELSE 0 END = 1
            AND CASE WHEN json_valid(t.entitlements_json) = 1 THEN CASE WHEN json_type(t.entitlements_json) = 'array'
              THEN NOT EXISTS (SELECT 1 FROM json_each(t.entitlements_json) WHERE type != 'text')
                AND (SELECT COUNT(DISTINCT value) FROM json_each(t.entitlements_json) WHERE value IN ('listen','operator_keys')) = 2
              ELSE 0 END ELSE 0 END = 1)`)
      .bind(
        now,
        streamId,
        binding.tenantId,
        binding.audience,
        binding.licenseJti,
        binding.deviceId,
        binding.captureGeneration,
        binding.routeId,
        binding.model,
        binding.configVersion,
        binding.policyVersion,
        binding.implementationRevision,
        binding.streamEpoch ?? 1,
        binding.track,
        binding.sessionId,
        binding.tenantId,
        binding.audience,
        binding.licenseJti,
        binding.deviceId,
        binding.captureGeneration,
        binding.routeId,
        binding.model,
        binding.configVersion,
        binding.policyVersion,
        binding.implementationRevision,
        binding.routeEvidenceId,
        binding.language ?? null,
        binding.streamEpoch ?? 1,
        binding.track,
        now,
        now,
        now,
        now,
        now,
        now,
        now
      )
      .run()
    return dbChanges(result) === 1
  } catch {
    return false
  }
}

/** Releases only a stream that was durably redeemed but never dialed upstream. */
export async function releaseSpeechStreamBeforeDial(
  db: D1DatabaseLike | undefined,
  streamId: string,
  now: number
): Promise<boolean> {
  if (!hasAtomicBatch(db) || !streamId || !Number.isSafeInteger(now)) return false
  try {
    const results = await db.batch([
      db
        .prepare(`UPDATE speech_streams SET close_confirmed_at = ?, settled_at = ?, terminal_reason = 'revoked'
        WHERE id = ? AND transport_attempted_at IS NULL AND close_confirmed_at IS NULL`)
        .bind(now, now, streamId),
      db
        .prepare(`UPDATE speech_sessions SET
          status = CASE WHEN stop_requested_at IS NOT NULL THEN 'cancelled' ELSE 'expired' END,
          terminal_at = COALESCE(terminal_at, ?), terminal_reason = CASE WHEN stop_requested_at IS NOT NULL THEN 'cancelled' ELSE 'revoked' END,
          settled_ms = CASE WHEN settled_ms = 0 AND EXISTS (SELECT 1 FROM speech_streams
            WHERE session_id = speech_sessions.id AND transport_attempted_at IS NOT NULL) THEN reserved_ms ELSE settled_ms END,
          reserved_ms = 0
        WHERE id = (SELECT session_id FROM speech_streams WHERE id = ?)
          AND NOT EXISTS (SELECT 1 FROM speech_streams WHERE session_id = speech_sessions.id AND close_confirmed_at IS NULL)
          AND status = 'active'`)
        .bind(now, streamId)
    ])
    return results.length === 2 && results.every((result) => result.success === true) && dbChanges(results[0]) === 1
  } catch {
    return false
  }
}

export async function cancelSpeechSession(
  db: D1DatabaseLike | undefined,
  sessionId: string,
  binding: Pick<SpeechGrantBinding, 'tenantId' | 'audience' | 'licenseJti' | 'deviceId' | 'now'>
): Promise<{ ok: true; status: 'cancelled' | 'cancellation-requested' } | { ok: false; code: GrantFailureCode }> {
  if (!hasAtomicBatch(db) || !sessionId) return { ok: false, code: 'DATABASE_UNAVAILABLE' }
  try {
    const results = await db.batch([
      db
        .prepare(`UPDATE speech_grants SET revoked_at = COALESCE(revoked_at, ?)
        WHERE session_id = ? AND tenant_id = ? AND audience = ? AND license_jti = ? AND device_id = ?
          AND redeemed_at IS NULL`)
        .bind(binding.now, sessionId, binding.tenantId, binding.audience, binding.licenseJti, binding.deviceId),
      db
        .prepare(`UPDATE speech_sessions SET stop_requested_at = COALESCE(stop_requested_at, ?),
        status = CASE WHEN EXISTS (SELECT 1 FROM speech_streams WHERE session_id = ? AND transport_attempted_at IS NOT NULL AND close_confirmed_at IS NULL)
          THEN 'active' ELSE 'cancelled' END,
        terminal_at = CASE WHEN EXISTS (SELECT 1 FROM speech_streams WHERE session_id = ? AND transport_attempted_at IS NOT NULL AND close_confirmed_at IS NULL)
          THEN NULL ELSE COALESCE(terminal_at, ?) END,
        terminal_reason = CASE WHEN EXISTS (SELECT 1 FROM speech_streams WHERE session_id = ? AND transport_attempted_at IS NOT NULL AND close_confirmed_at IS NULL)
          THEN terminal_reason ELSE 'cancelled' END,
        settled_ms = CASE WHEN settled_ms = 0 AND EXISTS (SELECT 1 FROM speech_streams
          WHERE session_id = ? AND transport_attempted_at IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM speech_streams
            WHERE session_id = ? AND transport_attempted_at IS NOT NULL AND close_confirmed_at IS NULL)
          THEN reserved_ms ELSE settled_ms END,
        reserved_ms = CASE WHEN EXISTS (SELECT 1 FROM speech_streams WHERE session_id = ? AND transport_attempted_at IS NOT NULL AND close_confirmed_at IS NULL)
          THEN reserved_ms ELSE 0 END
        WHERE id = ? AND tenant_id = ? AND audience = ? AND license_jti = ? AND device_id = ? AND status = 'active'`)
        .bind(
          binding.now,
          sessionId,
          sessionId,
          binding.now,
          sessionId,
          sessionId,
          sessionId,
          sessionId,
          sessionId,
          binding.tenantId,
          binding.audience,
          binding.licenseJti,
          binding.deviceId
        ),
      db
        .prepare(`UPDATE speech_streams SET stop_requested_at = COALESCE(stop_requested_at, ?)
          WHERE session_id = ? AND close_confirmed_at IS NULL AND EXISTS (SELECT 1 FROM speech_sessions ss
            WHERE ss.id = speech_streams.session_id AND ss.tenant_id = ? AND ss.audience = ?
              AND ss.license_jti = ? AND ss.device_id = ?)`)
        .bind(binding.now, sessionId, binding.tenantId, binding.audience, binding.licenseJti, binding.deviceId)
    ])
    if (results.length !== 3 || results.some((result) => result.success !== true))
      return { ok: false, code: 'DATABASE_UNAVAILABLE' }
    const row = await db
      .prepare(`SELECT status, stop_requested_at FROM speech_sessions
      WHERE id = ? AND tenant_id = ? AND audience = ? AND license_jti = ? AND device_id = ?`)
      .bind(sessionId, binding.tenantId, binding.audience, binding.licenseJti, binding.deviceId)
      .first<{ status: string; stop_requested_at: number | null }>()
    if (!row) return { ok: false, code: 'SESSION_NOT_FOUND' }
    if (row.status === 'cancelled' || row.status === 'expired') return { ok: true, status: 'cancelled' }
    if (row.status === 'active' && row.stop_requested_at !== null) return { ok: true, status: 'cancellation-requested' }
    return { ok: false, code: 'DATABASE_UNAVAILABLE' }
  } catch {
    return { ok: false, code: 'DATABASE_UNAVAILABLE' }
  }
}

export async function confirmSpeechStreamClosed(
  db: D1DatabaseLike | undefined,
  streamId: string,
  now: number,
  reason:
    | 'normal'
    | 'cancelled'
    | 'lease-expired'
    | 'upstream-error'
    | 'client-disconnected'
    | 'limit'
    | 'revoked'
    | 'unknown',
  counters: {
    inputBytes: number
    inputMessages: number
    outputBytes: number
    outputMessages: number
    lastSequence?: number
    tailStatus?: 'complete' | 'incomplete'
    finishRequestedAt?: number | null
    providerCompleteAt?: number | null
  }
): Promise<boolean> {
  if (!hasAtomicBatch(db) || !streamId || !Number.isSafeInteger(now)) return false
  const values = [
    counters.inputBytes,
    counters.inputMessages,
    counters.outputBytes,
    counters.outputMessages,
    counters.lastSequence ?? 0,
    counters.finishRequestedAt ?? 0,
    counters.providerCompleteAt ?? 0
  ]
  if (
    values.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    (counters.tailStatus !== undefined && counters.tailStatus !== 'complete' && counters.tailStatus !== 'incomplete')
  )
    return false
  try {
    const results = await db.batch([
      db
        .prepare(`UPDATE speech_streams SET close_confirmed_at = COALESCE(close_confirmed_at, ?),
          terminal_reason = COALESCE(terminal_reason, ?), input_bytes = ?, input_messages = ?, output_bytes = ?, output_messages = ?,
          last_sequence = MAX(last_sequence, ?), tail_status = COALESCE(tail_status, ?),
          finish_requested_at = COALESCE(finish_requested_at, ?), provider_complete_at = COALESCE(provider_complete_at, ?)
        WHERE id = ? AND transport_attempted_at IS NOT NULL`)
        .bind(
          now,
          reason,
          counters.inputBytes,
          counters.inputMessages,
          counters.outputBytes,
          counters.outputMessages,
          counters.lastSequence ?? 0,
          counters.tailStatus ?? 'incomplete',
          counters.finishRequestedAt ?? null,
          counters.providerCompleteAt ?? null,
          streamId
        ),
      db
        .prepare(`UPDATE speech_sessions SET
          status = CASE WHEN stop_requested_at IS NOT NULL THEN 'cancelled' ELSE 'expired' END,
          terminal_at = COALESCE(terminal_at, ?),
          terminal_reason = CASE WHEN stop_requested_at IS NOT NULL THEN 'cancelled' ELSE COALESCE(terminal_reason, ?) END,
          settled_ms = CASE WHEN settled_ms = 0 THEN reserved_ms ELSE settled_ms END,
          reserved_ms = 0
        WHERE id = (SELECT session_id FROM speech_streams WHERE id = ?)
          AND NOT EXISTS (SELECT 1 FROM speech_streams WHERE session_id = speech_sessions.id AND close_confirmed_at IS NULL)
          AND status = 'active'`)
        .bind(now, reason, streamId),
      db
        .prepare(`UPDATE speech_streams SET settled_at = COALESCE(settled_at, ?)
        WHERE session_id = (SELECT session_id FROM speech_streams WHERE id = ?)
          AND close_confirmed_at IS NOT NULL AND settled_at IS NULL`)
        .bind(now, streamId)
    ])
    return results.length === 3 && results.every((result) => result.success === true) && dbChanges(results[0]) === 1
  } catch {
    return false
  }
}

/** Expiry cleanup is scoped to the named tenant/audience and preserves any reservation with a redeemed grant. */
export async function expireSpeechSessions(
  db: D1DatabaseLike | undefined,
  now: number,
  tenantId: string,
  audience: string
): Promise<{ ok: true; expired: number } | { ok: false; code: GrantFailureCode }> {
  if (!hasAtomicBatch(db)) return { ok: false, code: 'DATABASE_UNAVAILABLE' }
  try {
    const results = await db.batch([
      db
        .prepare(`UPDATE speech_sessions SET stop_requested_at = COALESCE(stop_requested_at, ?)
        WHERE tenant_id = ? AND audience = ? AND status = 'active' AND lease_expires_at <= ?
          AND EXISTS (SELECT 1 FROM speech_streams WHERE session_id = speech_sessions.id
            AND transport_attempted_at IS NOT NULL AND close_confirmed_at IS NULL)`)
        .bind(now, tenantId, audience, now),
      db
        .prepare(`UPDATE speech_streams SET stop_requested_at = COALESCE(stop_requested_at, ?)
        WHERE tenant_id = ? AND audience = ? AND close_confirmed_at IS NULL
          AND EXISTS (SELECT 1 FROM speech_sessions WHERE id = speech_streams.session_id
            AND status = 'active' AND lease_expires_at <= ?)`)
        .bind(now, tenantId, audience, now),
      db
        .prepare(`UPDATE speech_sessions SET status = 'expired', terminal_at = COALESCE(terminal_at, ?),
        terminal_reason = COALESCE(terminal_reason, 'lease-expired'),
        settled_ms = CASE WHEN settled_ms = 0 AND EXISTS (SELECT 1 FROM speech_streams
          WHERE session_id = speech_sessions.id AND transport_attempted_at IS NOT NULL) THEN reserved_ms ELSE settled_ms END,
        reserved_ms = 0
        WHERE tenant_id = ? AND audience = ? AND status = 'active' AND lease_expires_at <= ?
          AND NOT EXISTS (SELECT 1 FROM speech_streams WHERE session_id = speech_sessions.id
            AND transport_attempted_at IS NOT NULL AND close_confirmed_at IS NULL)`)
        .bind(now, tenantId, audience, now),
      db
        .prepare(`UPDATE speech_grants SET revoked_at = COALESCE(revoked_at, ?)
        WHERE tenant_id = ? AND audience = ? AND redeemed_at IS NULL AND revoked_at IS NULL
          AND EXISTS (SELECT 1 FROM speech_sessions WHERE id = speech_grants.session_id AND status = 'expired')`)
        .bind(now, tenantId, audience),
      db
        .prepare(`DELETE FROM speech_capture_epochs WHERE tenant_id = ? AND audience = ? AND expires_at <= ?`)
        .bind(tenantId, audience, now)
    ])
    const changes = dbChanges(results[2])
    if (results.length !== 5 || results.some((result) => result.success !== true) || changes === null) {
      return { ok: false, code: 'DATABASE_UNAVAILABLE' }
    }
    return { ok: true, expired: changes }
  } catch {
    return { ok: false, code: 'DATABASE_UNAVAILABLE' }
  }
}
