import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CounterMetricId } from '@shared/responsiveness-metrics'
import { emptyModelPolicyEntry, MODEL_POLICY_CAPABILITIES, type ModelPolicyDocument } from '@shared/model-policy'
import { routeTier } from '@shared/routing'

const local = vi.hoisted(() => ({
  primary: vi.fn(() => false),
  fallback: vi.fn(() => false),
  floor: vi.fn(() => false)
}))

vi.mock('./llm/local-routing', () => ({
  localPrimaryEligibleFor: local.primary,
  localFallbackEligibleFor: local.fallback,
  localAnswerFloorEligibleFor: local.floor
}))

import { planAsk, type AskPlanInput } from './ask-route'

const settings = (over: Record<string, unknown> = {}): AskPlanInput['settings'] =>
  ({
    thinkingMode: 'auto',
    cliConnected: {},
    routingMode: 'auto',
    localLlm: { enabled: false, fallback: false, useFor: {} },
    ...over
  }) as unknown as AskPlanInput['settings']

const policy = (): ModelPolicyDocument => ({
  version: 1,
  updatedAt: 1,
  updatedBy: 'synthetic-owner',
  localSpeechPack: 'offered',
  capabilities: Object.fromEntries(
    MODEL_POLICY_CAPABILITIES.map((k) => [k, emptyModelPolicyEntry('synthetic-cloud', 'synthetic-model-a')])
  ) as ModelPolicyDocument['capabilities']
})

function run(over: Partial<AskPlanInput> & { req: AskPlanInput['req'] }) {
  const counts: CounterMetricId[] = []
  const plan = planAsk({
    settings: settings(),
    allowed: null,
    orgAllowed: null,
    policy: null,
    metrics: { increment: (id) => void counts.push(id) },
    ...over
  })
  return { plan, counts }
}

const ask = (over: Partial<AskPlanInput['req']> = {}): AskPlanInput['req'] =>
  ({ id: 'a', mode: 'answer', prompt: 'What is the plan?', history: [], ...over }) as AskPlanInput['req']

beforeEach(() => {
  local.primary.mockReset().mockReturnValue(false)
  local.fallback.mockReset().mockReturnValue(false)
  local.floor.mockReset().mockReturnValue(false)
})

describe('legacy parity: the router changes nothing for an ordinary ask', () => {
  it.each([
    'suggest',
    'answer',
    'vision'
  ] as const)('%s keeps the heuristic tier and the local first decision', (mode) => {
    local.primary.mockReturnValue(true)
    const req = ask({ mode, prompt: 'Explain the trade-offs of this architecture in depth, step by step.' })
    const { plan } = run({ req })
    expect(plan.unavailable).toBeNull()
    expect(plan.tier).toBe(routeTier(req, 'auto'))
    expect(plan.localPrimaryEligible).toBe(true)
  })

  it.each(['recap', 'summary'] as const)('%s is not routed: heuristic tier, no counts, no refusal', (mode) => {
    local.primary.mockReturnValue(true)
    const req = ask({ mode })
    const { plan, counts } = run({ req })
    expect(plan).toEqual({ tier: routeTier(req, 'auto'), localPrimaryEligible: true, unavailable: null })
    expect(counts).toEqual([])
  })

  it('evaluates local eligibility against the final tier and the settings it was given', () => {
    run({ req: ask({ mode: 'suggest' }) })
    expect(local.primary).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'suggest' }),
      expect.anything(),
      'base',
      null
    )
  })
})

describe('deeper', () => {
  it('a Go deeper ask is a deep answer: the tier rises from base', () => {
    const { plan } = run({ req: ask({ depth: 'deeper', prompt: 'Short question?' }) })
    expect(plan.tier).toBe('think')
  })

  it('the user who chose never-think keeps the base tier', () => {
    const { plan } = run({ req: ask({ depth: 'deeper' }), settings: settings({ thinkingMode: 'never' }) })
    expect(plan.tier).toBe('base')
  })
})

describe('decisions are counted, counts only', () => {
  it('on-device first', () => {
    local.primary.mockReturnValue(true)
    expect(run({ req: ask({ mode: 'suggest' }) }).counts).toEqual(['router_local_first'])
  })
  it('provider first', () => {
    expect(run({ req: ask() }).counts).toEqual(['router_cloud_first'])
  })
  it('refused', () => {
    const { plan, counts } = run({ req: ask(), orgAllowed: ['local'], allowed: ['local'] })
    expect(plan.unavailable).toMatch(/on-device processing only/)
    expect(counts).toEqual(['router_unavailable'])
  })
  it('a metrics sink that throws never breaks routing', () => {
    const plan = planAsk({
      req: ask(),
      settings: settings(),
      allowed: null,
      orgAllowed: null,
      policy: null,
      metrics: {
        increment: () => {
          throw new Error('synthetic sink failure')
        }
      }
    })
    expect(plan.unavailable).toBeNull()
  })
})

describe('organisation limits', () => {
  it('an admin allowlist of on-device only is local-only: an answer the on-device model cannot serve is refused with honest copy', () => {
    const { plan } = run({ req: ask({ mode: 'answer' }), orgAllowed: ['local'], allowed: ['local'] })
    expect(plan.unavailable).toMatch(/Nothing was sent to a cloud provider/)
  })

  it('local-only is served when the on-device model can take it, on the base tier', () => {
    local.primary.mockImplementation(() => true)
    const { plan } = run({
      req: ask({ mode: 'suggest', prompt: 'Explain the trade-offs of this architecture in depth.' }),
      orgAllowed: ['local'],
      allowed: ['local']
    })
    expect(plan).toMatchObject({ tier: 'base', localPrimaryEligible: true, unavailable: null })
  })

  it('a managed fleet whose approved models were all narrowed away, with nothing else able to answer, refuses honestly', () => {
    const { plan } = run({ req: ask(), policy: policy(), orgAllowed: ['synthetic-unrelated'] })
    expect(plan.unavailable).toMatch(/has not approved a model/)
  })

  it('a connected CLI keeps a managed fleet answering', () => {
    const { plan } = run({
      req: ask(),
      policy: policy(),
      orgAllowed: ['synthetic-unrelated'],
      settings: settings({ cliConnected: { 'claude-cli': true } })
    })
    expect(plan.unavailable).toBeNull()
  })
})
