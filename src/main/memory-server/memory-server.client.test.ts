import { describe, expect, it, vi } from 'vitest'
import type { MemoryScope } from '@shared/contracts/memory-partition'
import { createProductionMemoryServerAdapter } from './client'

const owner: MemoryScope = { tenantKey: 'a'.repeat(64), ownerKey: '1'.repeat(64) }

describe('production memory server client', () => {
  it('reports unavailable and makes no request until an owner configures an endpoint and identity', async () => {
    const fetcher = vi.fn()
    const adapter = createProductionMemoryServerAdapter({
      endpoint: null,
      verifiedScope: () => owner,
      bearerToken: async () => null,
      fetch: fetcher as unknown as typeof fetch
    })

    await expect(
      adapter.retain(owner, { sourceId: 'synthetic-source', origin: 'document', text: 'synthetic' })
    ).resolves.toEqual({
      status: 'unavailable'
    })
    await expect(adapter.recall(owner, 'synthetic')).resolves.toEqual({ status: 'unavailable' })
    await expect(
      adapter.correct(owner, 'synthetic-id', { expectedRevision: 1, text: 'synthetic correction' })
    ).resolves.toEqual({
      status: 'unavailable'
    })
    await expect(adapter.delete(owner, { sourceId: 'synthetic-source' })).resolves.toEqual({ status: 'unavailable' })
    await expect(adapter.listTombstones(owner)).resolves.toEqual({ status: 'unavailable' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('denies a renderer or stale request scope before network access', async () => {
    const fetcher = vi.fn()
    const adapter = createProductionMemoryServerAdapter({
      endpoint: null,
      verifiedScope: () => owner,
      bearerToken: async () => null,
      fetch: fetcher as unknown as typeof fetch
    })

    await expect(adapter.recall({ tenantKey: 'b'.repeat(64), ownerKey: owner.ownerKey }, 'synthetic')).resolves.toEqual(
      {
        status: 'denied'
      }
    )
    expect(fetcher).not.toHaveBeenCalled()
  })
})
