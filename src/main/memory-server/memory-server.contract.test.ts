import { describe, expect, it } from 'vitest'
import type { MemoryScope } from '@shared/contracts/memory-partition'
import { createMemoryServerMock } from './__fixtures__/memory-server-mock'

const scope = (tenant: string, owner: string): MemoryScope => ({
  tenantKey: tenant.repeat(64),
  ownerKey: owner.repeat(64)
})

const alice = scope('a', '1')
const anotherTenant = scope('b', '1')
const anotherUser = scope('a', '2')

describe('MemoryServerAdapter contract', () => {
  it('denies retrieval when either tenant or user differs from the verified caller', async () => {
    const server = createMemoryServerMock(() => alice)
    await server.adapter.retain(alice, {
      sourceId: 'synthetic-source-1',
      origin: 'document',
      text: 'synthetic retained fact'
    })

    await expect(server.adapter.recall(anotherTenant, 'synthetic')).resolves.toEqual({ status: 'denied' })
    await expect(server.adapter.recall(anotherUser, 'synthetic')).resolves.toEqual({ status: 'denied' })
  })

  it('retains, recalls and corrects a source only inside its verified scope', async () => {
    const server = createMemoryServerMock(() => alice)
    const retained = await server.adapter.retain(alice, {
      sourceId: 'synthetic-source-2',
      origin: 'connector',
      text: 'synthetic initial value'
    })
    expect(retained.status).toBe('found')
    if (retained.status !== 'found') return

    await expect(server.adapter.recall(alice, 'initial')).resolves.toMatchObject({ status: 'found' })
    await expect(
      server.adapter.correct(alice, retained.value.id, { expectedRevision: 1, text: 'synthetic corrected value' })
    ).resolves.toMatchObject({ status: 'found', value: { revision: 2, text: 'synthetic corrected value' } })
  })

  it('tombstones deletes, refuses re-retain and correction, and prevents a resync from resurrecting a source', async () => {
    const server = createMemoryServerMock(() => alice)
    const input = {
      sourceId: 'synthetic-source-3',
      origin: 'document' as const,
      text: 'synthetic value to remove'
    }
    const retained = await server.adapter.retain(alice, input)
    expect(retained.status).toBe('found')
    if (retained.status !== 'found') return

    await expect(server.adapter.delete(alice, { sourceId: input.sourceId })).resolves.toMatchObject({
      status: 'found',
      value: [{ sourceId: input.sourceId }]
    })
    await expect(server.adapter.listTombstones(alice, input.sourceId)).resolves.toMatchObject({ status: 'found' })
    await expect(server.adapter.recall(alice, 'synthetic value')).resolves.toEqual({ status: 'no-results' })
    await expect(server.adapter.retain(alice, input)).resolves.toEqual({ status: 'denied' })
    await expect(
      server.adapter.correct(alice, retained.value.id, { expectedRevision: 1, text: 'synthetic resurrection' })
    ).resolves.toEqual({ status: 'denied' })
    await expect(server.adapter.retain(alice, input)).resolves.toEqual({ status: 'denied' })
  })

  it('keeps tombstones partitioned by both tenant and user', async () => {
    const server = createMemoryServerMock(() => alice)
    await server.adapter.delete(alice, { sourceId: 'synthetic-source-4' })
    await expect(server.adapter.listTombstones(anotherTenant)).resolves.toEqual({ status: 'denied' })
    await expect(server.adapter.listTombstones(anotherUser)).resolves.toEqual({ status: 'denied' })
  })
})
