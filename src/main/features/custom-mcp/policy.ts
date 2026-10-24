import { CUSTOM_MCP_MAX_TOOLS } from '@shared/custom-mcp'
import { actionDigest } from '../../action-guard'

/** Resolved enterprise policy for custom MCP servers. Only the admin-managed file can grant. */
export interface CustomMcpPolicy {
  allow: boolean
  allowStdio: boolean
  stdioExecutables: ReadonlyArray<{ path: string; sha256: string }>
  allowPrivateNetwork: boolean
  /** null = no host restriction beyond the egress guard. */
  allowedHosts: readonly string[] | null
  maxTools: number
  /** The rule a blanket denial names (`allow:false` only). */
  deniedRule?: string
}

const DEFAULT_POLICY: CustomMcpPolicy = Object.freeze({
  allow: true,
  allowStdio: false,
  stdioExecutables: Object.freeze([]) as ReadonlyArray<{ path: string; sha256: string }>,
  allowPrivateNetwork: false,
  allowedHosts: null,
  maxTools: CUSTOM_MCP_MAX_TOOLS
})

const DENY_INVALID: CustomMcpPolicy = Object.freeze({
  ...DEFAULT_POLICY,
  allow: false,
  deniedRule: 'customMcp.invalid'
})

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Extract the `customMcp` block. `undefined` = absent, `null` = present but unusable. */
function block(raw: string | null): Record<string, unknown> | undefined | null {
  if (raw === null) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if (!('customMcp' in parsed)) return undefined
  return isRecord(parsed.customMcp) ? parsed.customMcp : null
}

const hostList = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((h) => typeof h === 'string')
    ? (value as string[]).map((h) => h.trim().toLowerCase()).filter(Boolean)
    : null

function parseAdmin(b: Record<string, unknown>): CustomMcpPolicy | null {
  const bool = (key: string, fallback: boolean): boolean | null =>
    b[key] === undefined ? fallback : typeof b[key] === 'boolean' ? b[key] : null
  const allow = bool('allow', true)
  const allowStdio = bool('allowStdio', false)
  const allowPrivateNetwork = bool('allowPrivateNetwork', false)
  if (allow === null || allowStdio === null || allowPrivateNetwork === null) return null

  const stdioExecutables: Array<{ path: string; sha256: string }> = []
  if (b.stdioExecutables !== undefined) {
    if (!Array.isArray(b.stdioExecutables)) return null
    for (const item of b.stdioExecutables) {
      if (!isRecord(item) || typeof item.path !== 'string' || typeof item.sha256 !== 'string') return null
      if (!/^[a-f0-9]{64}$/i.test(item.sha256)) return null
      stdioExecutables.push({ path: item.path, sha256: item.sha256.toLowerCase() })
    }
  }
  let allowedHosts: string[] | null = null
  if (b.allowedHosts !== undefined && b.allowedHosts !== null) {
    allowedHosts = hostList(b.allowedHosts)
    if (!allowedHosts) return null
  }
  let maxTools = CUSTOM_MCP_MAX_TOOLS
  if (b.maxTools !== undefined) {
    if (typeof b.maxTools !== 'number' || !Number.isInteger(b.maxTools) || b.maxTools < 0) return null
    maxTools = Math.min(b.maxTools, CUSTOM_MCP_MAX_TOOLS)
  }
  return {
    allow,
    allowStdio,
    stdioExecutables,
    allowPrivateNetwork,
    allowedHosts,
    maxTools,
    ...(allow ? {} : { deniedRule: 'customMcp.allow' })
  }
}

/**
 * Admin managed config (trusted) can grant; the per-user managed file can only restrict: `allow:false`, a
 * smaller `maxTools`, or an `allowedHosts` list that narrows (never widens) the admin's. A malformed block in
 * either source fails closed naming `customMcp.invalid`.
 */
export function readCustomMcpPolicy(adminRaw: string | null, userRaw: string | null): CustomMcpPolicy {
  const adminBlock = block(adminRaw)
  if (adminBlock === null) return DENY_INVALID
  let policy: CustomMcpPolicy = DEFAULT_POLICY
  if (adminBlock) {
    const parsed = parseAdmin(adminBlock)
    if (!parsed) return DENY_INVALID
    policy = parsed
  }

  const userBlock = block(userRaw)
  if (userBlock === null) return DENY_INVALID
  if (!userBlock) return policy
  if (userBlock.allow === false) return { ...policy, allow: false, deniedRule: 'customMcp.allow' }
  if (typeof userBlock.maxTools === 'number' && Number.isInteger(userBlock.maxTools) && userBlock.maxTools >= 0) {
    policy = { ...policy, maxTools: Math.min(policy.maxTools, userBlock.maxTools) }
  }
  const userHosts = hostList(userBlock.allowedHosts)
  if (userHosts) {
    const adminHosts = policy.allowedHosts
    policy = {
      ...policy,
      allowedHosts: adminHosts === null ? userHosts : userHosts.filter((h) => adminHosts.includes(h))
    }
  }
  return policy
}

/** Stable digest of everything that decides what a registration may do. */
export function policyDigest(policy: CustomMcpPolicy): string {
  return actionDigest({
    kind: 'custom-mcp-policy',
    allow: policy.allow,
    allowStdio: policy.allowStdio,
    stdioExecutables: [...policy.stdioExecutables].sort((a, b) => a.path.localeCompare(b.path)),
    allowPrivateNetwork: policy.allowPrivateNetwork,
    allowedHosts: policy.allowedHosts ? [...policy.allowedHosts].sort() : null,
    maxTools: policy.maxTools
  })
}
