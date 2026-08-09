/**
 * provider-health.ts — in-memory memory of which providers just refused to serve, and why.
 *
 * Originally this remembered ONLY credential rejections (MQA-003/004). It now remembers the whole family
 * of "this provider will keep failing for a while" verdicts, because a dead key is not the only way a
 * provider stops answering — it can be rate-limited, out of credit, or a subscription window can be spent.
 * Each has a different natural cooldown, so the record carries a `reason` and an absolute `coolingUntil`:
 *
 *   reason        trigger (see exhaustion.ts / isAuthFailure)              default cooldown
 *   ─────────     ─────────────────────────────────────────────────────    ────────────────
 *   auth          401/403 dead key (2 strikes, per below)                   10 min
 *   rate-limit    429 / overloaded — key is fine, back off                  server Retry-After, else 60 s
 *   quota         credit/balance exhausted — money ran out                  1 h
 *   usage-cap     Claude Pro / Codex subscription window spent              until the stated reset (5 h / 24 h)
 *
 * Design constraints (unchanged):
 * - **Never persisted.** State lives for the process; a restored key / re-enabled billing / elapsed window
 *   all recover on restart without a stale file lying that a provider is broken. Cooldown is a latency
 *   optimisation, not a durable verdict.
 * - **Never a hard block.** `isCoolingDown` is advisory: routing consults it to DEMOTE a provider, and a
 *   caller must still be able to try a cooling provider as the last resort. One bad minute must never lock
 *   a user out of their only configured provider.
 */
import type { ProviderId } from '@shared/providers'
import type { ExhaustionKind } from './exhaustion'

/** Consecutive auth rejections before a provider is considered broken rather than unlucky. Two, not one:
 *  a single 401 can be a token mid-refresh (Dust) or a transient edge rejection. Rate-limit / quota /
 *  usage-cap trip IMMEDIATELY (one signal) — those are unambiguous "you ran out", not maybe-a-blip. */
export const AUTH_FAILURES_BEFORE_UNHEALTHY = 2

/** Auth cooldown: long enough to spare a meeting's worth of asks from re-paying a dead key's round trip,
 *  short enough that a fixed key recovers without a restart. */
export const COOLDOWN_MS = 10 * 60 * 1000
/** Default rate-limit cooldown when the server declares no Retry-After. */
export const RATE_LIMIT_COOLDOWN_MS = 60 * 1000
/** Default credit/quota cooldown — money does not refill on a short timer, but re-probe after an hour. */
export const QUOTA_COOLDOWN_MS = 60 * 60 * 1000
/** Hard bounds so a bogus Retry-After / reset epoch can never lock a provider out unreasonably. */
const MIN_COOLDOWN_MS = 15 * 1000
const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000
const MAX_COOLDOWN_MS = 8 * 24 * 60 * 60 * 1000

export type HealthReason = 'auth' | ExhaustionKind // 'auth' | 'rate-limit' | 'quota-exhausted' | 'usage-cap'

interface Health {
  /** Auth path only — the 2-strike gate. Other reasons cool on the first signal. */
  consecutiveAuthFailures: number
  /** Absolute epoch-ms the cooldown expires. Null = healthy. The single source of "is it cooling". */
  coolingUntil: number | null
  /** Why it is cooling — drives the user-facing message and the cooldown length. */
  reason: HealthReason | null
  /** When the current cooling state began. */
  since: number
  /** The provider's own most recent failure text — what Settings shows the user. */
  lastError: string
}

const health = new Map<ProviderId, Health>()

function entry(provider: ProviderId): Health {
  let h = health.get(provider)
  if (!h) {
    h = { consecutiveAuthFailures: 0, coolingUntil: null, reason: null, since: 0, lastError: '' }
    health.set(provider, h)
  }
  return h
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/**
 * Does this failure mean "your credentials were rejected"? Deliberately narrow: only shapes a human fixes
 * by supplying a working key/subscription. Credit/quota exhaustion is NOT here — exhaustion.ts owns that,
 * because "out of money" and "resets in 5h" need their own cooldowns and messages, not "re-enter your key".
 * index.ts checks exhaustion FIRST, so a "403 insufficient_quota" is classified as quota, never as auth.
 */
export function isAuthFailure(message: unknown): boolean {
  const text = String(message ?? '').toLowerCase()
  if (!text) return false
  // A 5xx that merely mentions "auth" is a server fault, not a credential problem.
  if (/\b5\d\d\b/.test(text)) return false
  return (
    /\b(401|403)\b/.test(text) ||
    /unauthor/.test(text) ||
    /authentication fails/.test(text) ||
    /invalid[_\s-]*api[_\s-]*key/.test(text) ||
    /(api )?key.*(invalid|expired|revoked|disabled)/.test(text) ||
    /permission denied/.test(text)
  )
}

/** Record a credential rejection. Returns true once the provider has crossed into cooling. */
export function recordAuthFailure(provider: ProviderId, message: string, now = Date.now()): boolean {
  const h = entry(provider)
  h.consecutiveAuthFailures += 1
  h.lastError = message
  if (h.consecutiveAuthFailures >= AUTH_FAILURES_BEFORE_UNHEALTHY && h.coolingUntil == null) {
    h.reason = 'auth'
    h.coolingUntil = now + COOLDOWN_MS
    h.since = now
  }
  return h.coolingUntil != null
}

/** Record a rate limit (429 / overloaded). Immediate, honoring the server's Retry-After when known. The key
 *  is fine — this is a short back-off, not a dead-key verdict. */
export function recordRateLimited(provider: ProviderId, retryAfterMs?: number | null, now = Date.now()): void {
  const ms = clamp(retryAfterMs ?? RATE_LIMIT_COOLDOWN_MS, MIN_COOLDOWN_MS, MAX_RATE_LIMIT_COOLDOWN_MS)
  setCooling(provider, 'rate-limit', now + ms, 'Rate limited — backing off.', now)
}

/** Record credit exhaustion or a spent subscription window. `resetAt` (absolute) wins; else `retryAfterMs`
 *  from now; else a per-kind default. Bounded so a malformed reset can't lock the provider out for a decade. */
export function recordExhausted(
  provider: ProviderId,
  kind: 'quota-exhausted' | 'usage-cap',
  opts: { retryAfterMs?: number | null; resetAt?: number | null; message?: string } = {},
  now = Date.now()
): void {
  const raw = opts.resetAt ?? now + (opts.retryAfterMs ?? QUOTA_COOLDOWN_MS)
  const until = clamp(raw, now + MIN_COOLDOWN_MS, now + MAX_COOLDOWN_MS)
  const label = opts.message || (kind === 'quota-exhausted' ? 'Out of credit.' : 'Usage limit reached.')
  setCooling(provider, kind, until, label, now)
}

function setCooling(provider: ProviderId, reason: HealthReason, until: number, message: string, now: number): void {
  const h = entry(provider)
  h.reason = reason
  h.coolingUntil = until
  h.since = now
  h.lastError = message
  // A rate-limit / quota / usage-cap is a different failure class than an auth strike — don't let a prior
  // auth strike count carry over and prematurely escalate a later credential blip.
  if (reason !== 'auth') h.consecutiveAuthFailures = 0
}

/** Any successful use clears the record — the provider demonstrably works again (half-open → closed). */
export function recordSuccess(provider: ProviderId): void {
  health.delete(provider)
}

/**
 * Forget everything about a provider. Called whenever its key changes (set or cleared): the old verdict was
 * about the OLD credential and must never suppress the new one — otherwise pasting a working key would look
 * like it fixed nothing until the cooldown expired.
 */
export function resetProviderHealth(provider: ProviderId): void {
  health.delete(provider)
}

/** Test seam / full reset. */
export function resetAllProviderHealth(): void {
  health.clear()
}

/**
 * Should routing avoid this provider right now, if it has any alternative? Advisory only — see the module
 * comment. Expired cooldowns self-heal on read so nothing has to run a timer.
 */
export function isCoolingDown(provider: ProviderId, now = Date.now()): boolean {
  const h = health.get(provider)
  if (!h || h.coolingUntil == null) return false
  if (now >= h.coolingUntil) {
    health.delete(provider) // cooldown served; let it prove itself again
    return false
  }
  return true
}

export interface UnhealthyProvider {
  provider: ProviderId
  /** The provider's own most recent failure text, for the "your key stopped working / you hit a limit" surface. */
  error: string
  since: number
  /** Why it is cooling, so the UI can distinguish "re-enter your key" from "you hit a limit, resets soon". */
  reason: HealthReason
  /** Absolute epoch-ms the cooldown expires — lets the UI show "retry in 2m" / "resets ~3:40pm". */
  until: number
}

/** Providers currently cooling — what the renderer needs to tell the user a key died or a limit was hit. */
export function unhealthyProviders(now = Date.now()): UnhealthyProvider[] {
  const out: UnhealthyProvider[] = []
  for (const [provider, h] of health) {
    if (h.coolingUntil == null || now >= h.coolingUntil) continue
    out.push({ provider, error: h.lastError, since: h.since, reason: h.reason ?? 'auth', until: h.coolingUntil })
  }
  return out
}
