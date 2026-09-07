/**
 * Main-process Operator entitlement state (PLAN.md P2.2b #2).
 *
 * Holds the latest { tier, entitlements } snapshot in memory (updated after every heartbeat attempt)
 * plus a persisted copy in settings (operatorTier/operatorEntitlements/operatorIntegrationsVersion/
 * operatorEntitlementsAt) so a cold start before the first heartbeat can still honour the grace window
 * from the LAST run's successful heartbeat instead of starting from a hard lockout.
 *
 * All the actual grace-window / gate logic is pure (shared/operator-entitlements.ts) — this module is
 * just the impure glue: read/write settings, expose the in-memory snapshot, and offer one `operatorGate`
 * call that every gated action in main uses.
 */
import { operatorUrlConfigured } from '@shared/operator'
import {
  emptyOperatorEntitlements,
  operatorGate as pureOperatorGate,
  parseOperatorHeartbeatEntitlements,
  type OperatorEntitlementKey,
  type OperatorEntitlementSnapshot,
  type OperatorEntitlements,
  type OperatorGateResult
} from '@shared/operator-entitlements'
import { getSettings, setSettings } from './store'

let memorySnapshot: OperatorEntitlementSnapshot | null = null

/** Test-only seam, mirrors setOperatorFetchForTests in operator-ingest.ts. */
export function setOperatorEntitlementsSnapshotForTests(snapshot: OperatorEntitlementSnapshot | null): void {
  memorySnapshot = snapshot
}

function settingsToSnapshot(s: {
  operatorTier: OperatorEntitlementSnapshot['tier']
  operatorEntitlements: OperatorEntitlements | null
  operatorEntitlementsAt: number
}): OperatorEntitlementSnapshot | null {
  if (!s.operatorEntitlementsAt) return null
  return { tier: s.operatorTier, entitlements: s.operatorEntitlements ?? emptyOperatorEntitlements(), at: s.operatorEntitlementsAt }
}

/** In-memory first (this session's own heartbeats), falling back to the persisted copy for the window
 *  between app launch and the first heartbeat this run. */
function currentSnapshot(): OperatorEntitlementSnapshot | null {
  if (memorySnapshot) return memorySnapshot
  return settingsToSnapshot(getSettings())
}

/**
 * Record the outcome of a heartbeat attempt. A FAILED heartbeat (`ok: false`, or no response at all)
 * leaves the snapshot untouched — the grace window must keep counting from the last successful
 * heartbeat, never reset early just because this tick happened to fail. Best-effort persistence: a
 * settings-write failure never throws into the heartbeat's caller.
 */
export function recordOperatorHeartbeatResult(ok: boolean, json: unknown, now: number = Date.now()): void {
  if (!ok) return
  const parsed = parseOperatorHeartbeatEntitlements(json)
  memorySnapshot = { tier: parsed.tier, entitlements: parsed.entitlements, at: now }
  try {
    setSettings({
      operatorTier: parsed.tier,
      operatorEntitlements: parsed.entitlements,
      operatorIntegrationsVersion: parsed.integrationsVersion,
      operatorEntitlementsAt: now
    })
  } catch {
    /* best-effort — the in-memory snapshot above already governs gating for the rest of this run */
  }
}

function isOperatorConfigured(s: { operatorUrl?: string; operatorIngestSecret?: string }): boolean {
  return operatorUrlConfigured(s) && !!(s.operatorIngestSecret || '').trim()
}

/** The one gate every gated action in main consults. Reads live settings each call (cheap, in-memory
 *  store) so a mid-session Operator URL/secret change or license activation takes effect immediately. */
export function operatorGate(feature: OperatorEntitlementKey, now: number = Date.now()): OperatorGateResult {
  const s = getSettings()
  return pureOperatorGate(feature, isOperatorConfigured(s), currentSnapshot(), now)
}

/** Convenience boolean form for call sites that don't need the refusal reason (e.g. filtering a list). */
export function operatorEntitled(feature: OperatorEntitlementKey, now: number = Date.now()): boolean {
  return operatorGate(feature, now).allowed
}

export function operatorIntegrationsVersion(): number {
  return getSettings().operatorIntegrationsVersion || 0
}
