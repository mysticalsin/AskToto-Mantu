import { describe, it, expect, vi } from 'vitest'
import { aggregateMetrics, type AuditRecord } from './metrics'

// metrics.ts imports `app` from electron for readEvalMetrics; aggregateMetrics is pure and never touches
// it, so the auto-mock just keeps the top-level import from throwing in the node test environment.
vi.mock('electron')

describe('aggregateMetrics', () => {
  it('computes latency percentiles, acceptance, failures, fallbacks, and per-provider counts', () => {
    const records: AuditRecord[] = [
      { event: 'provider.request', provider: 'anthropic' },
      { event: 'provider.request', phase: 'done', ttftMs: 100, totalMs: 1000 },
      { event: 'provider.request', provider: 'anthropic' },
      { event: 'provider.request', phase: 'done', ttftMs: 200, totalMs: 2000 },
      { event: 'provider.request', provider: 'dust', retry: true },
      { event: 'provider.request', phase: 'done', ttftMs: 300, totalMs: 3000 },
      { event: 'provider.failed' },
      { event: 'answer.feedback', rating: 'up' },
      { event: 'answer.feedback', rating: 'up' },
      { event: 'answer.feedback', rating: 'down' }
    ]
    const m = aggregateMetrics(records)
    expect(m.answers).toBe(3)
    expect(m.ttftP50Ms).toBe(200) // nearest-rank p50 of [100,200,300]
    expect(m.ttftP95Ms).toBe(300)
    expect(m.answerP50Ms).toBe(2000)
    expect(m.answerP95Ms).toBe(3000)
    expect(m.acceptance).toEqual({ up: 2, down: 1, rate: 2 / 3 })
    expect(m.failures).toBe(1)
    expect(m.fallbacks).toBe(1)
    expect(m.byProvider).toEqual({ anthropic: 2, dust: 1 })
  })

  it('returns safe nulls/zeros for an empty log', () => {
    const m = aggregateMetrics([])
    expect(m.answers).toBe(0)
    expect(m.ttftP50Ms).toBeNull()
    expect(m.answerP95Ms).toBeNull()
    expect(m.acceptance).toEqual({ up: 0, down: 0, rate: null })
    expect(m.failures).toBe(0)
    expect(m.byProvider).toEqual({})
  })
})
