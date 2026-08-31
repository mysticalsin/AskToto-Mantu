/**
 * In-process caps for outbound, renderer-triggered network from the main process.
 *
 * Capture / save / ASR stay off this module on purpose: a meeting must never wait on a security
 * counter, and those handlers do not speak HTTP.
 *
 * Single-user desktop: one bucket per kind, not per OS user. A compromised renderer that loops
 * license:activate or mcp:push hits the cap here before the remote service does.
 */

export type SecurityLimitBucket = 'license-activate' | 'mcp-outbound' | 'graph-calendar'

export const SECURITY_LIMITS: Record<SecurityLimitBucket, { max: number; windowMs: number }> = {
  'license-activate': { max: 10, windowMs: 60_000 },
  'mcp-outbound': { max: 30, windowMs: 60_000 },
  'graph-calendar': { max: 30, windowMs: 60_000 }
}

type BucketState = { start: number; count: number }

const buckets = new Map<SecurityLimitBucket, BucketState>()

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

/** Test seam. Production never calls this. */
export function resetSecurityLimits(): void {
  buckets.clear()
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
