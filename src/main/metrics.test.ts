import { describe, it, expect, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { aggregateMetrics, readEvalMetrics, type AuditRecord } from './metrics'

// metrics.ts imports `app` from electron for readEvalMetrics; aggregateMetrics is pure and never touches
// it, so the auto-mock just keeps the top-level import from throwing in the node test environment.
vi.mock('electron')
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const syncReadBlocked = () => {
    throw new Error('sync fs read should not be used by readEvalMetrics')
  }
  return {
    ...actual,
    default: { ...actual, existsSync: syncReadBlocked, readFileSync: syncReadBlocked },
    existsSync: syncReadBlocked,
    readFileSync: syncReadBlocked
  }
})

describe('aggregateMetrics', () => {
  it('computes latency percentiles, acceptance, failures, fallbacks, and per-provider counts', () => {
    const records: AuditRecord[] = [
      { event: 'provider.request', provider: 'anthropic' },
      { event: 'provider.request', phase: 'done', ttftMs: 100, totalMs: 1000, inputTokens: 10, outputTokens: 50 },
      { event: 'provider.request', provider: 'anthropic' },
      { event: 'provider.request', phase: 'done', ttftMs: 200, totalMs: 2000, inputTokens: 20, outputTokens: 100 },
      { event: 'provider.request', provider: 'dust', retry: true },
      { event: 'provider.request', phase: 'done', ttftMs: 300, totalMs: 3000, inputTokens: 30, outputTokens: 150 },
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
    expect(m.tokensIn).toBe(60)
    expect(m.tokensOut).toBe(300)
    expect(m.byProvider).toEqual({ anthropic: 2, dust: 1 })
  })

  // MQA-088: main re-enters attempt() for a same-provider transient retry with the tried-provider list
  // unchanged, so the retry re-emits provider.request carrying the SAME `retry` flag as the attempt it
  // repeats. One ask that failed over exactly once must therefore still report one fallback, not two.
  it('MQA-088: counts a cross-provider failover as a fallback but a same-provider retry as a repeat', () => {
    const records: AuditRecord[] = [
      // deepseek 429s, then retries itself — first provider, so `retry` is false on both records.
      { event: 'provider.request', provider: 'deepseek' },
      { event: 'provider.failed', provider: 'deepseek' },
      { event: 'provider.retry', provider: 'deepseek' },
      { event: 'provider.request', provider: 'deepseek' },
      { event: 'provider.failed', provider: 'deepseek' },
      // The one real failover: the ask hops to a different provider.
      { event: 'provider.request', provider: 'nvidia', retry: true },
      { event: 'provider.failed', provider: 'nvidia' },
      // nvidia 429s and retries ITSELF — same-provider, but still carrying the failover flag.
      { event: 'provider.retry', provider: 'nvidia' },
      { event: 'provider.request', provider: 'nvidia', retry: true },
      { event: 'provider.request', phase: 'done', provider: 'nvidia', ttftMs: 300, totalMs: 3000 }
    ]
    const m = aggregateMetrics(records)
    expect(m.fallbacks).toBe(1)
    expect(m.failures).toBe(3)
    // Per-provider stays a REQUEST count: a retry really is another request issued to that provider.
    expect(m.byProvider).toEqual({ deepseek: 2, nvidia: 2 })
  })

  it('MQA-088: a provider.retry consumed by its own repeat does not mask a later failover', () => {
    const records: AuditRecord[] = [
      { event: 'provider.request', provider: 'kimi', retry: true },
      { event: 'provider.retry', provider: 'kimi' },
      { event: 'provider.request', provider: 'kimi', retry: true }, // the repeat — consumes the marker
      { event: 'provider.request', provider: 'kimi', retry: true } // a later ask failing over INTO kimi
    ]
    expect(aggregateMetrics(records).fallbacks).toBe(2)
  })

  it('returns safe nulls/zeros for an empty log', () => {
    const m = aggregateMetrics([])
    expect(m.answers).toBe(0)
    expect(m.ttftP50Ms).toBeNull()
    expect(m.answerP95Ms).toBeNull()
    expect(m.acceptance).toEqual({ up: 0, down: 0, rate: null })
    expect(m.failures).toBe(0)
    expect(m.tokensIn).toBe(0)
    expect(m.tokensOut).toBe(0)
    expect(m.byProvider).toEqual({})
    expect(m.brainConsolidationPasses).toBe(0)
  })

  // Wave 3: the QUALITY-SCORECARD's "Brain LLM consolidations / active day" reads this off the audit
  // log, distinct from the per-meeting provider.request counts above.
  it('counts brain.consolidation events independent of provider request/failure counts', () => {
    const records: AuditRecord[] = [
      { event: 'brain.consolidation' },
      { event: 'provider.request', provider: 'anthropic' },
      { event: 'brain.consolidation' }
    ]
    expect(aggregateMetrics(records).brainConsolidationPasses).toBe(2)
  })
})

describe('readEvalMetrics', () => {
  it('tails the audit log through async fs instead of requiring synchronous full-file reads', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'asktoto-metrics-'))
    try {
      vi.mocked(app.getPath).mockReturnValue(userData)
      await mkdir(join(userData, 'logs'), { recursive: true })
      const records: AuditRecord[] = [
        { event: 'provider.request', provider: 'older' },
        { event: 'provider.request', phase: 'done', totalMs: 100, ttftMs: 10 },
        { event: 'provider.request', provider: 'kept' },
        { event: 'provider.request', phase: 'done', totalMs: 200, ttftMs: 20 },
        { event: 'answer.feedback', rating: 'up' }
      ]
      await writeFile(join(userData, 'logs', 'audit.log'), records.map((record) => JSON.stringify(record)).join('\n'), 'utf8')

      const metrics = await readEvalMetrics(3)
      expect(metrics.answers).toBe(1)
      expect(metrics.answerP50Ms).toBe(200)
      expect(metrics.byProvider).toEqual({ kept: 1 })
      expect(metrics.acceptance).toEqual({ up: 1, down: 0, rate: 1 })
    } finally {
      await rm(userData, { recursive: true, force: true })
    }
  })
})
