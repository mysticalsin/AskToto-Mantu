import { describe, expect, it } from 'vitest'
import {
  OPERATOR_ENTITLEMENT_GRACE_MS,
  emptyOperatorEntitlements,
  type OperatorEntitlementSnapshot
} from './operator-entitlements'
import type { OperatorMeter } from './operator-meters'
import { deriveOperatorPlan, describeOperatorPlan } from './operator-plan'

const NOW = 1_800_000_000_000
const live = (over: Partial<OperatorEntitlementSnapshot> = {}): OperatorEntitlementSnapshot => ({
  tier: 'metis',
  entitlements: { ...emptyOperatorEntitlements(), ask: true, operator_keys: true },
  at: NOW - 1_000,
  ...over
})
const meter: OperatorMeter = {
  id: 'managed_tokens',
  label: 'Managed AI tokens',
  unit: 'tokens',
  limit: 50_000,
  used: 12_000,
  resetAt: NOW + 3_600_000,
  window: 'day'
}
const base = {
  managed: true,
  live: live(),
  persisted: null,
  fundedProviders: ['cloudflare'],
  meters: [meter],
  now: NOW
}

describe('deriveOperatorPlan', () => {
  it('unmanaged seat', () => {
    const plan = deriveOperatorPlan({ ...base, managed: false })
    expect(plan.state).toBe('unmanaged')
    expect(plan.tier).toBeNull()
    expect(plan.meters).toEqual([])
  })
  it('managed seat with no live heartbeat is checking and carries lastKnownTier from the persisted snapshot', () => {
    const plan = deriveOperatorPlan({ ...base, live: null, persisted: live({ tier: 'metis-light' }) })
    expect(plan.state).toBe('checking')
    expect(plan.lastKnownTier).toBe('metis-light')
  })
  it('a persisted reporting tier is never a last known plan', () => {
    const plan = deriveOperatorPlan({ ...base, live: null, persisted: live({ tier: 'reporting' }) })
    expect(plan.lastKnownTier).toBeNull()
  })
  it('checking exposes no tier, entitlements or meters', () => {
    const plan = deriveOperatorPlan({ ...base, live: null, persisted: live() })
    expect(plan).toMatchObject({ tier: null, entitlements: null, meters: [], managedAi: false })
  })
  it('licensed after a live heartbeat', () => {
    const plan = deriveOperatorPlan(base)
    expect(plan.state).toBe('licensed')
    expect(plan.tier).toBe('metis')
    expect(plan.managedAi).toBe(true)
    expect(plan.meters[0]).toMatchObject({ id: 'managed_tokens', state: 'available', remaining: 38_000 })
  })
  it('null tier after a server answer is not_licensed', () => {
    const plan = deriveOperatorPlan({ ...base, live: live({ tier: null, entitlements: emptyOperatorEntitlements() }) })
    expect(plan.state).toBe('not_licensed')
    expect(plan.meters).toEqual([])
  })
  it('past grace is stale', () => {
    const plan = deriveOperatorPlan({ ...base, live: live({ at: NOW - OPERATOR_ENTITLEMENT_GRACE_MS - 1 }) })
    expect(plan.state).toBe('stale')
    expect(plan.lastKnownTier).toBe('metis')
    expect(plan.meters).toEqual([])
  })
})

describe('describeOperatorPlan', () => {
  it("checking headline is 'Checking your plan…' with showEntitlements and showProviderPrompt false", () => {
    const copy = describeOperatorPlan(
      deriveOperatorPlan({ ...base, live: null, persisted: live({ tier: 'metis-light' }) }),
      NOW
    )
    expect(copy.headline).toBe('Checking your plan…')
    expect(copy.detail).toBe('Last confirmed as Métis Light.')
    expect(copy.showEntitlements).toBe(false)
    expect(copy.showProviderPrompt).toBe(false)
  })
  it('checking without a last known tier says Métis is contacting Operator', () => {
    const copy = describeOperatorPlan(deriveOperatorPlan({ ...base, live: null }), NOW)
    expect(copy.detail).toBe('Métis is contacting Operator.')
  })
  it('stale hides the grid and the prompt', () => {
    const copy = describeOperatorPlan(
      deriveOperatorPlan({ ...base, live: live({ at: NOW - OPERATOR_ENTITLEMENT_GRACE_MS - 1 }) }),
      NOW
    )
    expect(copy.headline).toBe('Operator has not been reachable in over 24 hours.')
    expect(copy.showEntitlements).toBe(false)
    expect(copy.showProviderPrompt).toBe(false)
  })
  it('licensed without funded providers shows the provider prompt', () => {
    const copy = describeOperatorPlan(deriveOperatorPlan({ ...base, fundedProviders: [] }), NOW)
    expect(copy.showEntitlements).toBe(true)
    expect(copy.showProviderPrompt).toBe(true)
  })
  it('licensed with a managed provider hides the provider prompt', () => {
    expect(describeOperatorPlan(deriveOperatorPlan(base), NOW).showProviderPrompt).toBe(false)
  })
  it('meter line prints only server numbers and the reset phrase', () => {
    const copy = describeOperatorPlan(deriveOperatorPlan(base), NOW)
    expect(copy.meterLines).toHaveLength(1)
    expect(copy.meterLines[0]).toMatch(/^Managed AI tokens: 12,000 of 50,000 used, resets ~/)
  })
  it('an unknown meter prints only its limit', () => {
    const plan = deriveOperatorPlan({ ...base, meters: [{ ...meter, used: null }] })
    expect(describeOperatorPlan(plan, NOW).meterLines).toEqual(['Managed AI tokens: limit 50,000'])
  })
  it('no copy contains an em dash', () => {
    const plans = [
      deriveOperatorPlan({ ...base, managed: false }),
      deriveOperatorPlan({ ...base, live: null, persisted: live() }),
      deriveOperatorPlan({ ...base, live: live({ at: 1 }) }),
      deriveOperatorPlan({ ...base, live: live({ tier: null }) }),
      deriveOperatorPlan(base)
    ]
    for (const plan of plans) {
      const copy = describeOperatorPlan(plan, NOW)
      expect([copy.headline, copy.detail, ...copy.meterLines].join('\n')).not.toContain('—')
    }
  })
})
