import type { MemoryScope } from '@shared/contracts/memory-partition'
import type { MemoryServerAdapter, MemoryServerRecord, MemoryServerResult, MemoryServerTombstone } from '../contract'

const sameScope = (left: MemoryScope, right: MemoryScope): boolean =>
  left.tenantKey === right.tenantKey && left.ownerKey === right.ownerKey

const scopeKey = (scope: MemoryScope): string => `${scope.tenantKey}:${scope.ownerKey}`

/** Deterministic in-memory server double. Kept under test fixtures; production never imports this module. */
export function createMemoryServerMock(currentScope: () => MemoryScope | null) {
  const records = new Map<string, { scopeKey: string; record: MemoryServerRecord }>()
  const tombstones = new Map<string, { scopeKey: string; tombstone: MemoryServerTombstone }>()
  let nextId = 1

  const authorized = (requestScope: MemoryScope): boolean => {
    const verified = currentScope()
    return verified !== null && sameScope(verified, requestScope)
  }

  const adapter: MemoryServerAdapter = {
    async retain(requestScope, input): Promise<MemoryServerResult<MemoryServerRecord>> {
      if (!authorized(requestScope)) return { status: 'denied' }
      const owner = scopeKey(requestScope)
      if (
        [...tombstones.values()].some(
          (entry) => entry.scopeKey === owner && entry.tombstone.sourceId === input.sourceId
        )
      )
        return { status: 'denied' }
      const record = { id: `synthetic-memory-${nextId++}`, ...input, revision: 1 }
      records.set(record.id, { scopeKey: owner, record })
      return { status: 'found', value: record }
    },
    async recall(requestScope, query): Promise<MemoryServerResult<MemoryServerRecord[]>> {
      if (!authorized(requestScope)) return { status: 'denied' }
      const owner = scopeKey(requestScope)
      const needle = query.trim().toLocaleLowerCase()
      const found = [...records.values()]
        .filter(
          ({ scopeKey: recordScope, record }) =>
            recordScope === owner &&
            ![...tombstones.values()].some(
              (entry) => entry.scopeKey === owner && entry.tombstone.sourceId === record.sourceId
            ) &&
            (needle === '' || record.text.toLocaleLowerCase().includes(needle))
        )
        .map(({ record }) => record)
      return found.length ? { status: 'found', value: found } : { status: 'no-results' }
    },
    async correct(requestScope, memoryId, correction): Promise<MemoryServerResult<MemoryServerRecord>> {
      if (!authorized(requestScope)) return { status: 'denied' }
      const owner = scopeKey(requestScope)
      const held = records.get(memoryId)
      if (!held || held.scopeKey !== owner) return { status: 'denied' }
      if (
        [...tombstones.values()].some(
          (entry) => entry.scopeKey === owner && entry.tombstone.sourceId === held.record.sourceId
        )
      )
        return { status: 'denied' }
      if (held.record.revision !== correction.expectedRevision) return { status: 'denied' }
      const record = { ...held.record, text: correction.text, revision: held.record.revision + 1 }
      records.set(memoryId, { scopeKey: owner, record })
      return { status: 'found', value: record }
    },
    async delete(requestScope, target): Promise<MemoryServerResult<MemoryServerTombstone[]>> {
      if (!authorized(requestScope)) return { status: 'denied' }
      const owner = scopeKey(requestScope)
      const matched = [...records.entries()].filter(
        ([id, entry]) =>
          entry.scopeKey === owner &&
          ((target.memoryId !== undefined && id === target.memoryId) ||
            (target.sourceId !== undefined && entry.record.sourceId === target.sourceId))
      )
      const sourceIds = new Set([
        ...(target.sourceId ? [target.sourceId] : []),
        ...matched.map(([, entry]) => entry.record.sourceId)
      ])
      if (sourceIds.size === 0) return { status: 'no-results' }
      const created: MemoryServerTombstone[] = []
      for (const sourceId of sourceIds) {
        const key = `${owner}:${sourceId}`
        let tombstone = tombstones.get(key)?.tombstone
        if (!tombstone) {
          tombstone = { id: `synthetic-tombstone-${nextId++}`, sourceId, deletedAt: 1 }
          tombstones.set(key, { scopeKey: owner, tombstone })
        }
        created.push(tombstone)
      }
      for (const [id] of matched) records.delete(id)
      return { status: 'found', value: created }
    },
    async listTombstones(requestScope, sourceId): Promise<MemoryServerResult<MemoryServerTombstone[]>> {
      if (!authorized(requestScope)) return { status: 'denied' }
      const owner = scopeKey(requestScope)
      const found = [...tombstones.values()]
        .filter(
          (entry) => entry.scopeKey === owner && (sourceId === undefined || entry.tombstone.sourceId === sourceId)
        )
        .map(({ tombstone }) => tombstone)
      return found.length ? { status: 'found', value: found } : { status: 'no-results' }
    }
  }

  return {
    adapter,
    recordCount: () => records.size,
    tombstoneCount: () => tombstones.size
  }
}
