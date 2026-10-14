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
  language?: string
  track: SpeechTrack
  now: number
}

export type GrantFailureCode =
  | 'DATABASE_UNAVAILABLE'
  | 'CONCURRENCY_LIMIT'
  | 'BUDGET_LIMIT'
  | 'GRANT_REJECTED'
  | 'SESSION_NOT_FOUND'

export type AllocationResult =
  | { ok: true; sessionId: string; grantExpiresAt: number; leaseExpiresAt: number; grants: Array<{ track: SpeechTrack; token: string }> }
  | { ok: false; code: GrantFailureCode }

function hasAtomicBatch(db: D1DatabaseLike | undefined): db is D1DatabaseLike & { batch(statements: Parameters<NonNullable<D1DatabaseLike['batch']>>[0]): Promise<Array<{ success?: boolean }>> } {
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
    input.tenantId && input.audience && input.licenseJti && input.deviceId && Number.isSafeInteger(input.captureGeneration) && input.captureGeneration > 0 &&
    input.tracks.length >= 1 && input.tracks.length <= 2 && input.tracks.every((track) => track === 'microphone' || track === 'system') && new Set(input.tracks).size === input.tracks.length &&
    Number.isSafeInteger(input.now) && Number.isSafeInteger(input.licenseExpiresAt) && input.licenseExpiresAt > input.now &&
    Number.isSafeInteger(input.grantTtlMs) && input.grantTtlMs > 0 &&
    Number.isSafeInteger(input.leaseMs) && input.leaseMs > 0 &&
    Number.isSafeInteger(input.budgetWindowMs) && input.budgetWindowMs > 0 &&
    Number.isSafeInteger(input.budgetMaxMs) && input.budgetMaxMs > 0 &&
    Number.isSafeInteger(input.maxReservedMs) && input.maxReservedMs > 0 &&
    Number.isSafeInteger(input.maxSessions) && input.maxSessions > 0 &&
    Number.isSafeInteger(input.maxTracks) && input.maxTracks > 0 &&
    Number.isSafeInteger(input.leaseMs * input.tracks.length) && input.maxReservedMs >= input.leaseMs * input.tracks.length &&
    Number.isSafeInteger(input.now + input.leaseMs) && Number.isSafeInteger(input.now + input.grantTtlMs)
  )
}

export async function allocateSpeechSession(
  db: D1DatabaseLike | undefined,
  input: AllocateSpeechSessionInput
): Promise<AllocationResult> {
  if (!hasAtomicBatch(db) || !validAllocation(input)) return { ok: false, code: 'DATABASE_UNAVAILABLE' }
  const sessionId = crypto.randomUUID()
  const grantExpiresAt = Math.min(input.now + input.grantTtlMs, input.licenseExpiresAt, input.now + input.leaseMs)
  const leaseExpiresAt = Math.min(input.now + input.leaseMs, input.licenseExpiresAt)
  if (grantExpiresAt <= input.now || leaseExpiresAt <= input.now || input.maxReservedMs > input.budgetMaxMs || input.budgetMaxMs > input.budgetWindowMs) {
    return { ok: false, code: 'BUDGET_LIMIT' }
  }
  const expiry = await expireSpeechSessions(db, input.now, input.tenantId, input.audience)
  if (!expiry.ok) return { ok: false, code: 'DATABASE_UNAVAILABLE' }
  const budgetWindowStart = Math.floor(input.now / input.budgetWindowMs) * input.budgetWindowMs
  const grants = await Promise.all(input.tracks.map(async (track) => {
    const token = newOpaqueToken()
    return { id: crypto.randomUUID(), track, token, tokenHash: await sha256Hex(token) }
  }))
  const reserve = db.prepare(`
    INSERT INTO speech_sessions (
      id, tenant_id, audience, license_jti, device_id, capture_generation, route_id, model_id,
      config_version, language, status, track_count, reserved_ms, settled_ms, budget_window_start,
      created_at, grant_expires_at, lease_expires_at, license_expires_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 0, ?, ?, ?, ?, ?
    WHERE
      (SELECT COUNT(*) FROM speech_sessions WHERE tenant_id = ? AND audience = ? AND status = 'active' AND lease_expires_at > ?) < ?
      AND COALESCE((SELECT SUM(track_count) FROM speech_sessions WHERE tenant_id = ? AND audience = ? AND status = 'active' AND lease_expires_at > ?), 0) + ? <= ?
      AND COALESCE((SELECT SUM(reserved_ms) FROM speech_sessions WHERE tenant_id = ? AND audience = ? AND budget_window_start = ?), 0) + ? <= ?
      AND EXISTS (
        SELECT 1 FROM issued_licenses il
        JOIN seats s ON s.device_id = ?
        JOIN tiers t ON t.id = COALESCE(il.tier, 'metis')
        WHERE il.jti = ? AND il.revoked = 0 AND il.exp * 1000 = ? AND il.exp * 1000 > ?
          AND il.activated_device = ? AND s.license_jti = il.jti
          AND COALESCE(LOWER(s.approval), '') != 'revoked'
          AND CASE WHEN json_valid(t.entitlements_json) = 1 THEN
            CASE WHEN json_type(t.entitlements_json) = 'array' THEN
              NOT EXISTS (SELECT 1 FROM json_each(t.entitlements_json) WHERE type != 'text')
              AND (SELECT COUNT(DISTINCT value) FROM json_each(t.entitlements_json)
                   WHERE value IN ('listen', 'operator_keys')) = 2
            ELSE 0 END
          ELSE 0 END = 1
      )
  `).bind(
    sessionId, input.tenantId, input.audience, input.licenseJti, input.deviceId, input.captureGeneration,
    input.routeId, input.model, input.configVersion, input.language ?? null, input.tracks.length, input.maxReservedMs,
    budgetWindowStart, input.now, grantExpiresAt, leaseExpiresAt, input.licenseExpiresAt,
    input.tenantId, input.audience, input.now, input.maxSessions,
    input.tenantId, input.audience, input.now, input.tracks.length, input.maxTracks,
    input.tenantId, input.audience, budgetWindowStart, input.maxReservedMs, input.budgetMaxMs,
    input.deviceId, input.licenseJti, input.licenseExpiresAt, input.now, input.deviceId
  )
  const grantStatements = grants.map((grant) => db.prepare(`
    INSERT INTO speech_grants (
      id, session_id, token_hash, tenant_id, audience, license_jti, device_id, track,
      capture_generation, route_id, model_id, config_version, language, issued_at, expires_at, redeemed_at, revoked_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL
    WHERE EXISTS (SELECT 1 FROM speech_sessions WHERE id = ? AND status = 'active')
  `).bind(
    grant.id, sessionId, grant.tokenHash, input.tenantId, input.audience, input.licenseJti,
    input.deviceId, grant.track, input.captureGeneration, input.routeId, input.model, input.configVersion, input.language ?? null,
    input.now, grantExpiresAt, sessionId
  ))
  try {
    const results = await db.batch([reserve, ...grantStatements])
    if (results.length !== grantStatements.length + 1 || results.some((result) => result.success === false)) {
      return { ok: false, code: 'DATABASE_UNAVAILABLE' }
    }
  } catch {
    return { ok: false, code: 'DATABASE_UNAVAILABLE' }
  }
  let created: { id: string; grant_count: number } | null
  try {
    created = await db.prepare(`SELECT s.id,
      (SELECT COUNT(*) FROM speech_grants g WHERE g.session_id = s.id) AS grant_count
      FROM speech_sessions s WHERE s.id = ? AND s.status = ?`).bind(sessionId, 'active').first<{ id: string; grant_count: number }>()
  } catch {
    return { ok: false, code: 'DATABASE_UNAVAILABLE' }
  }
  if (!created || created.grant_count !== input.tracks.length) {
    if (created) {
      try {
        await db.batch([
          db.prepare("UPDATE speech_grants SET revoked_at = COALESCE(revoked_at, ?) WHERE session_id = ? AND redeemed_at IS NULL").bind(input.now, sessionId),
          db.prepare("UPDATE speech_sessions SET status = 'cancelled', reserved_ms = 0 WHERE id = ? AND status = 'active'").bind(sessionId)
        ])
      } catch { /* the absent token response is still safe; lease expiry also closes the reservation */ }
    }
    try {
      const active = await db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM speech_sessions WHERE tenant_id = ? AND audience = ? AND status = 'active' AND lease_expires_at > ?) AS sessions,
          COALESCE((SELECT SUM(track_count) FROM speech_sessions WHERE tenant_id = ? AND audience = ? AND status = 'active' AND lease_expires_at > ?), 0) AS tracks,
          COALESCE((SELECT SUM(reserved_ms) FROM speech_sessions WHERE tenant_id = ? AND audience = ? AND budget_window_start = ?), 0) AS budget
      `).bind(input.tenantId, input.audience, input.now, input.tenantId, input.audience, input.now, input.tenantId, input.audience, budgetWindowStart).first<{ sessions: number; tracks: number; budget: number }>()
      if (!active) return { ok: false, code: 'DATABASE_UNAVAILABLE' }
      if (active.sessions >= input.maxSessions || active.tracks + input.tracks.length > input.maxTracks) {
        return { ok: false, code: 'CONCURRENCY_LIMIT' }
      }
      return { ok: false, code: 'BUDGET_LIMIT' }
    } catch {
      return { ok: false, code: 'DATABASE_UNAVAILABLE' }
    }
  }
  return {
    ok: true,
    sessionId,
    grantExpiresAt,
    leaseExpiresAt,
    grants: grants.map(({ track, token }) => ({ track, token }))
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
  if (!db || !token || !Number.isSafeInteger(binding.now)) return { ok: false, code: 'DATABASE_UNAVAILABLE' }
  const tokenHash = await sha256Hex(token)
  try {
    const result = await db.prepare(`
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
            AND ss.lease_expires_at > ? AND ss.license_expires_at > ?
            AND il.revoked = 0 AND il.exp * 1000 > ? AND il.activated_device = ss.device_id
            AND s.license_jti = ss.license_jti AND COALESCE(LOWER(s.approval), '') != 'revoked'
            AND CASE WHEN json_valid(t.entitlements_json) = 1 THEN
              CASE WHEN json_type(t.entitlements_json) = 'array' THEN
                NOT EXISTS (SELECT 1 FROM json_each(t.entitlements_json) WHERE type != 'text')
                AND (SELECT COUNT(DISTINCT value) FROM json_each(t.entitlements_json)
                     WHERE value IN ('listen', 'operator_keys')) = 2
              ELSE 0 END
            ELSE 0 END = 1
        )
    `).bind(
      binding.now, tokenHash, binding.now, binding.tenantId, binding.audience, binding.licenseJti,
      binding.deviceId, binding.sessionId, binding.track, binding.captureGeneration, binding.routeId,
      binding.model, binding.configVersion, binding.language ?? null, binding.tenantId, binding.audience, binding.licenseJti,
      binding.deviceId, binding.captureGeneration, binding.routeId, binding.model, binding.configVersion,
      binding.language ?? null, binding.now, binding.now, binding.now
    ).run()
    const changes = dbChanges(result)
    return changes === 1 ? { ok: true } : { ok: false, code: 'GRANT_REJECTED' }
  } catch {
    return { ok: false, code: 'DATABASE_UNAVAILABLE' }
  }
}

export async function cancelSpeechSession(
  db: D1DatabaseLike | undefined,
  sessionId: string,
  binding: Pick<SpeechGrantBinding, 'tenantId' | 'audience' | 'licenseJti' | 'deviceId' | 'now'>
): Promise<{ ok: true } | { ok: false; code: GrantFailureCode }> {
  if (!hasAtomicBatch(db) || !sessionId) return { ok: false, code: 'DATABASE_UNAVAILABLE' }
  try {
    const results = await db.batch([
      db.prepare(`UPDATE speech_grants SET revoked_at = COALESCE(revoked_at, ?)
        WHERE session_id = ? AND tenant_id = ? AND audience = ? AND license_jti = ? AND device_id = ?
          AND redeemed_at IS NULL`).bind(binding.now, sessionId, binding.tenantId, binding.audience, binding.licenseJti, binding.deviceId),
      db.prepare(`UPDATE speech_sessions SET status = 'cancelled',
        reserved_ms = CASE WHEN EXISTS (SELECT 1 FROM speech_grants WHERE session_id = ? AND redeemed_at IS NOT NULL)
          THEN reserved_ms ELSE 0 END
        WHERE id = ? AND tenant_id = ? AND audience = ? AND license_jti = ? AND device_id = ? AND status = 'active'`)
        .bind(sessionId, sessionId, binding.tenantId, binding.audience, binding.licenseJti, binding.deviceId)
    ])
    if (results.length !== 2 || results.some((result) => result.success === false)) return { ok: false, code: 'DATABASE_UNAVAILABLE' }
    const row = await db.prepare(`SELECT status FROM speech_sessions
      WHERE id = ? AND tenant_id = ? AND audience = ? AND license_jti = ? AND device_id = ?`)
      .bind(sessionId, binding.tenantId, binding.audience, binding.licenseJti, binding.deviceId)
      .first<{ status: string }>()
    if (!row) return { ok: false, code: 'SESSION_NOT_FOUND' }
    if (row.status === 'cancelled' || row.status === 'expired') return { ok: true }
    return { ok: false, code: 'DATABASE_UNAVAILABLE' }
  } catch {
    return { ok: false, code: 'DATABASE_UNAVAILABLE' }
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
      db.prepare(`UPDATE speech_sessions SET status = 'expired',
        reserved_ms = CASE WHEN EXISTS (SELECT 1 FROM speech_grants WHERE session_id = speech_sessions.id AND redeemed_at IS NOT NULL)
          THEN reserved_ms ELSE 0 END
        WHERE tenant_id = ? AND audience = ? AND status = 'active' AND lease_expires_at <= ?`).bind(tenantId, audience, now),
      db.prepare(`UPDATE speech_grants SET revoked_at = COALESCE(revoked_at, ?)
        WHERE tenant_id = ? AND audience = ? AND redeemed_at IS NULL AND revoked_at IS NULL
          AND EXISTS (SELECT 1 FROM speech_sessions WHERE id = speech_grants.session_id AND status = 'expired')`).bind(now, tenantId, audience)
    ])
    const changes = dbChanges(results[0])
    if (results.length !== 2 || results.some((result) => result.success === false) || changes === null) {
      return { ok: false, code: 'DATABASE_UNAVAILABLE' }
    }
    return { ok: true, expired: changes }
  } catch {
    return { ok: false, code: 'DATABASE_UNAVAILABLE' }
  }
}
