/**
 * usage-headroom.ts — pre-emptive "how much is left" memory, read from the rate-limit headers providers
 * return on EVERY response (success included). It lets routing skip a provider that is about to 429 BEFORE
 * the failing request, instead of only reacting after (provider-health.ts). This is OmniRoute's
 * budget-aware pre-emption, trimmed to what a desktop app needs.
 *
 * Two hard rules, both about being safe to be wrong:
 *  - **Fail-open.** No header data → the provider is fully eligible. A provider that never reports headroom
 *    (a local model, a custom proxy, an SDK that hides headers) must never be demoted for silence.
 *  - **Never a hard block, never the breaker.** Like isCoolingDown this only DEMOTES: a budget-blocked
 *    provider is skipped when there is an alternative, but is still reachable as the last resort. It does
 *    not record a failure — nothing failed yet.
 *
 * In-memory, ~30s TTL (the headers themselves rate-limit; a stale snapshot must expire fast), per process,
 * never persisted — same lifecycle contract as provider-health.ts.
 */
import type { ProviderId } from '@shared/providers'

/** Below this fraction of remaining token budget, pre-empt the provider (2% remaining = effectively spent). */
export const HEADROOM_EXHAUSTED_FRACTION = 0.02
/** A snapshot older than this is discarded — the true remaining could have refilled or drained since. */
export const HEADROOM_TTL_MS = 30 * 1000

interface Headroom {
  /** Remaining ÷ limit, clamped 0..1. The min across the token- and request-rate families. */
  fraction: number
  /** Absolute epoch-ms the window resets, if the provider stated one (past it, the snapshot is void). */
  resetAt: number | null
  /** When this snapshot was taken. */
  at: number
}

const map = new Map<ProviderId, Headroom>()

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

/** Record a headroom snapshot directly (numbers already parsed). No-op unless a usable fraction is derivable. */
export function noteHeadroom(
  provider: ProviderId,
  snapshot: { remaining?: number | null; limit?: number | null; resetAt?: number | null },
  now = Date.now()
): void {
  const { remaining, limit, resetAt = null } = snapshot
  if (remaining == null || limit == null || !(limit > 0)) return
  map.set(provider, { fraction: clamp01(remaining / limit), resetAt, at: now })
}

/** A minimal Headers-like — the OpenAI/undici `Headers` and a plain record both satisfy this. */
export interface HeaderBag {
  get(name: string): string | null | undefined
}

function num(h: HeaderBag, name: string): number | null {
  const raw = h.get(name)
  if (raw == null || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function resetEpoch(h: HeaderBag, names: string[], now: number): number | null {
  for (const name of names) {
    const raw = h.get(name)
    if (raw == null || raw === '') continue
    // Two shapes: an ISO date (Anthropic) or a compact "1m30s" / seconds (OpenAI).
    const iso = Date.parse(raw)
    if (!Number.isNaN(iso) && iso > now) return iso
    const compact = String(raw).match(/(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/)
    if (compact && (compact[1] || compact[2])) {
      const ms = Number(compact[1] || 0) * 60_000 + Number(compact[2] || 0) * 1000
      if (ms > 0) return now + ms
    }
    const secs = Number(raw)
    if (Number.isFinite(secs) && secs > 0 && secs < 7 * 24 * 3600) return now + secs * 1000
  }
  return null
}

/**
 * Snapshot headroom from a response's rate-limit headers. Reads BOTH the OpenAI-style family
 * (`x-ratelimit-*-tokens` / `-requests`) and the Anthropic family (`anthropic-ratelimit-*`), and keeps the
 * MINIMUM fraction across whichever are present — whichever budget is closest to empty is the one that will
 * 429 first. Silent when nothing usable is found (fail-open). Wrapped so a header quirk can never throw
 * into the streaming path.
 */
export function noteHeadroomFromHeaders(provider: ProviderId, headers: HeaderBag | null | undefined, now = Date.now()): void {
  if (!headers || typeof headers.get !== 'function') return
  try {
    const fractions: number[] = []
    // Token budget (the one that usually bites first).
    const remTok = num(headers, 'x-ratelimit-remaining-tokens') ?? num(headers, 'anthropic-ratelimit-tokens-remaining')
    const limTok = num(headers, 'x-ratelimit-limit-tokens') ?? num(headers, 'anthropic-ratelimit-tokens-limit')
    if (remTok != null && limTok != null && limTok > 0) fractions.push(clamp01(remTok / limTok))
    // Request budget.
    const remReq = num(headers, 'x-ratelimit-remaining-requests') ?? num(headers, 'anthropic-ratelimit-requests-remaining')
    const limReq = num(headers, 'x-ratelimit-limit-requests') ?? num(headers, 'anthropic-ratelimit-requests-limit')
    if (remReq != null && limReq != null && limReq > 0) fractions.push(clamp01(remReq / limReq))
    if (!fractions.length) return
    const resetAt = resetEpoch(
      headers,
      ['x-ratelimit-reset-tokens', 'anthropic-ratelimit-tokens-reset', 'x-ratelimit-reset-requests', 'anthropic-ratelimit-requests-reset'],
      now
    )
    map.set(provider, { fraction: Math.min(...fractions), resetAt, at: now })
  } catch {
    /* header parsing must never break a stream */
  }
}

/**
 * Is this provider about to hit its limit, so routing should skip it if it can? Fail-open: unknown → false.
 * Self-heals: a stale snapshot (past its TTL) or one whose window has already reset is discarded on read.
 */
export function isBudgetExhausted(provider: ProviderId, now = Date.now()): boolean {
  const h = map.get(provider)
  if (!h) return false
  if (now - h.at > HEADROOM_TTL_MS || (h.resetAt != null && now >= h.resetAt)) {
    map.delete(provider)
    return false
  }
  return h.fraction <= HEADROOM_EXHAUSTED_FRACTION
}

/** The remaining fraction (0..1) for a provider, or null if unknown/stale — for the Settings headroom readout. */
export function headroomFraction(provider: ProviderId, now = Date.now()): number | null {
  const h = map.get(provider)
  if (!h || now - h.at > HEADROOM_TTL_MS) return null
  return h.fraction
}

/** Forget a provider's headroom (key change) or all of it (test seam). */
export function resetHeadroom(provider: ProviderId): void {
  map.delete(provider)
}
export function resetAllHeadroom(): void {
  map.clear()
}
