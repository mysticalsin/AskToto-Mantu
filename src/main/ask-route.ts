/**
 * ask-route.ts — plugs the capability, cost and deadline router (shared/capability-router.ts, G29) into the ask seam.
 *
 * `planAsk` answers the two questions `askStart` used to answer with scattered `routeTier(...)` calls: which tier does
 * this request run at, and does the on-device model take the first attempt. It also says when the request must not run
 * at all (local-only that the on-device model cannot serve, a managed fleet with no approved model), with copy the user
 * can act on. The hedged race, the failover order, Private View and the existing eligibility predicates are untouched:
 * they keep reading the tier and the local-first decision this returns.
 *
 * Recap and summary are not routed here (they have their own policy path); they get the old answer unchanged.
 */
import { CLI_PROVIDER_IDS } from '@shared/ask-routing'
import { askCapabilityOf, routeCapability, type CostClass } from '@shared/capability-router'
import type { AskStart, Settings } from '@shared/ipc'
import type { ModelPolicyDocument } from '@shared/model-policy'
import type { ModelTier } from '@shared/providers'
import type { CounterMetricId } from '@shared/responsiveness-metrics'
import { routeTier } from '@shared/routing'
import { getResponsivenessRecorder } from './infra/observability/responsiveness-recorder'
import { localAnswerFloorEligibleFor, localFallbackEligibleFor, localPrimaryEligibleFor } from './llm/local-routing'

export interface AskMetrics {
  increment(id: CounterMetricId): void
}

/** The ask path's counter sink: the process-wide G12 recorder, resolved when used. Counts only. */
export const askMetrics: AskMetrics = { increment: (id) => getResponsivenessRecorder().increment(id) }

export interface AskPlanInput {
  req: AskStart
  settings: Settings
  /** The allowlist after the fleet policy narrowed it (what every eligibility check already reads). */
  allowed: string[] | null
  /** The admin-managed allowlist as the organisation wrote it (`null` is unrestricted). */
  orgAllowed: string[] | null
  /** The verified fleet policy, or null when the organisation has none. */
  policy: ModelPolicyDocument | null
  metrics?: AskMetrics
}

export interface AskPlan {
  tier: ModelTier
  /** The on-device model takes the first attempt (the old `localPrimaryEligibleFor` result at the final tier). */
  localPrimaryEligible: boolean
  /** Why the request must not run, in words for the user; null when it may. */
  unavailable: string | null
}

/** An organisation list that names the on-device model and nothing else is local-only. */
export function isLocalOnlyOrg(orgAllowed: readonly string[] | null): boolean {
  return orgAllowed !== null && orgAllowed.length > 0 && orgAllowed.every((p) => p === 'local')
}

export function planAsk(input: AskPlanInput): AskPlan {
  const { req, settings: s, allowed } = input
  const requestedTier = routeTier(req, s.thinkingMode)
  const capability = askCapabilityOf(req)
  if (!capability) {
    return {
      tier: requestedTier,
      localPrimaryEligible: localPrimaryEligibleFor(req, s, requestedTier, allowed),
      unavailable: null
    }
  }
  const costCeiling: CostClass | null = s.thinkingMode === 'never' ? 'low' : null
  const decision = routeCapability({
    capability,
    requestedTier,
    costCeiling,
    localOnly: isLocalOnlyOrg(input.orgAllowed),
    localFirstAt: (tier) => localPrimaryEligibleFor(req, s, tier, allowed),
    localLastResortAt: (tier) =>
      localFallbackEligibleFor(req, s, tier, allowed) || localAnswerFloorEligibleFor(req, s, allowed),
    policy: input.policy,
    orgAllowed: input.orgAllowed,
    cliReady: CLI_PROVIDER_IDS.some((id) => s.cliConnected[id] === true)
  })
  const count = (id: CounterMetricId): void => {
    try {
      ;(input.metrics ?? askMetrics).increment(id)
    } catch {
      // a metric must never affect an ask
    }
  }
  if (decision.kind === 'unavailable') {
    count('router_unavailable')
    return { tier: requestedTier, localPrimaryEligible: false, unavailable: decision.message }
  }
  count(decision.localFirst ? 'router_local_first' : 'router_cloud_first')
  return { tier: decision.tier, localPrimaryEligible: decision.localFirst, unavailable: null }
}
