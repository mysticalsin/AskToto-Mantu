/**
 * Zero-config Operator enrolment: the pure state machine (O07). No I/O, no clock, no Electron.
 *
 *   disabled -> unenrolled -> enrolling{sso|token|renew} -> enrolled{origin,exp} -> revoked (daily re-check)
 *
 * `disabled` is derived from the admin kill switch and `enrolling` lives in memory only. Persisted state is
 * `unenrolled | enrolled | revoked`. The glue in operator-enrollment.ts performs the requests.
 */
import { OPERATOR_LICENSE_PREFIX } from '@shared/operator-license'

export type EnrollMethod = 'sso' | 'token' | 'renew'
export type EnrollState = 'unenrolled' | 'enrolled' | 'revoked'
export type EnrollOrigin = 'admin' | 'sso' | 'token' | null
export type EnrollPhase = 'disabled' | EnrollState

/** 30 s, 2 m, 10 m, 1 h, then a 6 h cap. */
export const ENROLL_BACKOFF_SCHEDULE_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000] as const
/** enroll-paused, an old Worker (404) and Access HTML or a 3xx: wait long, never treat as revoked. */
export const ENROLL_UNREACHABLE_RETRY_MS = 6 * 60 * 60 * 1000
export const REVOKED_RECHECK_MS = 24 * 60 * 60 * 1000
export const ENROLL_RENEW_AHEAD_MS = 14 * 24 * 60 * 60 * 1000
const JITTER = 0.2

export interface EnrollMemory {
  /** Consecutive transient failures. Drives the backoff schedule. */
  attempt: number
  nextAttemptAt: number
  /** SSO is refused until the next successful sign-in (sso-* codes). */
  ssoBlockedUntilSignIn: boolean
  /** The embedded token was revoked or expired on the Worker: off until the app updates. */
  tokenOff: boolean
  inFlight: boolean
}

export function emptyEnrollMemory(): EnrollMemory {
  return { attempt: 0, nextAttemptAt: 0, ssoBlockedUntilSignIn: false, tokenOff: false, inFlight: false }
}

/** Backoff for the Nth consecutive failure, with +/-20 percent jitter. `rand` is injectable for tests. */
export function enrollBackoffMs(attempt: number, rand: () => number = Math.random): number {
  const idx = Math.min(Math.max(attempt, 0), ENROLL_BACKOFF_SCHEDULE_MS.length - 1)
  const base = ENROLL_BACKOFF_SCHEDULE_MS[idx]
  return Math.round(base * (1 - JITTER + 2 * JITTER * Math.min(Math.max(rand(), 0), 1)))
}

export interface EnrollDecisionInput {
  now: number
  /** False under the admin kill switch. */
  policyAllowed: boolean
  /** A usable https Operator address resolves. */
  urlOk: boolean
  /** An admin credential (manual or MDM licence, legacy or env secret) is in use. The machine never touches it. */
  adminCredential: boolean
  state: EnrollState
  origin: EnrollOrigin
  reportingExpiresAt: number | null
  revokedCheckedAt: number
  /** Signed in with SSO (an ID token may be obtainable). */
  ssoAvailable: boolean
  /** An embedded enrolment token whose bound URL equals the resolved base URL exists. */
  tokenAvailable: boolean
  memory: EnrollMemory
}

export type EnrollDecision =
  | { action: 'none'; phase: EnrollPhase }
  | { action: 'attempt'; method: EnrollMethod; phase: EnrollPhase }

export function decideEnrollment(i: EnrollDecisionInput): EnrollDecision {
  if (!i.policyAllowed) return { action: 'none', phase: 'disabled' }
  if (!i.urlOk || i.adminCredential || i.origin === 'admin') return { action: 'none', phase: i.state }
  if (i.memory.inFlight || i.now < i.memory.nextAttemptAt) return { action: 'none', phase: i.state }
  const sso = i.ssoAvailable && !i.memory.ssoBlockedUntilSignIn
  const token = i.tokenAvailable && !i.memory.tokenOff
  const fresh = (): EnrollDecision =>
    sso
      ? { action: 'attempt', method: 'sso', phase: i.state }
      : token
        ? { action: 'attempt', method: 'token', phase: i.state }
        : { action: 'none', phase: i.state }
  if (i.state === 'revoked') {
    return i.now - i.revokedCheckedAt >= REVOKED_RECHECK_MS ? fresh() : { action: 'none', phase: 'revoked' }
  }
  if (i.state === 'unenrolled') return fresh()
  const exp = i.reportingExpiresAt
  if (exp === null || exp <= i.now) return fresh()
  if (i.origin === 'token' && sso) return { action: 'attempt', method: 'sso', phase: 'enrolled' }
  if (exp - i.now <= ENROLL_RENEW_AHEAD_MS) return { action: 'attempt', method: 'renew', phase: 'enrolled' }
  return { action: 'none', phase: 'enrolled' }
}

export interface EnrollHttpResult {
  status: number
  contentType: string | null
  location: string | null
  json: unknown
}

export type EnrollOutcome =
  | { kind: 'ok'; license: string; jti: string; last4: string; exp: number; origin?: string; tier?: string }
  | { kind: 'retry'; retryAfterMs?: number }
  | { kind: 'unreachable'; retryAfterMs: number }
  | { kind: 'sso-stop' }
  | { kind: 'token-off' }
  | { kind: 'revoked' }

const SSO_STOP_CODES = new Set([
  'sso-invalid',
  'sso-tenant',
  'sso-domain',
  'sso-stale',
  'sso-replay',
  'enroll-unconfigured'
])
const TOKEN_OFF_CODES = new Set(['token-invalid', 'token-revoked', 'token-expired'])
const UNREACHABLE: EnrollOutcome = { kind: 'unreachable', retryAfterMs: ENROLL_UNREACHABLE_RETRY_MS }

/** Turn one HTTP result (null = the request itself failed) into what the machine does next. */
export function classifyEnrollResponse(res: EnrollHttpResult | null): EnrollOutcome {
  if (!res) return { kind: 'retry' }
  if (res.status >= 300 && res.status < 400) return UNREACHABLE
  const isJson = (res.contentType ?? '').toLowerCase().includes('application/json')
  if (res.status === 404 || !isJson) return res.status >= 500 ? { kind: 'retry' } : UNREACHABLE
  const body = res.json && typeof res.json === 'object' ? (res.json as Record<string, unknown>) : {}
  const retryAfter =
    typeof body.retryAfterMs === 'number' && Number.isFinite(body.retryAfterMs) && body.retryAfterMs > 0
      ? body.retryAfterMs
      : undefined
  const retry: EnrollOutcome = { kind: 'retry', ...(retryAfter ? { retryAfterMs: retryAfter } : {}) }
  if (body.ok === true && res.status >= 200 && res.status < 300) {
    const license = typeof body.license === 'string' ? body.license : ''
    const jti = typeof body.jti === 'string' ? body.jti : ''
    const exp = typeof body.exp === 'number' ? body.exp : NaN
    if (!license.startsWith(`${OPERATOR_LICENSE_PREFIX}.`) || !jti || !Number.isFinite(exp)) return { kind: 'retry' }
    return {
      kind: 'ok',
      license,
      jti,
      last4: typeof body.last4 === 'string' ? body.last4 : '',
      exp,
      ...(typeof body.origin === 'string' ? { origin: body.origin } : {}),
      ...(typeof body.tier === 'string' ? { tier: body.tier } : {})
    }
  }
  const code = typeof body.code === 'string' ? body.code : ''
  if (code === 'seat-revoked') return { kind: 'revoked' }
  if (code === 'enroll-paused' || code === 'admin-licensed') return UNREACHABLE
  if (SSO_STOP_CODES.has(code)) return { kind: 'sso-stop' }
  if (TOKEN_OFF_CODES.has(code)) return { kind: 'token-off' }
  return retry
}

/** Next in-memory state after an attempt finished. Persisted effects are the glue's job. */
export function applyEnrollOutcome(
  memory: EnrollMemory,
  _method: EnrollMethod,
  outcome: EnrollOutcome,
  now: number,
  rand: () => number = Math.random
): EnrollMemory {
  const settled = { ...memory, inFlight: false }
  switch (outcome.kind) {
    case 'ok':
      return { ...settled, attempt: 0, nextAttemptAt: 0 }
    case 'retry':
      return {
        ...settled,
        attempt: memory.attempt + 1,
        nextAttemptAt: now + (outcome.retryAfterMs ?? enrollBackoffMs(memory.attempt, rand))
      }
    case 'unreachable':
      return { ...settled, nextAttemptAt: now + outcome.retryAfterMs }
    case 'sso-stop':
      return { ...settled, ssoBlockedUntilSignIn: true, nextAttemptAt: now }
    case 'token-off':
      return { ...settled, tokenOff: true, nextAttemptAt: now }
    case 'revoked':
      return { ...settled, nextAttemptAt: now + REVOKED_RECHECK_MS }
  }
}
