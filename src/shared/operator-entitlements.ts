/**
 * Operator entitlement + integrations wire contract (PLAN.md P2.2b, section 3).
 *
 * Pure types and parsers only — no Electron, no network. Every parser fails CLOSED: a malformed,
 * truncated, or unexpected-shape payload from the Worker never becomes a guessed grant. Absent field =
 * false/null/[] per the wire contract, exactly like operator-seat.ts's sanitizers do for the request
 * side of the same contract.
 */

// ── Heartbeat response additions ──────────────────────────────────────────────────────────────────

export const OPERATOR_TIERS = ['metis', 'metis-light'] as const
export type OperatorTier = (typeof OPERATOR_TIERS)[number]

export function parseOperatorTier(raw: unknown): OperatorTier | null {
  return raw === 'metis' || raw === 'metis-light' ? raw : null
}

export const OPERATOR_ENTITLEMENT_KEYS = [
  'ask',
  'listen',
  'recap',
  'crm_push',
  'operator_keys',
  'intelligence',
  'integrations'
] as const
export type OperatorEntitlementKey = (typeof OPERATOR_ENTITLEMENT_KEYS)[number]
export type OperatorEntitlements = Record<OperatorEntitlementKey, boolean>

export function emptyOperatorEntitlements(): OperatorEntitlements {
  return {
    ask: false,
    listen: false,
    recap: false,
    crm_push: false,
    operator_keys: false,
    intelligence: false,
    integrations: false
  }
}

/** The grace-window fallback (see effectiveOperatorEntitlements below): Ask survives an Operator
 *  outage, nothing else does — never a full lockout, never a silent full grant. */
export function askOnlyOperatorEntitlements(): OperatorEntitlements {
  return { ...emptyOperatorEntitlements(), ask: true }
}

/** Fail closed: a non-object, or any key that isn't the literal boolean `true`, reads as false. An
 *  absent key is the documented "off" value on the wire, not an error — but neither is a truthy
 *  non-boolean (e.g. the string "true") ever trusted. */
export function parseOperatorEntitlements(raw: unknown): OperatorEntitlements {
  const out = emptyOperatorEntitlements()
  if (!raw || typeof raw !== 'object') return out
  const obj = raw as Record<string, unknown>
  for (const key of OPERATOR_ENTITLEMENT_KEYS) {
    if (obj[key] === true) out[key] = true
  }
  return out
}

/** Monotonic counter. Fail closed to 0 (== "no integrations delivered yet") on anything but a
 *  non-negative finite number. */
export function parseOperatorIntegrationsVersion(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0
}

export interface OperatorHeartbeatEntitlementFields {
  tier: OperatorTier | null
  entitlements: OperatorEntitlements
  integrationsVersion: number
}

/** Parse the three PLAN.md-section-3 additions off a heartbeat response body. `approved` and
 *  `fundedProviders` already have their own parsers elsewhere (operator-ingest.ts) — this is scoped to
 *  the NEW fields only. */
export function parseOperatorHeartbeatEntitlements(json: unknown): OperatorHeartbeatEntitlementFields {
  if (!json || typeof json !== 'object') {
    return { tier: null, entitlements: emptyOperatorEntitlements(), integrationsVersion: 0 }
  }
  const obj = json as Record<string, unknown>
  return {
    tier: parseOperatorTier(obj.tier),
    entitlements: parseOperatorEntitlements(obj.entitlements),
    integrationsVersion: parseOperatorIntegrationsVersion(obj.integrationsVersion)
  }
}

// ── Grace window + gate ────────────────────────────────────────────────────────────────────────────

/** Honour the last known entitlements for this long past the last successful heartbeat before failing
 *  closed to ask-only (PLAN.md P2.2b #2). */
export const OPERATOR_ENTITLEMENT_GRACE_MS = 24 * 60 * 60 * 1000

export interface OperatorEntitlementSnapshot {
  tier: OperatorTier | null
  entitlements: OperatorEntitlements
  /** Epoch ms of the last successful heartbeat that carried entitlements. <= 0 means "never". */
  at: number
}

/** The entitlements to actually enforce right now, given the last known snapshot and the grace window.
 *  Callers gate this behind `configured` themselves (see operatorGate) — an unconfigured seat is never
 *  routed through the grace clock at all. */
export function effectiveOperatorEntitlements(
  snapshot: OperatorEntitlementSnapshot | null,
  now: number = Date.now()
): OperatorEntitlements {
  if (!snapshot || snapshot.at <= 0) return askOnlyOperatorEntitlements()
  if (now - snapshot.at > OPERATOR_ENTITLEMENT_GRACE_MS) return askOnlyOperatorEntitlements()
  return snapshot.entitlements
}

const FEATURE_LABEL: Record<OperatorEntitlementKey, string> = {
  ask: 'Ask',
  listen: 'Listen',
  recap: 'Recap',
  crm_push: 'CRM push',
  operator_keys: 'Operator-funded providers',
  intelligence: 'Intelligence indexing',
  integrations: 'Integrations'
}

/** User-facing refusal copy for a gated feature. No em dashes. Distinguishes "never heard from
 *  Operator yet" from "Operator has gone quiet" from "your license just doesn't include this" so the
 *  toast tells the truth about which of the three actually happened. */
export function operatorGateReason(
  feature: OperatorEntitlementKey,
  snapshot: OperatorEntitlementSnapshot | null,
  now: number = Date.now()
): string {
  const label = FEATURE_LABEL[feature]
  if (!snapshot || snapshot.at <= 0) {
    return `Waiting for Operator to confirm this seat. ${label} is off until then.`
  }
  if (now - snapshot.at > OPERATOR_ENTITLEMENT_GRACE_MS) {
    return `Operator has not been reachable in over 24 hours. ${label} is off until the next heartbeat.`
  }
  const tierLabel = snapshot.tier === 'metis-light' ? 'Métis Light' : 'Métis'
  return `Your ${tierLabel} license does not include ${label}.`
}

export interface OperatorGateResult {
  allowed: boolean
  reason?: string
}

/** The single gate function every call site consults. `configured` is whether Settings has an Operator
 *  URL + secret at all (PLAN.md P2.2b #2: "only gate when the Operator is configured") — an
 *  unconfigured seat is today's app, always allowed, regardless of any stale snapshot left over from a
 *  previous configuration. */
export function operatorGate(
  feature: OperatorEntitlementKey,
  configured: boolean,
  snapshot: OperatorEntitlementSnapshot | null,
  now: number = Date.now()
): OperatorGateResult {
  if (!configured) return { allowed: true }
  const entitlements = effectiveOperatorEntitlements(snapshot, now)
  if (entitlements[feature]) return { allowed: true }
  return { allowed: false, reason: operatorGateReason(feature, snapshot, now) }
}

// ── GET /v1/integrations ───────────────────────────────────────────────────────────────────────────

export const OPERATOR_INTEGRATION_KINDS = [
  'hubspot',
  'salesforce',
  'pipedrive',
  'clickup',
  'plane',
  'notion',
  'custom-mcp'
] as const
export type OperatorIntegrationKind = (typeof OPERATOR_INTEGRATION_KINDS)[number]

const INTEGRATION_KIND_SET: ReadonlySet<string> = new Set(OPERATOR_INTEGRATION_KINDS)

export interface OperatorIntegration {
  id: string
  kind: OperatorIntegrationKind
  label: string
  baseUrl: string | null
  credential: string | null
  scopes: string[]
}

function parseOperatorIntegration(raw: unknown): OperatorIntegration | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id.trim()) return null
  if (typeof o.kind !== 'string' || !INTEGRATION_KIND_SET.has(o.kind)) return null
  if (typeof o.label !== 'string' || !o.label.trim()) return null
  const baseUrl = typeof o.baseUrl === 'string' && o.baseUrl.trim() ? o.baseUrl.trim() : null
  const credential = typeof o.credential === 'string' && o.credential ? o.credential : null
  const scopes = Array.isArray(o.scopes) ? o.scopes.filter((s): s is string => typeof s === 'string') : []
  return { id: o.id, kind: o.kind as OperatorIntegrationKind, label: o.label, baseUrl, credential, scopes }
}

export interface OperatorIntegrationsResponse {
  ok: true
  version: number
  integrations: OperatorIntegration[]
}

/** Fail closed: `{ ok: false, ... }` (the seat-not-entitled shape), any non-object, a missing/negative
 *  version, or a non-array `integrations` all parse to null. A malformed ENTRY inside an otherwise valid
 *  array is dropped rather than failing the whole response — one bad row must not blank out every
 *  legitimate integration the seat is entitled to. */
export function parseOperatorIntegrationsResponse(json: unknown): OperatorIntegrationsResponse | null {
  if (!json || typeof json !== 'object') return null
  const o = json as Record<string, unknown>
  if (o.ok !== true) return null
  if (typeof o.version !== 'number' || !Number.isFinite(o.version) || o.version < 0) return null
  if (!Array.isArray(o.integrations)) return null
  const integrations: OperatorIntegration[] = []
  for (const item of o.integrations) {
    const parsed = parseOperatorIntegration(item)
    if (parsed) integrations.push(parsed)
  }
  return { ok: true, version: Math.floor(o.version), integrations }
}
