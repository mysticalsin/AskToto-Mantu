/**
 * exhaustion.ts — classify "you ran out" failures so routing can react to each one correctly.
 *
 * Why this is a distinct module from provider-health.ts's `isAuthFailure` and retry.ts's `isTransient`:
 * a rate limit, a spent credit balance, and a subscription usage-cap are THREE different failures that
 * demand three different actions, and none of them is a dead key:
 *
 *   - rate-limit      → the key is fine; back off for the server's window (seconds–minutes) and retry / fail over.
 *   - quota-exhausted → the money ran out; the key will keep failing until billing changes. Demote for ~1h,
 *                       fail over now, never retry in place (a credit balance does not refill on a short timer).
 *   - usage-cap       → a Claude Pro / Codex subscription window is spent; it refills at a KNOWN time
 *                       (session ~5h, weekly ~24h). Demote until the reset, fail over now, do NOT sign the CLI
 *                       out (it is not a dead login).
 *
 * Design (mirrors OmniRoute's classify429, MIT): HTTP status is not enough — the body wording carries the
 * real signal. So we branch on keyword banks + the server's declared retry window, and a short declared
 * delay downgrades a "quota" keyword back to a rate-limit. Pure and side-effect free: it returns a signal;
 * provider-health.ts turns the signal into a cooldown and index.ts's onError turns it into a user message.
 *
 * Boundary with isAuthFailure: this owns credit/quota/usage exhaustion; isAuthFailure owns 401/403 dead
 * keys. index.ts checks exhaustion FIRST, so "403 insufficient_quota" is quota (money), while a bare
 * "403 permission denied" falls through to the auth path. classifyExhaustion returns null for anything
 * that is not an exhaustion signal, leaving the existing auth/transient handling untouched.
 */

export type ExhaustionKind = 'rate-limit' | 'quota-exhausted' | 'usage-cap'

export interface ExhaustionSignal {
  kind: ExhaustionKind
  /** Server-declared "try again in N ms" if one was present (Retry-After / RetryInfo / "resets in …").
   *  Null when unknown — the caller supplies a per-kind default. */
  retryAfterMs: number | null
  /** Absolute epoch-ms the provider said it recovers at (claude-cli "…|<epoch>", a daily reset). Null if
   *  only a relative delay or nothing was given. */
  resetAt: number | null
  /** Short human phrase for the user-facing message ("rate-limited", "out of credit", "usage limit"). */
  reason: string
}

// ── Keyword banks ───────────────────────────────────────────────────────────────────────────────────

// Money ran out. Terminal: it will not clear on a short timer, so it stays quota-exhausted even if a
// Retry-After rides along (OmniRoute's TERMINAL_QUOTA rule). Covers OpenAI (insufficient_quota / exceeded
// your current quota), Anthropic (your credit balance is too low), DeepSeek/others (insufficient balance),
// and generic billing prose.
const CREDIT_EXHAUSTED =
  /insufficient[_\s-]*(quota|credit|credits|balance|funds)|credit balance is too low|your credit balance|out of (credit|credits)|exceeded your current quota|quota exceeded|you (have )?exceeded your.*quota|payment required|\b402\b|add (funds|a payment method|credits|billing)|billing (hard )?limit|account balance/

// A subscription / plan window is spent — refills at a known time. Distinct from money: we can name the
// reset and must NOT retire the CLI. Scoped wording avoids matching "session expired" (an auth error).
const USAGE_CAP =
  /usage limit reached|reached your usage limit|you'?ve reached your usage limit|claude (pro|max)?\s*usage limit|plan usage limit|monthly usage limit|this request would exceed your account'?s rate limit/
const SESSION_CAP = /session usage limit|session limit reached|5[-\s]?hour (usage )?limit/
const WEEKLY_CAP = /weekly usage limit|weekly limit reached|weekly limit/
const DAILY_CAP = /daily (usage )?limit|daily quota/

// A plain rate limit — the key is fine, back off. Anthropic 529 overloaded is a server-side capacity limit
// that behaves like a rate limit for our purposes (back off, retry/fail over).
const RATE_LIMIT =
  /\b429\b|too many requests|rate[_\s-]?limit(ed|_exceeded)?|requests per (minute|second|day)|\brpm\b limit|\btpm\b limit|\b529\b|overloaded/

const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000
const WEEKLY_WINDOW_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

// ── Retry-window parsing ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract a server-declared retry delay in ms from raw failure text. Handles the three formats providers
 * actually emit: integer seconds ("retry-after: 30"), a compact relative unit ("retry in 5m", "5m", "2h",
 * "38.9s"), and an HTTP-date. The relative-unit pattern is checked BEFORE integer parse to avoid the
 * classic parseInt("5m") → 5(ms) bug. Returns null when no window is stated.
 */
export function parseRetryAfterMs(text: string): number | null {
  const t = text.toLowerCase()

  // "retry(-| )after ... 30" or "try again in 30 seconds" → integer seconds, but only when followed by a
  // seconds unit or bare number in a retry context (avoid grabbing an unrelated integer).
  const relUnit = t.match(/(?:retry|again|reset\w*|available|wait)[^0-9]{0,20}(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b/)
  if (relUnit) {
    const n = parseFloat(relUnit[1])
    const unit = relUnit[2]
    if (!Number.isNaN(n)) return Math.round(n * unitMs(unit))
  }

  // A compact "5m" / "2h" / "45s" token anywhere (Groq-style Retry-After bodies).
  const compact = t.match(/\b(\d+(?:\.\d+)?)\s*(ms|s|m|h)\b/)
  if (compact) {
    const n = parseFloat(compact[1])
    if (!Number.isNaN(n)) return Math.round(n * unitMs(compact[2]))
  }

  // "retry-after: 30" bare integer seconds.
  const header = t.match(/retry[-\s]?after[:\s]+(\d+(?:\.\d+)?)/)
  if (header) {
    const n = parseFloat(header[1])
    if (!Number.isNaN(n)) return Math.round(n * 1000)
  }

  // HTTP-date form: "retry-after: Wed, 21 Oct 2026 07:28:00 GMT".
  const dateMatch = text.match(/retry[-\s]?after[:\s]+([A-Za-z]{3},[^\n"]+GMT)/i)
  if (dateMatch) {
    const when = Date.parse(dateMatch[1])
    if (!Number.isNaN(when)) {
      const delta = when - Date.now()
      if (delta > 0) return delta
    }
  }
  return null
}

function unitMs(unit: string): number {
  if (unit.startsWith('ms')) return 1
  if (unit === 's' || unit.startsWith('sec')) return 1000
  if (unit === 'm' || unit.startsWith('min')) return 60_000
  if (unit === 'h' || unit.startsWith('hr') || unit.startsWith('hour')) return HOUR_MS
  return 1000
}

/**
 * Absolute reset epoch (ms) a CLI stated, if any. claude-cli emits "Claude AI usage limit reached|<epoch>"
 * where <epoch> is seconds. Also handles Anthropic/Antigravity prose "resets in 164h27m24s". Returns null
 * unless the parsed instant is a sane future time (now .. now+30d), so a malformed tail never locks a
 * provider out for a decade.
 */
export function parseCliUsageReset(message: string, now = Date.now()): number | null {
  const pipe = message.match(/\|\s*(\d{9,13})\s*$/)
  if (pipe) {
    const raw = Number(pipe[1])
    const epochMs = raw < 1e12 ? raw * 1000 : raw // seconds vs ms
    if (epochMs > now && epochMs < now + 30 * 24 * HOUR_MS) return epochMs
  }
  const resetsIn = message.toLowerCase().match(/resets? in\s+(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/)
  if (resetsIn && (resetsIn[1] || resetsIn[2] || resetsIn[3])) {
    const ms =
      (Number(resetsIn[1] || 0) * HOUR_MS) + (Number(resetsIn[2] || 0) * 60_000) + (Number(resetsIn[3] || 0) * 1000)
    if (ms > 0 && ms < 30 * 24 * HOUR_MS) return now + ms
  }
  return null
}

// ── The classifier ───────────────────────────────────────────────────────────────────────────────────

/**
 * Classify a pre-token failure as an exhaustion signal, or null if it is not one. `status` is the HTTP
 * status when the caller has it (the ask path usually only has the message string, so status is optional).
 *
 * Precedence — money before window before rate-limit:
 *   1. Credit/billing keywords → quota-exhausted (terminal; a Retry-After does not soften it).
 *   2. Subscription usage-cap keywords → usage-cap, window inferred from wording (session 5h / weekly 24h /
 *      daily→next reset / else 1h), honoring a stated reset epoch/delay.
 *   3. Rate-limit keywords (or a bare 429/529) → rate-limit with any declared Retry-After.
 * A rate-limit whose declared delay is ≥ 1h with no money/subscription wording is still a rate-limit, just
 * with a long honored window.
 */
export function classifyExhaustion(message: unknown, status?: number | null, now = Date.now()): ExhaustionSignal | null {
  const text = String(message ?? '')
  if (!text.trim()) return null
  const t = text.toLowerCase()

  // 1) Money.
  if (CREDIT_EXHAUSTED.test(t)) {
    return { kind: 'quota-exhausted', retryAfterMs: null, resetAt: null, reason: 'out of credit' }
  }

  // 2) Subscription / plan window.
  const isCap = USAGE_CAP.test(t) || SESSION_CAP.test(t) || WEEKLY_CAP.test(t) || DAILY_CAP.test(t)
  if (isCap) {
    const resetAt = parseCliUsageReset(text, now)
    let windowMs: number
    let reason: string
    if (SESSION_CAP.test(t)) {
      windowMs = SESSION_WINDOW_MS
      reason = 'session usage limit'
    } else if (WEEKLY_CAP.test(t)) {
      windowMs = WEEKLY_WINDOW_MS
      reason = 'weekly usage limit'
    } else if (DAILY_CAP.test(t)) {
      windowMs = nextMidnightMs(now) - now
      reason = 'daily limit'
    } else {
      windowMs = HOUR_MS
      reason = 'usage limit'
    }
    const retryAfterMs = resetAt != null ? resetAt - now : windowMs
    return { kind: 'usage-cap', retryAfterMs, resetAt, reason }
  }

  // 3) Rate limit (keyword, or a bare 429/529 status even with a terse body).
  if (RATE_LIMIT.test(t) || status === 429 || status === 529) {
    return { kind: 'rate-limit', retryAfterMs: parseRetryAfterMs(text), resetAt: null, reason: 'rate-limited' }
  }

  return null
}

/** Next local-midnight epoch-ms — a daily quota's reset instant. */
function nextMidnightMs(now: number): number {
  const d = new Date(now)
  d.setHours(24, 0, 0, 0)
  return d.getTime()
}
