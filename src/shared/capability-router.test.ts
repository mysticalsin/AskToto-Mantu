import { describe, expect, it } from 'vitest'
import {
  COST_CLASSES,
  DEEP_MIN_DEADLINE_MS,
  FAST_ONLY_DEADLINE_MS,
  ROUTER_CAPABILITIES,
  ROUTER_DEADLINES_MS,
  askCapabilityOf,
  policyCapabilityFor,
  routeCapability,
  type RouterInput
} from './capability-router'
import { emptyModelPolicyEntry, MODEL_POLICY_CAPABILITIES, type ModelPolicyDocument } from './model-policy'

const never = (): boolean => false

function policy(overrides: Partial<ModelPolicyDocument['capabilities']> = {}): ModelPolicyDocument {
  const base = Object.fromEntries(
    MODEL_POLICY_CAPABILITIES.map((k) => [k, emptyModelPolicyEntry('synthetic-cloud', 'synthetic-model-a')])
  ) as ModelPolicyDocument['capabilities']
  return {
    version: 1,
    updatedAt: 1,
    updatedBy: 'synthetic-owner',
    localSpeechPack: 'offered',
    capabilities: { ...base, ...overrides }
  }
}

function input(over: Partial<RouterInput> = {}): RouterInput {
  return {
    capability: 'answer',
    requestedTier: 'base',
    deadlineMs: null,
    costCeiling: null,
    localOnly: false,
    localFirstAt: never,
    localLastResortAt: never,
    policy: null,
    orgAllowed: null,
    cliReady: false,
    ...over
  }
}

describe('capability mapping', () => {
  it('names every capability once and maps ask modes onto them', () => {
    expect([...ROUTER_CAPABILITIES]).toEqual([
      'suggest',
      'answer',
      'deep_answer',
      'vision',
      'command_intent',
      'dictation_polish'
    ])
    expect(askCapabilityOf({ mode: 'suggest' })).toBe('suggest')
    expect(askCapabilityOf({ mode: 'answer' })).toBe('answer')
    expect(askCapabilityOf({ mode: 'vision' })).toBe('vision')
    expect(askCapabilityOf({ mode: 'answer', depth: 'deeper' })).toBe('deep_answer')
    expect(askCapabilityOf({ mode: 'vision', depth: 'deeper' })).toBe('deep_answer')
    // recap and summary have their own policy path and are not routed here
    expect(askCapabilityOf({ mode: 'recap' })).toBeNull()
    expect(askCapabilityOf({ mode: 'summary' })).toBeNull()
  })

  it('maps onto fleet policy capabilities and never invents one for dictation polish', () => {
    expect(policyCapabilityFor('suggest')).toBe('askChat')
    expect(policyCapabilityFor('answer')).toBe('askChat')
    expect(policyCapabilityFor('deep_answer')).toBe('askChat')
    expect(policyCapabilityFor('vision')).toBe('askChat')
    expect(policyCapabilityFor('command_intent')).toBe('commandAgent')
    expect(policyCapabilityFor('dictation_polish')).toBeNull()
  })

  it('has a deadline default for every capability and the suggestion one is the spec p95', () => {
    for (const c of ROUTER_CAPABILITIES) expect(ROUTER_DEADLINES_MS[c]).toBeGreaterThan(0)
    expect(ROUTER_DEADLINES_MS.suggest).toBe(2500)
  })
})

describe('tier, deadline and cost', () => {
  it('keeps the heuristic tier when nothing limits it', () => {
    for (const tier of ['base', 'think', 'deep'] as const) {
      const plan = routeCapability(input({ requestedTier: tier }))
      expect(plan.kind).toBe('route')
      if (plan.kind === 'route') {
        expect(plan.tier).toBe(tier)
        expect(plan.limits).toEqual([])
      }
    }
  })

  it('a tight deadline answers fast: everything drops to base', () => {
    const plan = routeCapability(input({ requestedTier: 'deep', deadlineMs: FAST_ONLY_DEADLINE_MS }))
    expect(plan).toMatchObject({ kind: 'route', tier: 'base', limits: ['deadline'] })
  })

  it('a middling deadline cannot start the deepest tier but may think', () => {
    const plan = routeCapability(input({ requestedTier: 'deep', deadlineMs: DEEP_MIN_DEADLINE_MS - 1 }))
    expect(plan).toMatchObject({ kind: 'route', tier: 'think', limits: ['deadline'] })
    const roomy = routeCapability(input({ requestedTier: 'deep', deadlineMs: DEEP_MIN_DEADLINE_MS }))
    expect(roomy).toMatchObject({ kind: 'route', tier: 'deep', limits: [] })
  })

  it('uses the capability default when the caller gives no deadline', () => {
    const suggest = routeCapability(input({ capability: 'suggest', requestedTier: 'think' }))
    // 2500 ms is under the fast-only line, so a suggestion never leaves the base tier
    expect(suggest).toMatchObject({ kind: 'route', tier: 'base', deadlineMs: ROUTER_DEADLINES_MS.suggest })
  })

  it('a cost ceiling caps the tier and the plan reports its cost class', () => {
    const plan = routeCapability(input({ requestedTier: 'deep', costCeiling: 'low' }))
    expect(plan).toMatchObject({ kind: 'route', tier: 'base', costClass: 'low', limits: ['cost'] })
    const mid = routeCapability(input({ requestedTier: 'deep', costCeiling: 'standard' }))
    expect(mid).toMatchObject({ kind: 'route', tier: 'think', costClass: 'standard' })
    expect(COST_CLASSES).toEqual(['free', 'low', 'standard', 'premium'])
  })

  it('an explicit deeper ask raises a base tier to think, unless the user capped cost', () => {
    const raised = routeCapability(input({ capability: 'deep_answer', requestedTier: 'base' }))
    expect(raised).toMatchObject({ kind: 'route', tier: 'think' })
    const capped = routeCapability(input({ capability: 'deep_answer', requestedTier: 'base', costCeiling: 'low' }))
    expect(capped).toMatchObject({ kind: 'route', tier: 'base' })
  })

  it('a local first attempt is free', () => {
    const plan = routeCapability(input({ requestedTier: 'base', localFirstAt: (t) => t === 'base' }))
    expect(plan).toMatchObject({ kind: 'route', localFirst: true, costClass: 'free' })
  })

  it('judges local eligibility at the tier the plan ended on, not the one requested', () => {
    const seen: string[] = []
    routeCapability(
      input({
        requestedTier: 'deep',
        deadlineMs: FAST_ONLY_DEADLINE_MS,
        localFirstAt: (t) => {
          seen.push(t)
          return true
        }
      })
    )
    expect(seen).toEqual(['base'])
  })

  it('an expired deadline is unavailable with honest copy, not a silent start', () => {
    const plan = routeCapability(input({ deadlineMs: 0 }))
    expect(plan.kind).toBe('unavailable')
    if (plan.kind === 'unavailable') {
      expect(plan.reason).toBe('deadline_expired')
      expect(plan.message).toMatch(/no time left/i)
    }
  })
})

describe('managed policy', () => {
  it('never emits a model of its own: no policy leaves the model to the user settings', () => {
    const plan = routeCapability(input({ policy: null }))
    expect(plan).toMatchObject({ kind: 'route', managed: false, model: null })
  })

  it('emits only the policy model for the capability, primary first', () => {
    const doc = policy({
      askChat: {
        provider: 'synthetic-cloud',
        model: 'synthetic-model-a',
        fallbacks: [{ provider: 'synthetic-second', model: 'synthetic-model-b' }]
      }
    })
    const plan = routeCapability(input({ policy: doc }))
    expect(plan).toMatchObject({
      kind: 'route',
      managed: true,
      model: { provider: 'synthetic-cloud', model: 'synthetic-model-a' }
    })
  })

  it('an admin allowlist narrows the policy candidates', () => {
    const doc = policy({
      askChat: {
        provider: 'synthetic-cloud',
        model: 'synthetic-model-a',
        fallbacks: [{ provider: 'synthetic-second', model: 'synthetic-model-b' }]
      }
    })
    const plan = routeCapability(input({ policy: doc, orgAllowed: ['synthetic-second'] }))
    expect(plan).toMatchObject({ kind: 'route', model: { provider: 'synthetic-second', model: 'synthetic-model-b' } })
  })

  it('every candidate narrowed away and nothing else able to answer is typed unavailable', () => {
    const plan = routeCapability(input({ policy: policy(), orgAllowed: ['synthetic-unrelated'] }))
    expect(plan.kind).toBe('unavailable')
    if (plan.kind === 'unavailable') {
      expect(plan.reason).toBe('no_policy_model')
      expect(plan.message).toMatch(/has not approved a model/i)
      expect(plan.message).not.toMatch(/synthetic/)
    }
  })

  it('a connected CLI or a ready local model still answers when no cloud candidate is left', () => {
    const narrowed = { policy: policy(), orgAllowed: ['synthetic-unrelated'] }
    expect(routeCapability(input({ ...narrowed, cliReady: true })).kind).toBe('route')
    expect(routeCapability(input({ ...narrowed, localLastResortAt: () => true })).kind).toBe('route')
  })

  it('dictation polish has no policy model: unavailable on a managed fleet unless local can do it', () => {
    const managed = routeCapability(input({ capability: 'dictation_polish', policy: policy() }))
    expect(managed).toMatchObject({ kind: 'unavailable', reason: 'no_policy_model' })
    const local = routeCapability(
      input({ capability: 'dictation_polish', policy: policy(), localFirstAt: (t) => t === 'base' })
    )
    expect(local).toMatchObject({ kind: 'route', localFirst: true, managed: true, model: null })
    // without a fleet policy the user's own provider settings decide, as before
    expect(routeCapability(input({ capability: 'dictation_polish', policy: null })).kind).toBe('route')
  })

  it('command intent reads the commandAgent policy entry', () => {
    const doc = policy({ commandAgent: emptyModelPolicyEntry('synthetic-cmd', 'synthetic-model-c') })
    const plan = routeCapability(input({ capability: 'command_intent', policy: doc }))
    expect(plan).toMatchObject({ kind: 'route', model: { provider: 'synthetic-cmd', model: 'synthetic-model-c' } })
  })
})

describe('local-only', () => {
  it('is honoured: the plan stays on the base tier and says so', () => {
    const plan = routeCapability(input({ requestedTier: 'deep', localOnly: true, localFirstAt: (t) => t === 'base' }))
    expect(plan).toMatchObject({ kind: 'route', tier: 'base', localFirst: true, localOnly: true })
    if (plan.kind === 'route') expect(plan.limits).toContain('local_only')
  })

  it('never offers a cloud model while local-only is on', () => {
    const plan = routeCapability(input({ localOnly: true, policy: policy(), localFirstAt: (t) => t === 'base' }))
    expect(plan).toMatchObject({ kind: 'route', model: null })
  })

  it('is unavailable, never a silent cloud send, when the on-device model cannot serve it', () => {
    const plan = routeCapability(input({ capability: 'answer', localOnly: true }))
    expect(plan.kind).toBe('unavailable')
    if (plan.kind === 'unavailable') {
      expect(plan.reason).toBe('local_only_unfit')
      expect(plan.message).toMatch(/on-device/i)
      expect(plan.message).toMatch(/nothing was sent/i)
    }
  })

  it('the last-resort local floor counts as able to serve', () => {
    const plan = routeCapability(input({ localOnly: true, localLastResortAt: () => true }))
    expect(plan.kind).toBe('route')
  })
})

describe('copy', () => {
  it('names the capability in plain words and avoids dashes and raw ids', () => {
    for (const capability of ROUTER_CAPABILITIES) {
      const plan = routeCapability(input({ capability, localOnly: true }))
      expect(plan.kind).toBe('unavailable')
      if (plan.kind === 'unavailable') {
        expect(plan.message).not.toMatch(/[–—]/)
        expect(plan.message).not.toMatch(/_/)
      }
    }
  })
})
