import { describe, expect, it } from 'vitest'
import { type DeciderOutput, type JevDecider, loadScenarios, runScenario } from './harness'
import type { Capability, Scenario } from './label-schema'

const ALL: ReadonlySet<Capability> = new Set([
  'stale-drop',
  'card-swap',
  'classifier',
  'network-boundary',
  'cost-attribution',
  'action-contract'
])

function scenario(over: Partial<Scenario>): Scenario {
  return {
    schemaVersion: 1,
    id: 'JEV-01',
    title: 't',
    synthetic: true,
    language: 'en',
    meetingType: 'internal',
    requires: [],
    steps: [
      { kind: 'final', utteranceId: 'u1', revision: 1, speaker: 'them', text: 'one', lang: 'en', tMs: 1000 },
      { kind: 'final', utteranceId: 'u2', revision: 1, speaker: 'them', text: 'two', lang: 'en', tMs: 2000 }
    ],
    labels: [],
    expect: {},
    ...over
  }
}

function decider(
  fn: (stepIndex: number, nowMs: number) => DeciderOutput[],
  capabilities: ReadonlySet<Capability> = ALL
): JevDecider {
  let i = -1
  return {
    name: 'fake',
    capabilities,
    reset: () => {
      i = -1
    },
    onStep: (_step, ctx) => {
      i += 1
      return fn(i, ctx.nowMs)
    }
  }
}

const generate: DeciderOutput = { outcome: 'generate', reason: 'question-detected', generationCalls: 1 }

describe('runScenario', () => {
  it('is deterministic across two runs', () => {
    const scenarios = loadScenarios()
    const d = decider((i) => (i === 0 ? [generate] : []))
    for (const s of scenarios) expect(runScenario(s, d)).toEqual(runScenario(s, d))
  })

  it('returns not_run with the missing capability and owning ticket', () => {
    const r = runScenario(
      scenario({ requires: ['stale-drop', 'classifier'] }),
      decider(() => [], new Set())
    )
    expect(r.verdict).toBe('not_run')
    expect(r.missing).toEqual(['stale-drop', 'classifier'])
    expect(r.owners).toEqual(['G05/G70', 'G74'])
    expect(r.records).toEqual([])
  })

  it('scores a generate on warranted:false as a false interruption', () => {
    const r = runScenario(
      scenario({ labels: [{ at: 0, warranted: false, reason: 'rhetorical' }] }),
      decider((i) => (i === 0 ? [generate] : []))
    )
    expect(r.falseInterruptions).toBe(1)
    expect(r.verdict).toBe('fail')
  })

  it('scores an unanswered warranted label as a miss', () => {
    const r = runScenario(
      scenario({ labels: [{ at: 0, warranted: true, reason: 'direct-question', useful: true }] }),
      decider(() => [])
    )
    expect(r.missed).toBe(1)
    expect(r.verdict).toBe('fail')
  })

  it('records first-useful-card latency from the label step', () => {
    const r = runScenario(
      scenario({ labels: [{ at: 0, warranted: true, reason: 'direct-question', useful: true }] }),
      decider((i) => (i === 1 ? [generate] : []))
    )
    expect(r.missed).toBe(0)
    expect(r.firstUsefulLatenciesMs).toEqual([1000])
  })

  it('quiet drop is suppressed-quiet, not a miss', () => {
    const r = runScenario(
      scenario({ labels: [{ at: 0, warranted: true, reason: 'direct-question', useful: true }] }),
      decider((i) => (i === 0 ? [{ outcome: 'suppressed-quiet', reason: 'quiet-gate' }] : []))
    )
    expect(r.missed).toBe(0)
    expect(r.falseInterruptions).toBe(0)
    expect(r.verdict).toBe('pass')
  })

  it('checks the expect block', () => {
    const r = runScenario(
      scenario({ expect: { maxCards: 0, mustStaleDrop: ['u1'], finalCardKey: 'k' } }),
      decider((i) => (i === 0 ? [{ ...generate, cardKey: 'other' }] : []))
    )
    expect(r.expectFailures).toEqual(['maxCards', 'mustStaleDrop', 'finalCardKey'])
  })

  it('advances the injected clock by pause and tMs, never wall time', () => {
    const seen: number[] = []
    runScenario(
      scenario({
        steps: [
          { kind: 'pause', ms: 500 },
          { kind: 'final', utteranceId: 'u1', revision: 1, speaker: 'them', text: 'x', lang: 'en', tMs: 4000 },
          { kind: 'pause', ms: 250 }
        ]
      }),
      decider((_i, now) => {
        seen.push(now)
        return []
      })
    )
    expect(seen).toEqual([500, 4000, 4250])
  })
})
