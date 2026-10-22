import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootMemoryPartitions, memoryIdentitySource, UNVERIFIED_IDENTITY_TTL_MS } from './boot'
import { memoryAccess, resetMemoryAccessForTests } from './memory-access'
import type { LedgerIo } from './partition-ledger'

const key = (c: string): string => c.repeat(64)

function world() {
  const state = {
    generation: 1,
    signedIn: false,
    unsigned: false,
    owner: null as string | null,
    tenant: null as string | null,
    now: 0
  }
  const ownerSession = {
    currentOwnerKey: vi.fn(() => state.owner),
    currentTenantKey: vi.fn(() => state.tenant)
  }
  const deps = {
    ownerSession,
    authGeneration: () => state.generation,
    signedIn: vi.fn(() => state.signedIn),
    unsignedAllowed: () => state.unsigned,
    now: () => state.now
  }
  return { state, ownerSession, deps }
}

describe('memoryIdentitySource', () => {
  it('reports each way nobody is verified', () => {
    const w = world()
    const identity = memoryIdentitySource(w.deps)
    expect(identity()).toEqual({ kind: 'signed-out' })
    w.state.now += UNVERIFIED_IDENTITY_TTL_MS
    w.state.unsigned = true
    expect(identity()).toEqual({ kind: 'local-unsigned' })
    w.state.now += UNVERIFIED_IDENTITY_TTL_MS
    w.state.unsigned = false
    w.state.signedIn = true // signed in, but the per-install salt has not loaded
    expect(identity()).toEqual({ kind: 'unverified' })
  })

  it('does not cache an unverified identity, so the salt loading is noticed on the next read', () => {
    const w = world()
    w.state.signedIn = true
    const identity = memoryIdentitySource(w.deps)
    expect(identity()).toEqual({ kind: 'unverified' })
    w.state.owner = key('a')
    w.state.tenant = key('1')
    expect(identity()).toEqual({ kind: 'verified', scope: { tenantKey: key('1'), ownerKey: key('a') } })
  })

  it('a tenant that is not known is unverified, never the owner alone', () => {
    const w = world()
    w.state.signedIn = true
    w.state.owner = key('a')
    expect(memoryIdentitySource(w.deps)()).toEqual({ kind: 'unverified' })
  })

  it('derives a verified identity once per sign-in generation and follows a new session at once', () => {
    const w = world()
    w.state.signedIn = true
    w.state.owner = key('a')
    w.state.tenant = key('1')
    const identity = memoryIdentitySource(w.deps)
    for (let i = 0; i < 50; i += 1) identity()
    expect(w.ownerSession.currentOwnerKey).toHaveBeenCalledTimes(1)
    expect(w.deps.signedIn).toHaveBeenCalledTimes(1)
    w.state.generation += 1
    w.state.owner = key('b')
    expect(identity()).toEqual({ kind: 'verified', scope: { tenantKey: key('1'), ownerKey: key('b') } })
  })

  it('re-reads a signed-out answer after a second, and at once when a session starts', () => {
    const w = world()
    const identity = memoryIdentitySource(w.deps)
    expect(identity()).toEqual({ kind: 'signed-out' })
    identity()
    expect(w.deps.signedIn).toHaveBeenCalledTimes(1)
    w.state.signedIn = true
    w.state.owner = key('a')
    w.state.tenant = key('1')
    w.state.generation += 1
    expect(identity().kind).toBe('verified')
  })
})

describe('bootMemoryPartitions', () => {
  afterEach(() => resetMemoryAccessForTests())

  it('makes the partitions the process-wide memory authority and reports each partition change', async () => {
    const w = world()
    let text: string | null = null
    const ledger: LedgerIo = {
      read: async () => text,
      write: async (next) => {
        text = next
      }
    }
    const changes: unknown[] = []
    const audit = vi.fn()
    w.state.signedIn = true
    w.state.owner = key('a')
    w.state.tenant = key('1')
    const partitions = bootMemoryPartitions({
      ...w.deps,
      ledger,
      legacyOwnerHint: async () => null,
      audit,
      onPartitionChange: (change) => changes.push(change)
    })
    expect(memoryAccess()).toEqual({ status: 'stale' }) // configured: no longer the unconfigured legacy default
    await partitions.activate()
    expect(memoryAccess()).toMatchObject({ status: 'ok', legacy: true })
    expect(audit).toHaveBeenCalledWith('memory.partition_adopted', {})

    w.state.generation += 1
    w.state.owner = key('b')
    await partitions.activate()
    expect(memoryAccess()).toMatchObject({ status: 'ok', legacy: false })
    expect(changes).toEqual([
      { from: null, to: 'legacy' },
      { from: 'legacy', to: expect.stringMatching(/^[0-9a-f]{24}$/) }
    ])
  })
})
