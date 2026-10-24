import { describe, expect, it, vi } from 'vitest'
import { InterventionGate, diffTranscriptLines, type InterventionShadowRecord } from './intervention-gate'

const rules = (shouldGenerate: boolean) => ({
  shouldGenerate,
  reason: shouldGenerate ? 'question-detected' : 'cooldown'
})

function gate(report?: (record: InterventionShadowRecord) => void): InterventionGate {
  return new InterventionGate({ meetingStartMs: 1_000, report })
}

describe('InterventionGate', () => {
  it('disabled policy returns the existing-rules decision unchanged', async () => {
    const g = gate()
    for (const shouldGenerate of [true, false]) {
      const { decision } = await g.decide('question', rules(shouldGenerate))
      expect(decision.status).toBe('existing-rules')
      expect(decision.shouldGenerate).toBe(shouldGenerate)
      expect(decision.reason).toBe(rules(shouldGenerate).reason)
    }
  })

  it('a new final makes an earlier snapshot stale', async () => {
    const g = gate()
    const { snapshot } = await g.decide('shadow', rules(true))
    expect(g.isCurrent(snapshot)).toBe(true)
    g.observe({ kind: 'final', lineId: 't1' })
    expect(g.isCurrent(snapshot)).toBe(false)
  })

  it('correction of the trigger line hard-invalidates its snapshot; an unrelated final does not', async () => {
    const g = gate()
    const { snapshot } = await g.decide('question', rules(true), 't5')
    g.observe({ kind: 'final', lineId: 't6' })
    expect(g.isHardInvalidated(snapshot)).toBe(false)
    g.observe({ kind: 'correction', lineId: 't5' })
    expect(g.isHardInvalidated(snapshot)).toBe(true)
  })

  it('retraction of the trigger line hard-invalidates its snapshot', async () => {
    const g = gate()
    const { snapshot } = await g.decide('question', rules(true), 't9')
    g.observe({ kind: 'retraction', lineId: 't9' })
    expect(g.isHardInvalidated(snapshot)).toBe(true)
  })

  it('stop, resume, meeting switch, sign-out and permission revoke bump generation', async () => {
    for (const change of ['stop', 'resume', 'meeting-switch', 'sign-out', 'permission-revoked'] as const) {
      const g = gate()
      const { snapshot } = await g.decide('question', rules(true), 't1')
      const before = g.generation
      g.observe({ kind: 'scope', change })
      expect(g.generation, change).toBe(before + 1)
      expect(g.isCurrent(snapshot), change).toBe(false)
      expect(g.isHardInvalidated(snapshot), change).toBe(true)
    }
  })

  it('rejects a snapshot it did not issue', async () => {
    const g = gate()
    const { snapshot } = await g.decide('shadow', rules(true))
    expect(g.isCurrent({ ...snapshot })).toBe(false)
    expect(g.isHardInvalidated({ ...snapshot })).toBe(true)
    expect(g.isCurrent(gate().issue())).toBe(false)
  })

  it('shadow records carry no text and the ring is capped at 64', async () => {
    const report = vi.fn()
    const g = gate(report)
    const { decision } = await g.decide('question', rules(true))
    for (let i = 0; i < 70; i += 1) g.record({ path: 'question', decision, outcome: 'hold' })
    expect(g.records()).toHaveLength(64)
    expect(report).toHaveBeenCalledTimes(70)
    const keys = new Set(g.records().flatMap((r) => Object.keys(r)))
    expect([...keys].sort()).toEqual(
      ['contextRevision', 'generation', 'outcome', 'path', 'reason', 'shouldGenerate', 'status'].sort()
    )
  })

  it('a throwing report sink never breaks a decision', async () => {
    const g = gate(() => {
      throw new Error('synthetic sink failure')
    })
    const { decision } = await g.decide('question', rules(true))
    expect(() => g.record({ path: 'question', decision, outcome: 'generate' })).not.toThrow()
  })
})

describe('diffTranscriptLines', () => {
  it('detects final, correction and retraction', () => {
    const prev = [
      { t: 1, text: 'one' },
      { t: 2, text: 'two' }
    ]
    const next = [
      { t: 2, text: 'two changed' },
      { t: 3, text: 'three' }
    ]
    expect(diffTranscriptLines(prev, next)).toEqual([
      { kind: 'correction', lineId: 't2' },
      { kind: 'final', lineId: 't3' },
      { kind: 'retraction', lineId: 't1' }
    ])
  })

  it('ignores provisional lines and unchanged lines', () => {
    const prev = [{ t: 1, text: 'one' }]
    const next = [
      { t: 1, text: 'one' },
      { t: 2, text: 'draft', provisional: true }
    ]
    expect(diffTranscriptLines(prev, next)).toEqual([])
  })
})
