/**
 * provider-health.ts — in-memory memory of which providers just refused to authenticate.
 *
 * Two defects share this root cause (docs/qa/BUG-LEDGER.md):
 *   MQA-003 — nothing remembered a failure, so a provider whose key was revoked was retried FIRST on
 *             every single ask. Measured: three consecutive suggest asks each re-walked a dead DeepSeek
 *             key, spending 6.5–9.3s before the on-device model answered, against a 15s live-suggest
 *             idle budget.
 *   MQA-004 — `providerReady` is derived from "a key string exists", never from whether that key works,
 *             so the UI kept reporting the provider as ready while every ask silently degraded.
 *
 * Design constraints that shaped this:
 * - **Auth failures only.** A 500 or a dropped socket is the provider having a bad minute; the existing
 *   retry/failover path already handles it. Only a credential rejection means "this will keep failing
 *   until a human changes something", which is the sole condition worth remembering.
 * - **Never persisted.** State lives for the process. A revoked key that gets restored, a network that
 *   was lying, an org that re-enabled billing — all resolve on restart without a stale file claiming a
 *   provider is broken. Cooldown is a latency optimization, not a durable verdict.
 * - **Never a hard block.** `isCoolingDown` is advisory: routing consults it to reorder, and callers
 *   must still be able to try a cooling provider when it is the only option. Turning a soft signal into
 *   a hard gate would let one bad minute lock a user out of their only configured provider.
 */
import type { ProviderId } from '@shared/providers'

/** Consecutive auth rejections before a provider is considered broken rather than unlucky. Two, not
 *  one: a single 401 can be a token mid-refresh (Dust) or a transient edge rejection. */
export const AUTH_FAILURES_BEFORE_UNHEALTHY = 2

/** How long a provider is skipped-when-possible after tripping. Long enough to spare a meeting's worth
 *  of asks from re-paying the round trip, short enough that a fixed key recovers without a restart. */
export const COOLDOWN_MS = 10 * 60 * 1000

interface Health {
  consecutiveAuthFailures: number
  /** When the provider tripped, so the cooldown can expire on its own. */
  unhealthySince: number | null
  /** The raw provider message from the most recent auth rejection — what Settings shows the user. */
  lastError: string
}

const health = new Map<ProviderId, Health>()

function entry(provider: ProviderId): Health {
  let h = health.get(provider)
  if (!h) {
    h = { consecutiveAuthFailures: 0, unhealthySince: null, lastError: '' }
    health.set(provider, h)
  }
  return h
}

/**
 * Does this failure mean "your credentials were rejected"?
 *
 * Deliberately narrower than a generic 4xx: only shapes that a human can fix by supplying a working
 * key/subscription. `isTransient` in retry.ts already answers the retry question — this answers the
 * different question of whether to REMEMBER the failure. 402/403 are included because an exhausted
 * balance or a disabled key present exactly as "your key no longer works" to the user.
 */
export function isAuthFailure(message: unknown): boolean {
  const text = String(message ?? '').toLowerCase()
  if (!text) return false
  // A 5xx that merely mentions "auth" is a server fault, not a credential problem.
  if (/\b5\d\d\b/.test(text)) return false
  return (
    /\b(401|403|402)\b/.test(text) ||
    /unauthor/.test(text) ||
    /authentication fails/.test(text) ||
    /invalid[_\s-]*api[_\s-]*key/.test(text) ||
    /(api )?key.*(invalid|expired|revoked|disabled)/.test(text) ||
    /insufficient[_\s-]*(quota|credit|balance|funds)/.test(text) ||
    /permission denied/.test(text)
  )
}

/** Record a credential rejection. Returns true once the provider has crossed into unhealthy. */
export function recordAuthFailure(provider: ProviderId, message: string, now = Date.now()): boolean {
  const h = entry(provider)
  h.consecutiveAuthFailures += 1
  h.lastError = message
  if (h.consecutiveAuthFailures >= AUTH_FAILURES_BEFORE_UNHEALTHY && h.unhealthySince == null) {
    h.unhealthySince = now
  }
  return h.unhealthySince != null
}

/** Any successful use clears the record — the credentials demonstrably work again. */
export function recordSuccess(provider: ProviderId): void {
  health.delete(provider)
}

/**
 * Forget everything known about a provider. Called whenever its key changes (set or cleared): the old
 * verdict was about the OLD credential and must never suppress the new one — otherwise pasting a
 * working key would appear not to fix anything until the cooldown expired.
 */
export function resetProviderHealth(provider: ProviderId): void {
  health.delete(provider)
}

/** Test seam / full reset. */
export function resetAllProviderHealth(): void {
  health.clear()
}

/**
 * Should routing avoid this provider right now, if it has any alternative? Advisory only — see the
 * module comment. Expired cooldowns self-heal on read so nothing has to run a timer.
 */
export function isCoolingDown(provider: ProviderId, now = Date.now()): boolean {
  const h = health.get(provider)
  if (!h || h.unhealthySince == null) return false
  if (now - h.unhealthySince >= COOLDOWN_MS) {
    health.delete(provider) // cooldown served; let it prove itself again
    return false
  }
  return true
}

export interface UnhealthyProvider {
  provider: ProviderId
  /** The provider's own most recent rejection text, for the "your key stopped working" surface. */
  error: string
  since: number
}

/** Providers currently considered broken — what the renderer needs to tell the user their key died. */
export function unhealthyProviders(now = Date.now()): UnhealthyProvider[] {
  const out: UnhealthyProvider[] = []
  for (const [provider, h] of health) {
    if (h.unhealthySince == null) continue
    if (now - h.unhealthySince >= COOLDOWN_MS) continue
    out.push({ provider, error: h.lastError, since: h.unhealthySince })
  }
  return out
}
