/**
 * Shared transient-failure gate for the LLM path. Every provider (Dust, OpenAI-compatible, Anthropic,
 * CLI) funnels its failure through the ask-path `onError`, so classification + backoff live here once
 * rather than being reimplemented per provider.
 *
 * "Transient" = a connection/transport failure or a server-side hiccup that a retry can plausibly clear
 * (dropped socket, DNS blip, connect timeout, 5xx, 429). It deliberately EXCLUDES:
 *   - auth failures (401 / expired token) — those self-heal via the Dust refresh path, not a blind retry
 *     (see isDustAuthError); retrying without refreshing just burns time.
 *   - user aborts — the request is gone; nothing to retry.
 *   - everything else (bad request, model-not-found, content errors) — retrying can't fix them.
 */

/** Flatten an unknown thrown value into a lowercased blob of the fields that carry failure identity:
 *  message, Node/undici `code`, the DustAPI `type`, HTTP `status`, and one level of `cause`. */
function errorBlob(err: unknown): { text: string; status: number | null } {
  if (err == null) return { text: '', status: null }
  if (typeof err === 'string') return { text: err.toLowerCase(), status: null }
  const e = err as {
    message?: unknown
    code?: unknown
    type?: unknown
    status?: unknown
    statusCode?: unknown
    cause?: { code?: unknown; message?: unknown }
  }
  const status =
    typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : null
  const parts = [e.message, e.code, e.type, e.cause?.code, e.cause?.message]
    .filter((p) => p != null)
    .map((p) => String(p))
  return { text: parts.join(' ').toLowerCase(), status }
}

// Node/undici connection-failure codes, the DustAPI wrapper string ("Unexpected network error from
// DustAPI: fetch failed"), AND the transient shapes that arrive as a MESSAGE STRING from the OpenAI /
// Anthropic SDKs (onError hands us `err.message`, not the error object, so a `.status` is unavailable —
// the status code is embedded in the text, e.g. "529 {…overloaded_error…}" / "429 Too Many Requests").
// Bare "timeout" is intentionally omitted so the stream idle-watchdog message ("Timed out — no response
// from the agent.") is NOT retried here — that failure mode is handled by pre-token failover.
// MQA-061: "connection error" is the single most common shape of all — both SDKs default
// APIConnectionError's message to the literal "Connection error." for an ordinary transport failure
// (no message passed at the throw site), and errMsg in shared.ts hands us only that message, dropping
// the undici `cause` that carries the real ENOTFOUND/ECONNREFUSED. Without this alternative an offline
// machine — the one failure the user can actually fix — classifies as PERMANENT: no same-provider
// retry, and the raw "Connection error." is shown instead of the friendly network rewrite.
const TRANSIENT_PATTERN =
  /\b(econnreset|etimedout|econnrefused|eai_again|enotfound|epipe|und_err_connect_timeout|und_err_socket|und_err_headers_timeout|und_err_body_timeout)\b|fetch failed|connect timeout|socket hang up|network error|connection error|temporarily unavailable|service unavailable|internal server error|bad gateway|gateway timeout|overloaded|rate.?limit|too many requests|\b(429|500|502|503|504|529)\b/

const AUTH_PATTERN =
  /\b401\b|oauth|unauthor|expired|invalid.*(token|credential)|authenticat\w*\s+credential|credential.*authenticat/

const ABORT_PATTERN = /\babort(ed)?\b|aborterror/

/**
 * Should this failure be retried against the SAME provider before failing over? True only for transient
 * transport/server errors; false for auth, aborts, and permanent request errors.
 */
export function isTransient(err: unknown): boolean {
  const { text, status } = errorBlob(err)
  if (!text && status == null) return false
  if (ABORT_PATTERN.test(text)) return false
  // Auth is not transient — it has its own refresh-and-replay path. A 401 must never be retried here.
  if (status === 401 || (status == null && AUTH_PATTERN.test(text) && !/\b5\d\d\b/.test(text)))
    return false
  if (status != null) {
    if (status === 429) return true
    if (status >= 500 && status <= 599) return true
    if (status >= 400 && status <= 499) return false // other 4xx are permanent (bad request, not found…)
  }
  return TRANSIENT_PATTERN.test(text)
}

export interface BackoffOptions {
  /** Delay for the first retry (attempt 0). Doubles each attempt. */
  baseMs?: number
  /** Hard cap on any single backoff before jitter. */
  maxMs?: number
  /** A server-provided Retry-After (429/503), in ms, used as a floor. */
  retryAfterMs?: number
  /** Injectable RNG for deterministic tests. Defaults to Math.random. */
  rand?: () => number
}

/**
 * Backoff for retry number `attempt` (0-indexed): exponential (`baseMs * 2^attempt`) capped at `maxMs`,
 * with equal jitter (half fixed + half random) to avoid thundering-herd alignment. A known Retry-After
 * is honored as a floor — we never retry sooner than the server asked.
 */
export function nextBackoff(attempt: number, opts: BackoffOptions = {}): number {
  const { baseMs = 500, maxMs = 8000, retryAfterMs, rand = Math.random } = opts
  const capped = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt))
  const jittered = capped / 2 + rand() * (capped / 2)
  const delay = retryAfterMs != null ? Math.max(retryAfterMs, jittered) : jittered
  return Math.round(delay)
}
