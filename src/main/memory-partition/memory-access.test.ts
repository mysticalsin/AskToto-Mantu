import { afterEach, describe, expect, it } from 'vitest'
import {
  assertMemoryOpen,
  CLOSED_REL_ROOT,
  configureMemoryPartitions,
  followUpMemoryContinues,
  memoryAccess,
  memoryRelRoot,
  reconcileMemoryAccess,
  resetMemoryAccessForTests,
  resolveMemoryAccess,
  verifiedMemoryScope
} from './memory-access'
import { createMemoryPartitions, type MemoryIdentity } from './memory-partitions'

const key = (c: string): string => c.repeat(64)
const verified = (owner: string): MemoryIdentity => ({
  kind: 'verified',
  scope: { tenantKey: key('1'), ownerKey: key(owner) }
})

function configured(initial: MemoryIdentity) {
  const world = { identity: initial }
  let text: string | null = null
  const partitions = createMemoryPartitions({
    source: { identity: () => world.identity },
    ledger: {
      read: async () => text,
      write: async (next) => {
        text = next
      }
    }
  })
  configureMemoryPartitions(partitions)
  return { world, partitions }
}

afterEach(() => resetMemoryAccessForTests())

describe('memory access', () => {
  it('is the single-owner store until main configures it', () => {
    expect(memoryAccess()).toMatchObject({ status: 'ok', legacy: true, relRoot: '.brain' })
    expect(memoryRelRoot()).toBe('.brain')
    expect(() => assertMemoryOpen()).not.toThrow()
  })

  it('names a root that is never created while no partition is open, and refuses writes with the typed status', () => {
    configured({ kind: 'signed-out' })
    expect(memoryRelRoot()).toBe(CLOSED_REL_ROOT)
    expect(() => assertMemoryOpen()).toThrowError(
      expect.objectContaining({ name: 'MemoryClosedError', status: 'signed-out' })
    )
  })

  it('resolveMemoryAccess waits for a pending activation instead of answering stale', async () => {
    configured(verified('a'))
    expect(memoryAccess()).toEqual({ status: 'stale' })
    expect(verifiedMemoryScope()).toBeNull()
    expect(await resolveMemoryAccess()).toMatchObject({ status: 'ok', legacy: true })
    expect(verifiedMemoryScope()).toEqual({ tenantKey: key('1'), ownerKey: key('a') })
    expect(memoryRelRoot()).toBe('.brain')
  })

  it('only exposes the main-derived pair belonging to the active partition', async () => {
    const t = configured(verified('a'))
    await t.partitions.activate()
    expect(verifiedMemoryScope()).toEqual({ tenantKey: key('1'), ownerKey: key('a') })

    t.world.identity = verified('b')
    expect(verifiedMemoryScope()).toBeNull()
    await t.partitions.activate()
    expect(verifiedMemoryScope()).toEqual({ tenantKey: key('1'), ownerKey: key('b') })
  })

  it('an activation that failed is tried again by the next awaited read', async () => {
    let failWrites = 1
    let text: string | null = null
    configureMemoryPartitions(
      createMemoryPartitions({
        source: { identity: () => verified('a') },
        ledger: {
          read: async () => text,
          write: async (next) => {
            if (failWrites-- > 0) throw new Error('disk full')
            text = next
          }
        }
      })
    )
    expect(await resolveMemoryAccess()).toEqual({ status: 'unavailable' })
    expect(memoryAccess()).toEqual({ status: 'unavailable' })
    expect(await resolveMemoryAccess()).toMatchObject({ status: 'ok', legacy: true })
  })

  it('reconcileMemoryAccess ends the partition at sign-out without waiting for a read', async () => {
    const t = configured(verified('a'))
    await t.partitions.activate()
    const changes: unknown[] = []
    t.partitions.onChange((change) => changes.push(change))
    t.world.identity = { kind: 'signed-out' }
    reconcileMemoryAccess()
    expect(changes).toEqual([{ from: 'legacy', to: null }])
  })
})

describe('follow-up memory fence', () => {
  it('continues for the same partition and restarts clean once the owner changes', async () => {
    const t = configured(verified('a'))
    await t.partitions.activate()
    expect(followUpMemoryContinues()).toBe(true) // first plain ask: nothing earlier to carry
    expect(followUpMemoryContinues()).toBe(true)
    t.world.identity = verified('b')
    await t.partitions.activate()
    expect(followUpMemoryContinues()).toBe(false) // the previous owner's conversation is dropped
    expect(followUpMemoryContinues()).toBe(true) // and the new owner's continues
    t.world.identity = verified('a')
    await t.partitions.activate()
    expect(followUpMemoryContinues()).toBe(false)
  })

  it('never carries a conversation while no partition is open', () => {
    configured({ kind: 'signed-out' })
    expect(followUpMemoryContinues()).toBe(false)
  })
})
