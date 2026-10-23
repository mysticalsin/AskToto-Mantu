import type { MemoryServerAdapter } from './contract'

/**
 * Client-side defense around the server contract. Server writes must persist tombstones atomically too, but this
 * guard refuses stale recall results and re-retain attempts if a provider returns an item after it was deleted.
 */
export function createTombstoneGuardedMemoryServerAdapter(server: MemoryServerAdapter): MemoryServerAdapter {
  return {
    async retain(scope, input) {
      const tombstones = await server.listTombstones(scope, input.sourceId)
      if (tombstones.status === 'denied' || tombstones.status === 'unavailable') return tombstones
      if (tombstones.status === 'found' && tombstones.value.some((tombstone) => tombstone.sourceId === input.sourceId))
        return { status: 'denied' }
      return server.retain(scope, input)
    },
    async recall(scope, query) {
      const [tombstones, recalled] = await Promise.all([server.listTombstones(scope), server.recall(scope, query)])
      if (tombstones.status === 'denied' || tombstones.status === 'unavailable') return tombstones
      if (recalled.status !== 'found') return recalled
      const deleted = new Set(
        tombstones.status === 'found' ? tombstones.value.map((tombstone) => tombstone.sourceId) : []
      )
      const live = recalled.value.filter((record) => !deleted.has(record.sourceId))
      return live.length ? { status: 'found', value: live } : { status: 'no-results' }
    },
    async correct(scope, memoryId, correction) {
      const corrected = await server.correct(scope, memoryId, correction)
      // A correction has a direct target, so absence and tombstone denial share one non-enumerating status.
      return corrected.status === 'no-results' ? { status: 'denied' } : corrected
    },
    delete: (scope, target) => server.delete(scope, target),
    listTombstones: (scope, sourceId) => server.listTombstones(scope, sourceId)
  }
}
