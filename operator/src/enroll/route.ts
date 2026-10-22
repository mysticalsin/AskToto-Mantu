/**
 * `POST /v1/enroll` (O04): zero-config device enrolment. A device that has no licence asks the Worker for
 * one, proving who it is in one of three ways, and receives a per-device METIS-OP-1 licence it can use for
 * the existing heartbeat/ingest protocol. The licence string is returned once and never stored (only its
 * hash and last4, by `mintOperatorLicense`, the single minting path).
 *
 *   method   credential                          signed with           mints
 *   sso      body `idToken` (Entra v2 ID token)  the idToken           origin sso-enroll, tier = `enroll.sso_tier`, 90 d
 *   token    header `x-metis-enroll` token       the enrolment token   origin token-enroll, tier `reporting`, <= 30 d
 *   renew    header `x-metis-license` licence    the licence           same origin and tier as the presented licence
 *
 * Every request carries the standard HMAC headers (`x-metis-ts/nonce/device/sig`). The HMAC key is the
 * credential the request presents, so the signature gives integrity, freshness and nonce replay protection,
 * not secrecy (TLS gives that). An SSO token upgrade is `method: 'sso'` that also presents the device's
 * current licence header: the new licence supersedes it.
 *
 * Ordering is deliberate. Cheap, storage-free checks run first (method, content type, size, per-IP limiter);
 * a nonce, an `uti`, a rate bucket or a token slot is consumed only by a request that already proved its
 * credential, so an anonymous caller cannot burn a real user's token or fill the nonce/rate tables. A refused
 * request writes nothing except one deduplicated audit row (per device, per code, per hour, plus a global
 * hourly cap) and its rate-limit counters.
 */
import { OPERATOR_HMAC_HEADERS, OPERATOR_LICENSE_HEADER } from '../../../src/shared/operator-hmac'
import { parseOperatorLicense, verifyOperatorLicense } from '../../../src/shared/operator-license'
import { sha256Hex } from '../crypto'
import { verifyDeviceRequest } from '../device-auth'
import { ssoConfigFromEnv, verifyEntraIdToken } from '../entra-idtoken'
import { isApprovedSeat, issuedLicenseActive } from '../fleet'
import { DEVICE_ID_RE, verifyIngestHmac } from '../hmac'
import { json } from '../http'
import { mintOperatorLicense } from '../licenses/generate'
import { safeAuditText, type AdminCtx, type Env, type HandleOpts } from '../routes/admin-ctx'
import type { IssuedLicenseRow, OperatorStore, SeatRow } from '../store'
import { readEnrollSettings } from './settings'
import {
  authenticateEnrollToken,
  ENROLL_TOKEN_HEADER,
  ENROLL_TOKEN_TIER,
  TOKEN_LICENSE_MAX_DAYS,
  utcDayStart
} from './tokens'

export const ENROLL_MAX_BODY_BYTES = 8 * 1024
export const SSO_LICENSE_DAYS = 90
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
/** "Come back later" hint for states the Worker is deliberately in (paused, unreachable Worker features). */
const LATER_MS = 6 * HOUR_MS

const DEVICE_WINDOW_MS = 10 * 60 * 1000
const DEVICE_MAX = 5
const TOKEN_WINDOW_MS = 60 * 1000
const TOKEN_MAX = 120
const RE_ENROLL_WINDOW_MS = DAY_MS
const RE_ENROLL_MAX = 3
const AUDIT_DEDUPE_MS = HOUR_MS
const AUDIT_GLOBAL_MAX_PER_HOUR = 300

export const ENROLL_ORIGIN_SSO = 'sso-enroll'
export const ENROLL_ORIGIN_TOKEN = 'token-enroll'

export type EnrollRefusalCode =
  | 'enroll-paused'
  | 'enroll-unconfigured'
  | 'enroll-unavailable'
  | 'sso-invalid'
  | 'sso-tenant'
  | 'sso-domain'
  | 'sso-stale'
  | 'sso-replay'
  | 'token-invalid'
  | 'token-revoked'
  | 'token-expired'
  | 'token-cap'
  | 'seat-revoked'
  | 'admin-licensed'
  | 'rate'
  | 'bad-request'
  | 'too-large'
  | 'signature'
  | 'license-invalid'
  | 'license-expired'
  | 'license-revoked'
  | 'license-device'

const STATUS: Record<EnrollRefusalCode, number> = {
  'enroll-paused': 503,
  'enroll-unconfigured': 503,
  'enroll-unavailable': 503,
  'sso-invalid': 401,
  'sso-tenant': 403,
  'sso-domain': 403,
  'sso-stale': 401,
  'sso-replay': 401,
  'token-invalid': 401,
  'token-revoked': 403,
  'token-expired': 403,
  'token-cap': 403,
  'seat-revoked': 403,
  'admin-licensed': 409,
  rate: 429,
  'bad-request': 400,
  'too-large': 413,
  signature: 401,
  'license-invalid': 401,
  'license-expired': 403,
  'license-revoked': 403,
  'license-device': 403
}

const MESSAGE: Record<EnrollRefusalCode, string> = {
  'enroll-paused': 'Enrolment is paused by your administrator.',
  'enroll-unconfigured': 'SSO enrolment is not configured on this Operator.',
  'enroll-unavailable': 'Enrolment is temporarily unavailable.',
  'sso-invalid': 'The sign-in proof could not be verified.',
  'sso-tenant': 'The sign-in belongs to a different organisation.',
  'sso-domain': 'The sign-in e-mail domain is not allowed.',
  'sso-stale': 'The sign-in proof is too old. Sign in again.',
  'sso-replay': 'This sign-in proof was already used.',
  'token-invalid': 'The enrolment token could not be verified.',
  'token-revoked': 'This enrolment token has been revoked.',
  'token-expired': 'This enrolment token has expired.',
  'token-cap': 'The enrolment limit has been reached.',
  'seat-revoked': 'Access for this device has been revoked.',
  'admin-licensed': 'This device already has an administrator-issued licence.',
  rate: 'Too many enrolment attempts. Try again later.',
  'bad-request': 'The enrolment request is not valid.',
  'too-large': 'The enrolment request is too large.',
  signature: 'The request signature could not be verified.',
  'license-invalid': 'This Métis licence could not be verified.',
  'license-expired': 'This Métis licence has expired.',
  'license-revoked': 'This Métis licence has been revoked.',
  'license-device': 'This Métis licence is not active on this device.'
}

type EnrollRequestMethod = 'sso' | 'token' | 'renew'

interface Fail {
  ok: false
  code: EnrollRefusalCode
  retryAfterMs?: number
}

function fail(code: EnrollRefusalCode, retryAfterMs?: number): Fail {
  return { ok: false, code, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }
}

function respondFail(f: Fail): Response {
  return json(
    {
      ok: false,
      code: f.code,
      error: MESSAGE[f.code],
      ...(f.retryAfterMs !== undefined ? { retryAfterMs: f.retryAfterMs } : {})
    },
    STATUS[f.code]
  )
}

/** Reads at most `max` bytes. null = over the cap (declared or actual); the body is never buffered past it. */
async function readCappedText(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) return null
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    merged.set(c, at)
    at += c.byteLength
  }
  return new TextDecoder().decode(merged)
}

function cleanMeta(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const v = raw
    .replace(/[^A-Za-z0-9 ._+-]/g, '')
    .trim()
    .slice(0, 32)
  return v || null
}

/** One audit row per device per code per hour, plus a global hourly cap, so refusals cannot flood the chain. */
async function auditRefusal(
  store: OperatorStore,
  deviceId: string | null,
  method: string,
  code: EnrollRefusalCode,
  now: number,
  request: Request
): Promise<void> {
  if (!deviceId) return
  try {
    if (await store.hitRate(`enroll-audit:${deviceId}:${code}`, now, AUDIT_DEDUPE_MS, 1)) return
    if (await store.hitRate('enroll-audit:global', now, AUDIT_DEDUPE_MS, AUDIT_GLOBAL_MAX_PER_HOUR)) return
    await store.audit(
      crypto.randomUUID(),
      now,
      `device:${deviceId}`,
      'enroll-refused',
      null,
      safeAuditText(`${method} · ${code}`),
      { requestId: request.headers.get('cf-ray') || undefined, route: '/v1/enroll' }
    )
  } catch {
    /* an audit failure must never change the answer the device gets */
  }
}

/** The active licence an SSO upgrade or renewal presented, proven by possession and device binding. */
async function presentedAutoLicense(
  store: OperatorStore,
  secret: string,
  header: string | null,
  deviceId: string,
  now: number
): Promise<IssuedLicenseRow | null> {
  const token = header?.trim()
  if (!token || !parseOperatorLicense(token)) return null
  const verified = await verifyOperatorLicense(secret, token, now)
  if (!verified.ok) return null
  const issued = await store.getIssuedLicense(verified.claims.jti)
  if (!issued || !issuedLicenseActive(issued, now) || !issued.origin) return null
  if (issued.activated_device !== deviceId) return null
  if (issued.key_hash !== (await sha256Hex(token))) return null
  return issued
}

async function supersedeTarget(
  store: OperatorStore,
  seat: SeatRow | null,
  deviceId: string,
  presented: IssuedLicenseRow | null,
  now: number
): Promise<string | null> {
  if (presented) return presented.jti
  if (seat?.license_jti) {
    const current = await store.getIssuedLicense(seat.license_jti)
    if (current?.origin && issuedLicenseActive(current, now)) return current.jti
  }
  // A lost response leaves an enrolled-but-never-bound licence. Replace the newest still-active one so
  // orphans do not pile up.
  for (const e of await store.listEnrollments({ deviceId, limit: 3 })) {
    const lic = await store.getIssuedLicense(e.license_jti)
    if (lic && lic.origin && issuedLicenseActive(lic, now)) return lic.jti
  }
  return null
}

export async function handleEnroll(
  request: Request,
  env: Env,
  store: OperatorStore,
  opts: HandleOpts,
  now: number
): Promise<Response> {
  if (request.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405)
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) {
    return json({ ok: false, code: 'bad-request', error: 'Enrolment requests must use application/json.' }, 415)
  }
  const rawDevice = request.headers.get(OPERATOR_HMAC_HEADERS.device) ?? ''
  const deviceId = DEVICE_ID_RE.test(rawDevice) ? rawDevice : null
  const refuse = async (method: string, f: Fail): Promise<Response> => {
    await auditRefusal(store, deviceId, method, f.code, now, request)
    return respondFail(f)
  }

  // Per-IP brake first: a Workers Rate Limiting binding keeps no state in D1, so no IP is ever stored.
  if (env.ENROLL_IP_LIMITER) {
    try {
      const ip = request.headers.get('cf-connecting-ip') || 'unknown'
      if (!(await env.ENROLL_IP_LIMITER.limit({ key: ip })).success) return respondFail(fail('rate', 60_000))
    } catch {
      /* the binding is an extra brake; its failure must not close enrolment */
    }
  }

  const bodyText = await readCappedText(request, ENROLL_MAX_BODY_BYTES)
  if (bodyText === null) return respondFail(fail('too-large'))
  let body: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(bodyText || '{}')
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return respondFail(fail('bad-request'))
    body = parsed as Record<string, unknown>
  } catch {
    return respondFail(fail('bad-request'))
  }
  const method = body.method
  if (method !== 'sso' && method !== 'token' && method !== 'renew') return respondFail(fail('bad-request'))
  if (!deviceId) return respondFail(fail('bad-request'))

  const secret = env.OPERATOR_INGEST_SECRET?.trim() || ''
  if (!secret) return refuse(method, fail('enroll-unavailable', LATER_MS))

  const settings = await readEnrollSettings(store)
  if (settings.paused) return refuse(method, fail('enroll-paused', LATER_MS))

  const consumeNonce = (nonce: string): Promise<boolean> => store.takeNonce(nonce, now)
  const hmacFail = (h: { status: number; error: string; code?: string }): Response =>
    json({ ok: false, code: 'signature', error: h.error }, h.status)

  // ---- 1. authenticate the credential for the chosen method -------------------------------------------------
  let origin: string
  let tier: string
  let days: number
  let member: string
  let actor: string
  let tokenKid: string | null = null
  let ssoOidHash: string | null = null
  let ssoEmail: string | null = null
  let presented: IssuedLicenseRow | null = null
  let enrollMethod: EnrollRequestMethod = method

  if (method === 'token') {
    const auth = await authenticateEnrollToken(store, request.headers.get(ENROLL_TOKEN_HEADER), env, now)
    if (!auth.ok) return refuse(method, fail(auth.code))
    const sig = await verifyIngestHmac(
      request,
      bodyText,
      (request.headers.get(ENROLL_TOKEN_HEADER) ?? '').trim(),
      now,
      consumeNonce
    )
    if (!sig.ok) {
      await auditRefusal(store, deviceId, method, 'signature', now, request)
      return hmacFail(sig)
    }
    if (await store.hitRate(`enroll-tok:${auth.row.kid}`, now, TOKEN_WINDOW_MS, TOKEN_MAX)) {
      return refuse(method, fail('rate', TOKEN_WINDOW_MS))
    }
    tokenKid = auth.row.kid
    origin = ENROLL_ORIGIN_TOKEN
    tier = ENROLL_TOKEN_TIER // never taken from the row: a token mints `reporting` licences only
    days = Math.min(auth.row.license_days, TOKEN_LICENSE_MAX_DAYS)
    member = `device:${deviceId}`
    actor = `device:${deviceId}`
  } else if (method === 'sso') {
    const cfg = ssoConfigFromEnv(env)
    if (!cfg) return refuse(method, fail('enroll-unconfigured', LATER_MS))
    const idToken = typeof body.idToken === 'string' ? body.idToken : ''
    const verified = await verifyEntraIdToken(idToken, cfg, {
      now,
      fetchImpl: opts.entraFetch,
      cache: opts.entraJwksCache
    })
    if (!verified.ok) {
      return refuse(
        method,
        verified.code === 'sso-unavailable' ? fail('enroll-unavailable', 30_000) : fail(verified.code)
      )
    }
    const sig = await verifyIngestHmac(request, bodyText, idToken, now, consumeNonce)
    if (!sig.ok) {
      await auditRefusal(store, deviceId, method, 'signature', now, request)
      return hmacFail(sig)
    }
    // Single use. `uti` outlives nothing it matters for: a token is refused as stale after 10 minutes, and the
    // nonce table keeps rows for 10 minutes from the moment they are written, which is never earlier than iat.
    if (await store.takeNonce(`sso:${verified.replayKey}`, now)) return refuse(method, fail('sso-replay'))
    ssoOidHash = await sha256Hex(`${verified.oid}${secret}`)
    ssoEmail = verified.email
    origin = ENROLL_ORIGIN_SSO
    tier = settings.ssoTier
    days = SSO_LICENSE_DAYS
    member = verified.email
    actor = verified.email
    presented = await presentedAutoLicense(store, secret, request.headers.get(OPERATOR_LICENSE_HEADER), deviceId, now)
  } else {
    if (request.headers.get(OPERATOR_LICENSE_HEADER) === null) return refuse(method, fail('license-invalid'))
    const auth = await verifyDeviceRequest(request, bodyText, secret, store, now)
    if (!auth.ok) {
      const code = auth.code as EnrollRefusalCode | undefined
      if (code && code in STATUS) return refuse(method, fail(code))
      await auditRefusal(store, deviceId, method, 'signature', now, request)
      return hmacFail(auth)
    }
    const license = 'license' in auth ? auth.license : undefined
    const issued = license ? await store.getIssuedLicense(license.jti) : null
    if (!issued || !issued.origin) return refuse(method, fail('admin-licensed'))
    presented = issued
    origin = issued.origin
    tier = origin === ENROLL_ORIGIN_TOKEN ? ENROLL_TOKEN_TIER : (issued.tier ?? settings.ssoTier)
    days = origin === ENROLL_ORIGIN_TOKEN ? TOKEN_LICENSE_MAX_DAYS : SSO_LICENSE_DAYS
    member = issued.member || `device:${deviceId}`
    actor = issued.member || `device:${deviceId}`
    // A renewal inherits who enrolled the device, so history and caps stay attached to the same token/user.
    const earlier = (await store.listEnrollments({ deviceId, limit: 10 })).find((e) => e.license_jti === issued.jti)
    tokenKid = earlier?.token_kid ?? null
    ssoOidHash = earlier?.sso_oid_hash ?? null
    ssoEmail = earlier?.sso_email ?? null
    enrollMethod = 'renew'
  }

  // ---- 2. per-device brakes (credential proven, so counters cannot be driven by strangers) ------------------
  if (await store.hitRate(`enroll-dev:${deviceId}`, now, DEVICE_WINDOW_MS, DEVICE_MAX)) {
    return refuse(method, fail('rate', DEVICE_WINDOW_MS))
  }

  // ---- 3. device rules --------------------------------------------------------------------------------------
  const seat = await store.getSeat(deviceId)
  if ((seat?.approval || '').trim().toLowerCase() === 'revoked') return refuse(method, fail('seat-revoked'))
  if (seat) {
    // An administrator's grant is never silently downgraded to a reporting seat: an Approve click, or an
    // active licence an admin issued (no `origin`), means this device is managed by hand.
    const current = seat.license_jti ? await store.getIssuedLicense(seat.license_jti) : null
    const adminLicence = Boolean(current && issuedLicenseActive(current, now) && !current.origin)
    if (isApprovedSeat(seat) || adminLicence) return refuse(method, fail('admin-licensed'))
  }
  if (
    (await store.countEnrollments({ deviceId, since: now - RE_ENROLL_WINDOW_MS, supersedingOnly: true })) >=
    RE_ENROLL_MAX
  ) {
    return refuse(method, fail('rate', HOUR_MS))
  }
  const supersedes = await supersedeTarget(store, seat, deviceId, presented, now)

  if (method === 'sso' && ssoOidHash) {
    const devices = await store.listActiveSsoDevices(ssoOidHash, now)
    if (!devices.includes(deviceId) && devices.length >= settings.ssoMaxDevicesPerUser) {
      return refuse(method, fail('token-cap'))
    }
  }
  if (method === 'token' && tokenKid) {
    const newDevice = (await store.countEnrollments({ deviceId, tokenKid })) === 0
    const claim = await store.claimEnrollTokenSlot(tokenKid, now, utcDayStart(now), newDevice)
    if (claim === 'cap-devices' || claim === 'cap-daily') return refuse(method, fail('token-cap'))
    if (claim === 'revoked') return refuse(method, fail('token-revoked'))
    if (claim === 'expired') return refuse(method, fail('token-expired'))
    if (claim === 'missing') return refuse(method, fail('token-invalid'))
  }

  // ---- 4. mint through the one minting path ----------------------------------------------------------------
  const mintCtx: AdminCtx = { request, url: new URL(request.url), env, store, email: actor, now, opts }
  const minted = await mintOperatorLicense(mintCtx, {
    days,
    tier,
    member,
    actor,
    action: 'enroll',
    origin,
    supersedes,
    auditDetail: ({ last4 }) => safeAuditText(`${enrollMethod} · ${tokenKid ?? '-'} · ··${last4}`)
  })
  if (!minted.ok) return refuse(method, fail('enroll-unavailable', LATER_MS))

  await store.putEnrollment({
    id: crypto.randomUUID(),
    device_id: deviceId,
    method: enrollMethod,
    token_kid: tokenKid,
    sso_oid_hash: ssoOidHash,
    sso_email: ssoEmail,
    license_jti: minted.jti,
    supersedes,
    created_at: now,
    app_version: cleanMeta(body.appVersion),
    os: cleanMeta(body.os)
  })

  return json({
    ok: true,
    license: minted.token,
    jti: minted.jti,
    last4: minted.last4,
    exp: minted.exp,
    origin: origin === ENROLL_ORIGIN_SSO ? 'sso' : 'token',
    tier: minted.tier
  })
}
