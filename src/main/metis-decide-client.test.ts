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
