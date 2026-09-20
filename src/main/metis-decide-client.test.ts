import { describe, expect, it, vi } from 'vitest'
import { decideActionDisambiguate } from './metis-decide-client'

describe('Cap2 decide disambiguate client', () => {
  it('times out without blocking forever', async () => {
    const fetchImpl = vi.fn(
      () =>
        new Promise(() => {
          /* hang */
        })
    ) as unknown as typeof fetch
    const r = await decideActionDisambiguate({
      operatorBaseUrl: 'https://metis-operator.tony-walteur.workers.dev',
      authorizationHeader: 'Bearer test',
      transcript: 'open the thing',
      candidates: ['desktop.open_notes', 'desktop.open_arc'],
      deadlineMs: 50,
      fetchImpl
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.timedOut).toBe(true)
  })

  it('rejects adapter ids outside candidates', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        result: { adapterId: 'desktop.open_x' },
        confidence: 0.9
      })
    })) as unknown as typeof fetch
    const r = await decideActionDisambiguate({
      operatorBaseUrl: 'https://metis-operator.tony-walteur.workers.dev',
      authorizationHeader: 'Bearer test',
      transcript: 'open it',
      candidates: ['desktop.open_notes'],
      fetchImpl
    })
    expect(r.ok).toBe(false)
  })
})


import { decideIntelClassify, isJevIntelLabel } from './metis-decide-client'

describe('Cap3 decide intel classify client', () => {
  it('accepts only locked Jev labels', () => {
    expect(isJevIntelLabel('on track')).toBe(true)
    expect(isJevIntelLabel('needs attention')).toBe(true)
    expect(isJevIntelLabel('blocked')).toBe(true)
    expect(isJevIntelLabel('stale')).toBe(true)
    expect(isJevIntelLabel('insufficient')).toBe(true)
    expect(isJevIntelLabel('healthy')).toBe(false)
  })

  it('marks assistUnavailable on outage (never invents scores)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('down')
    }) as unknown as typeof fetch
    const r = await decideIntelClassify({
      operatorBaseUrl: 'https://metis-operator.tony-walteur.workers.dev',
      authorizationHeader: 'Bearer test',
      evidence: { openDeals: 3 },
      fetchImpl
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.assistUnavailable).toBe(true)
  })

  it('rejects unknown classification labels', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: { label: 'crushing it' }, confidence: 0.99 })
    })) as unknown as typeof fetch
    const r = await decideIntelClassify({
      operatorBaseUrl: 'https://metis-operator.tony-walteur.workers.dev',
      authorizationHeader: 'Bearer test',
      evidence: { openDeals: 1 },
      fetchImpl
    })
    expect(r.ok).toBe(false)
  })
})
