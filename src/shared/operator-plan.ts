/**
 * Operator plan state machine (G79, R091/R101/R102, CAP-33).
 *
 * Pure derivation of what Settings may tell the user about their plan. The key rule: a managed seat that
 * has not heard a successful heartbeat this run is `checking`, never Free and never "not included". Gate
 * semantics (operatorGate and the grace window) are untouched; this only decides what is shown.
 */
import {
  OPERATOR_ENTITLEMENT_GRACE_MS,
  type OperatorEntitlementSnapshot,
  type OperatorEntitlements,
  type OperatorTier
} from './operator-entitlements'
import { evaluateMeter, type MeterEvaluation, type OperatorMeter } from './operator-meters'
import { formatResetPhrase } from './reset-time'

export type OperatorPlanState = 'unmanaged' | 'checking' | 'licensed' | 'not_licensed' | 'stale'
export type OperatorPlanMeter = OperatorMeter & MeterEvaluation
/** The tiers a person can hold. `reporting` is an organisation telemetry seat, never a plan. */
export type OperatorPlanTier = Exclude<OperatorTier, 'reporting'>

export interface OperatorPlan {
  state: OperatorPlanState
  tier: OperatorPlanTier | null
  lastKnownTier: OperatorPlanTier | null
  entitlements: OperatorEntitlements | null
  managedAi: boolean
  meters: OperatorPlanMeter[]
}

export interface DeriveOperatorPlanInput {
  managed: boolean
  /** The snapshot from a successful heartbeat this run for the current connection, or null. */
  live: OperatorEntitlementSnapshot | null
  /** The persisted copy from an earlier run. Only ever shown as "last confirmed". */
  persisted: OperatorEntitlementSnapshot | null
  fundedProviders: string[]
  meters: OperatorMeter[]
  now: number
}

function planTier(tier: OperatorTier | null | undefined): OperatorPlanTier | null {
  return tier === 'metis' || tier === 'metis-light' ? tier : null
}

export function deriveOperatorPlan(input: DeriveOperatorPlanInput): OperatorPlan {
  const none = { tier: null, lastKnownTier: null, entitlements: null, managedAi: false, meters: [] }
  if (!input.managed) return { state: 'unmanaged', ...none }
  const { live } = input
  if (!live) return { state: 'checking', ...none, lastKnownTier: planTier(input.persisted?.tier) }
  const tier = planTier(live.tier)
  if (!tier) return { state: 'not_licensed', ...none }
  if (input.now - live.at > OPERATOR_ENTITLEMENT_GRACE_MS) return { state: 'stale', ...none, lastKnownTier: tier }
  return {
    state: 'licensed',
    tier,
    lastKnownTier: tier,
    entitlements: live.entitlements,
    managedAi: input.fundedProviders.length > 0,
    meters: input.meters.map((m) => ({ ...m, ...evaluateMeter(m, input.now) }))
  }
}

export interface OperatorPlanCopy {
  headline: string
  detail: string
  showEntitlements: boolean
  showProviderPrompt: boolean
  meterLines: string[]
}

function tierLabel(tier: OperatorPlanTier | null): string {
  return tier === 'metis-light' ? 'Métis Light' : 'Métis'
}

function meterLine(m: OperatorPlanMeter, now: number): string {
  const limit = m.limit.toLocaleString('en-US')
  if (m.state === 'unknown' || m.used === null) return `${m.label}: limit ${limit}`
  const reset = m.resetAt !== null ? `, ${formatResetPhrase(m.resetAt, now)}` : ''
  return `${m.label}: ${m.used.toLocaleString('en-US')} of ${limit} used${reset}`
}

/** User-facing copy. No em dashes. Numbers come only from the server. */
export function describeOperatorPlan(plan: OperatorPlan, now: number): OperatorPlanCopy {
  const flags = { showEntitlements: false, showProviderPrompt: false, meterLines: [] as string[] }
  switch (plan.state) {
    case 'checking':
      return {
        headline: 'Checking your plan…',
        detail: plan.lastKnownTier
          ? `Last confirmed as ${tierLabel(plan.lastKnownTier)}.`
          : 'Métis is contacting Operator.',
        ...flags
      }
    case 'stale':
      return {
        headline: 'Operator has not been reachable in over 24 hours.',
        detail: 'Ask keeps working. Other features return after the next successful check.',
        ...flags
      }
    case 'not_licensed':
      return {
        headline: 'No Métis plan on this device',
        detail: 'Operator did not confirm a plan for this seat.',
        ...flags
      }
    case 'unmanaged':
      return { headline: 'No managed plan', detail: '', ...flags }
    case 'licensed':
      return {
        headline: tierLabel(plan.tier),
        detail: plan.managedAi ? 'Managed AI is available without your own key.' : '',
        showEntitlements: true,
        showProviderPrompt: !plan.managedAi,
        meterLines: plan.meters.map((m) => meterLine(m, now))
      }
  }
}
