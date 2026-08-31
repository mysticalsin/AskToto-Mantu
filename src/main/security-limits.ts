/**
 * In-process caps for renderer-triggered work in the main process.
 *
 * Outbound HTTP (`consumeSecurityLimit`) is a fixed window: the handler returns a user-visible
 * retry instead of hitting the remote. Live listen (`takeHotPath`) is a token bucket that never
 * waits — overflow is dropped in the same tick so captions are never blocked behind a counter.
 *
 * Single-user desktop: one bucket per kind, not per OS user.
 */

export type SecurityLimitBucket = 'license-activate' | 'mcp-outbound' | 'graph-calendar'

export const SECURITY_LIMITS: Record<SecurityLimitBucket, { max: number; windowMs: number }> = {
  'license-activate': { max: 10, windowMs: 60_000 },
  'mcp-outbound': { max: 30, windowMs: 60_000 },
  'graph-calendar': { max: 30, windowMs: 60_000 }
}

/** Live-listen / save / capture. Never used by `denyIfLimited`. */
export type HotPathKind = 'asr-feed' | 'save-transcript' | 'capture-screen' | 'arm-audio'

export const HOT_PATH_LIMITS: Record<HotPathKind, { burst: number; refillPerSec: number }> = {
  'asr-feed': { burst: 40, refillPerSec: 20 },
  'save-transcript': { burst: 8, refillPerSec: 0.5 },
  'capture-screen': { burst: 6, refillPerSec: 0.25 },
  'arm-audio': { burst: 10, refillPerSec: 1 }
}

type BucketState = { start: number; count: number }
type HotState = { tokens: number; last: number }

const buckets = new Map<SecurityLimitBucket, BucketState>()
const hotBuckets = new Map<HotPathKind, HotState>()

export function consumeSecurityLimit(
  bucket: SecurityLimitBucket,
  now = Date.now()
): { ok: true } | { ok: false; retryAfterMs: number } {
  const spec = SECURITY_LIMITS[bucket]
  const existing = buckets.get(bucket)
  if (!existing || now - existing.start >= spec.windowMs) {
    buckets.set(bucket, { start: now, count: 1 })
    return { ok: true }
  }
  if (existing.count >= spec.max) {
    return { ok: false, retryAfterMs: Math.max(0, spec.windowMs - (now - existing.start)) }
  }
  existing.count += 1
  return { ok: true }
}

/**
 * Non-blocking token bucket for the live listen path.
 *
 * Returns false in the same tick when empty. Never sleeps, never queues, never calls the network.
 * A flooded renderer loses overflow chunks (drop-oldest-in-effect: the newest call is the one
 * refused); captions keep moving.
 */
export function takeHotPath(kind: HotPathKind, now = Date.now()): boolean {
  const spec = HOT_PATH_LIMITS[kind]
  const existing = hotBuckets.get(kind)
  if (!existing) {
    hotBuckets.set(kind, { tokens: spec.burst - 1, last: now })
    return true
  }
  const elapsedSec = Math.max(0, (now - existing.last) / 1000)
  existing.tokens = Math.min(spec.burst, existing.tokens + elapsedSec * spec.refillPerSec)
  existing.last = now
  if (existing.tokens < 1) return false
  existing.tokens -= 1
  return true
}

/** Test seam. Production never calls this. */
export function resetSecurityLimits(): void {
  buckets.clear()
  hotBuckets.clear()
  lastIpcDenyAt = 0
}

const IPC_DENY_SAMPLE_MS = 2_000
let lastIpcDenyAt = 0

/** True at most once per 2s so a flooded renderer cannot fill the audit file. */
export function shouldSampleIpcDeny(now = Date.now()): boolean {
  if (now - lastIpcDenyAt < IPC_DENY_SAMPLE_MS) return false
  lastIpcDenyAt = now
  return true
}

export const RATE_LIMIT_USER_MESSAGE = 'Too many attempts. Try again in a moment.'
