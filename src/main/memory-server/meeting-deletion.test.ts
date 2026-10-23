import { describe, expect, it, vi } from 'vitest'
import type { MemoryScope } from '@shared/contracts/memory-partition'
import type { MemoryServerAdapter } from './contract'
import { deleteMemoryForLocalMeeting, memorySourceIdForMeeting } from './meeting-deletion'

const owner: MemoryScope = { tenantKey: 'a'.repeat(64), ownerKey: '1'.repeat(64) }

describe('local meeting deletion propagation', () => {
  it('sends a path-free source tombstone through the scoped adapter', async () => {
    const adapter = { delete: vi.fn(async () => ({ status: 'found', value: [] })) } as unknown as MemoryServerAdapter

    await deleteMemoryForLocalMeeting('2026-10-23-private-topic.md', { adapter, scope: owner })

    expect(adapter.delete).toHaveBeenCalledWith(owner, {
      sourceId: memorySourceIdForMeeting('2026-10-23-private-topic.md')
    })
    expect(memorySourceIdForMeeting('2026-10-23-private-topic.md')).not.toContain('private-topic')
  })
})
