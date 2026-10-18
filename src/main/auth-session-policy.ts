import type { AzureConfig } from './auth-config'

export interface AuthSession {
  email: string
  name?: string
  domain: string
  tid: string
  at: number
}

export const MAX_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000

export function tenantMatches(tid: string, configuredTenantId: string): boolean {
  return tid.trim().toLowerCase() === configuredTenantId.trim().toLowerCase()
}

/** Legacy session expiry preserves its original timestamp and tenant/domain rules. */
export function expiryReason(
  session: AuthSession,
  config: AzureConfig | null,
  maxAgeMs = MAX_SESSION_AGE_MS
): 'max_age' | 'domain' | 'tenant' | null {
  if (typeof session.at !== 'number' || Date.now() - session.at > maxAgeMs) return 'max_age'
  if (config && session.domain !== config.allowedDomain) return 'domain'
  if (config && (typeof session.tid !== 'string' || !tenantMatches(session.tid, config.tenantId))) return 'tenant'
  return null
}

/** Lease validation also rejects future/non-finite timestamps and uses its caller's captured clock. */
export function expiryReasonAt(
  session: AuthSession,
  config: AzureConfig | null,
  now: number,
  maxAgeMs = MAX_SESSION_AGE_MS
): 'max_age' | 'domain' | 'tenant' | null {
  if (!Number.isFinite(session.at) || now < session.at || now - session.at > maxAgeMs) return 'max_age'
  if (config && session.domain !== config.allowedDomain) return 'domain'
  if (config && (typeof session.tid !== 'string' || !tenantMatches(session.tid, config.tenantId))) return 'tenant'
  return null
}

/** Pure failure bucketing keeps raw MSAL errors out of audit records. */
export function coarseSignInFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/timed out/i.test(message)) return 'timeout'
  if (/No authorization code|error_description|access_denied/i.test(message)) return 'oauth_denied'
  if (/network|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(message)) return 'network'
  return 'other'
}

export interface SignInBackoffState {
  readonly failures: number
  readonly blockedUntil: number
}

export const INITIAL_SIGN_IN_BACKOFF: SignInBackoffState = { failures: 0, blockedUntil: 0 }

export function signInBackoffRemaining(state: SignInBackoffState, now: number): number {
  return Math.max(0, state.blockedUntil - now)
}

export function signInBackoffAfterFailure(state: SignInBackoffState, now: number): SignInBackoffState {
  const failures = state.failures + 1
  const delay = Math.min(60_000, 2_000 * 2 ** (failures - 1))
  return { failures, blockedUntil: now + delay }
}

export function resetSignInBackoff(): SignInBackoffState {
  return INITIAL_SIGN_IN_BACKOFF
}

/** Own consecutive sign-in failures without sharing mutable state between controllers. */
export function createSignInBackoffController() {
  let state = INITIAL_SIGN_IN_BACKOFF
  return {
    get failures(): number {
      return state.failures
    },
    remainingMs(now = Date.now()): number {
      return signInBackoffRemaining(state, now)
    },
    recordSignInFailure(now = Date.now()): void {
      state = signInBackoffAfterFailure(state, now)
    },
    recordSignInSuccess(): void {
      state = resetSignInBackoff()
    }
  }
}
