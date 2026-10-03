import { describe, expect, it, vi } from 'vitest'
import { createHistoryTracer } from './history-trace'

const id = (n: number): string => `123e4567-e89b-12d3-a456-4266141740${String(n).padStart(2, '0')}`

describe('createHistoryTracer', () => {
  it('serves missing or invalid traces without auditing', async () => {
    const audit = vi.fn()
    const tracer = createHistoryTracer({ audit })

    await expect(tracer.traceList(undefined, async () => ['a'] as const)).resolves.toEqual(['a'])
    await expect(tracer.traceList({ requestId: 'bad', sentAt: 1 }, async () => ['b'] as const)).resolves.toEqual(['b'])
    expect(audit).not.toHaveBeenCalled()
  })

  it('audits received with queueMs clamped at zero', async () => {
    const audit = vi.fn()
    const tracer = createHistoryTracer({ audit, wallClock: () => 90, clock: () => 0 })

    await tracer.traceList({ requestId: id(1), sentAt: 100 }, async () => [] as const)

    expect(audit).toHaveBeenCalledWith('history.request', { requestId: id(1), stage: 'received', queueMs: 0 })
  })

  it('audits served ok with mainMs, resultCount and notDownloadedCount', async () => {
    const audit = vi.fn()
    const times = [10, 37]
    const tracer = createHistoryTracer({ audit, wallClock: () => 125, clock: () => times.shift() ?? 37 })

    const rows = [
      { title: 'local', notDownloaded: false },
      { title: 'cloud', notDownloaded: true },
      { title: 'unknown' },
      { title: 'truthy string', notDownloaded: 'true' }
    ] as const

    await expect(tracer.traceList({ requestId: id(2), sentAt: 100 }, async () => rows)).resolves.toEqual(rows)

    expect(audit).toHaveBeenCalledWith('history.request', {
      requestId: id(2),
      stage: 'served',
      outcome: 'ok',
      mainMs: 27,
      resultCount: 4,
      notDownloadedCount: 1
    })
  })

  it('audits served failed and rethrows', async () => {
    const audit = vi.fn()
    const error = new Error('list failed')
    const times = [5, 9]
    const tracer = createHistoryTracer({ audit, wallClock: () => 100, clock: () => times.shift() ?? 9 })

    await expect(tracer.traceList({ requestId: id(3), sentAt: 90 }, async () => { throw error })).rejects.toThrow(error)
    expect(audit).toHaveBeenCalledWith('history.request', {
      requestId: id(3),
      stage: 'served',
      outcome: 'failed',
      mainMs: 4
    })
  })

  it('accepts settle once for a received id and ignores unknown, repeated or invalid reports', async () => {
    const audit = vi.fn()
    const tracer = createHistoryTracer({ audit, wallClock: () => 100, clock: () => 0 })
    await tracer.traceList({ requestId: id(4), sentAt: 99 }, async () => [] as const)

    tracer.settle({ requestId: 'unknown', outcome: 'ok', ipcMs: 1 })
    tracer.settle({ requestId: id(4), outcome: 'ok', ipcMs: 2, renderMs: 3 })
    tracer.settle({ requestId: id(4), outcome: 'failed', ipcMs: 4 })
    tracer.settle({ requestId: id(5), outcome: 'other', ipcMs: 1 })

    expect(audit.mock.calls.filter((call) => call[1]?.stage === 'settled')).toEqual([
      ['history.request', { requestId: id(4), stage: 'settled', outcome: 'ok', ipcMs: 2, renderMs: 3 }]
    ])
  })

  it('evicts the oldest unsettled id after 33 requests', async () => {
    const audit = vi.fn()
    const tracer = createHistoryTracer({ audit, wallClock: () => 100, clock: () => 0 })
    for (let i = 1; i <= 33; i++) {
      await tracer.traceList({ requestId: id(i), sentAt: 99 }, async () => [] as const)
    }

    tracer.settle({ requestId: id(1), outcome: 'ok', ipcMs: 1 })
    tracer.settle({ requestId: id(33), outcome: 'ok', ipcMs: 2 })

    expect(audit.mock.calls.filter((call) => call[1]?.stage === 'settled')).toEqual([
      ['history.request', { requestId: id(33), stage: 'settled', outcome: 'ok', ipcMs: 2 }]
    ])
  })

  it('audits a History transition, including the from === to toggle-race no-op', () => {
    const audit = vi.fn()
    const tracer = createHistoryTracer({ audit })

    tracer.transition({ from: 'answer', to: 'history', committedAtMs: 1_700_000_000_000 })
    tracer.transition({ from: 'answer', to: 'answer', committedAtMs: 1_700_000_000_400 })

    expect(audit.mock.calls).toEqual([
      ['history.transition', { from: 'answer', to: 'history', committedAtMs: 1_700_000_000_000 }],
      ['history.transition', { from: 'answer', to: 'answer', committedAtMs: 1_700_000_000_400 }]
    ])
  })

  it('ignores a malformed transition report', () => {
    const audit = vi.fn()
    const tracer = createHistoryTracer({ audit })

    tracer.transition(undefined)
    tracer.transition({ from: 'nowhere', to: 'history', committedAtMs: 1 })
    tracer.transition({ from: 'answer', to: 'history', committedAtMs: -1 })
    tracer.transition({ from: 'answer', to: 'history' })

    expect(audit).not.toHaveBeenCalled()
  })
})
