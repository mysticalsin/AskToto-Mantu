/**
 * Organisation reporting kill switch (O10). `operatorReporting: false` is honoured ONLY from the machine-wide
 * admin policy file (on Windows that file is ACL-trusted). The per-user managed-config.json lives in userData
 * and the user can write to it, so honouring the key there would be a user opt-out, which the product does
 * not offer. A user-scope value is ignored and audited once per process.
 *
 * Pure parsing lives here; the file readers are injected once at boot so no test or tool ever reads a real
 * policy file by accident. Until configured, reporting is allowed (today's default for every install).
 */
export type OperatorReportingPolicy = { allowed: true } | { allowed: false; reason: 'admin-policy' }

export interface OperatorReportingPolicyReaders {
  /** Raw content of the machine-wide admin managed-config, or null when absent or untrusted. */
  readAdmin: () => string | null
  /** Audit sink (main/logger auditLog). Injected so this module stays free of Electron imports. */
  audit?: (event: string, detail: Record<string, unknown>) => void
}

let readers: OperatorReportingPolicyReaders | null = null
let userScopeAudited = false
let listeners: Array<(allowed: boolean) => void> = []
let lastAllowed: boolean | null = null
let cached: { at: number; policy: OperatorReportingPolicy } | null = null
/** Gates ask this on hot paths; the underlying read stats a file, so answer from memory between re-reads. */
export const OPERATOR_REPORTING_POLICY_TTL_MS = 15_000

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Only the literal boolean `false` turns reporting off. A string "false" or 0 is not a policy decision. */
export function operatorReportingPolicyFromAdminContent(raw: string | null): OperatorReportingPolicy {
  return parseObject(raw)?.operatorReporting === false ? { allowed: false, reason: 'admin-policy' } : { allowed: true }
}

export function configureOperatorReportingPolicy(next: OperatorReportingPolicyReaders | null): void {
  readers = next
  userScopeAudited = false
  lastAllowed = null
  cached = null
}

/** Feed the raw per-user managed-config here once at boot. A user-scope `operatorReporting` key is ignored and
 *  audited, never honoured: the user can write that file, so honouring it would be an opt-out. */
export function noteUserScopeReportingPolicy(raw: string | null): boolean {
  if (userScopeAudited || parseObject(raw)?.operatorReporting === undefined) return false
  userScopeAudited = true
  readers?.audit?.('operator.reporting.policy_ignored_user_scope', {})
  return true
}

export function getOperatorReportingPolicy(now: number = Date.now()): OperatorReportingPolicy {
  if (!readers) return { allowed: true }
  if (cached && now - cached.at < OPERATOR_REPORTING_POLICY_TTL_MS && now >= cached.at) return cached.policy
  let admin: string | null = null
  try {
    admin = readers.readAdmin()
  } catch {
    admin = null
  }
  const policy = operatorReportingPolicyFromAdminContent(admin)
  cached = { at: now, policy }
  if (lastAllowed !== policy.allowed) {
    const changed = lastAllowed !== null
    lastAllowed = policy.allowed
    if (changed) for (const fn of listeners) fn(policy.allowed)
  }
  return policy
}

export function operatorReportingAllowed(): boolean {
  return getOperatorReportingPolicy().allowed
}

/** Called when a re-read observes a different answer, so the runtime can stop or start without a relaunch. */
export function onOperatorReportingPolicyChange(fn: (allowed: boolean) => void): () => void {
  listeners.push(fn)
  return () => {
    listeners = listeners.filter((l) => l !== fn)
  }
}
