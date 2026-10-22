import { describe, expect, it, vi } from 'vitest'
import type { MemoryScope } from '@shared/contracts/memory-partition'
import { createMemoryPartitions, type MemoryIdentity } from './memory-partitions'
import type { LedgerIo } from './partition-ledger'

const key = (c: string): string => c.repeat(64)
const TENANT_1 = key('1')
const TENANT_2 = key('2')
const OWNER_A = key('a')
const OWNER_B = key('b')

const scopeOf = (tenantKey: string, ownerKey: string): MemoryScope => ({ tenantKey, ownerKey })
const verified = (tenantKey: string, ownerKey: string): MemoryIdentity => ({
  kind: 'verified',
  scope: scopeOf(tenantKey, ownerKey)
})

function memoryLedger(initial: string | null = null) {
  const state = { text: initial, writes: 0, failWrites: 0, gate: null as Promise<void> | null }
  const io: LedgerIo = {
    read: async () => state.text,
    write: async (text) => {
      if (state.gate) await state.gate
      if (state.failWrites > 0) {
        state.failWrites -= 1
        throw new Error('disk full')
      }
      state.text = text
      state.writes += 1
    }
  }
  return { io, state }
}

function setup(opts: { ledger?: string | null; hint?: string | null } = {}) {
  const ledger = memoryLedger(opts.ledger ?? null)
  const world = { identity: { kind: 'signed-out' } as MemoryIdentity }
  const changes: Array<{ from: string | null; to: string | null }> = []
  const partitions = createMemoryPartitions({
    source: { identity: () => world.identity },
    ledger: ledger.io,
    legacyOwnerHint: async () => opts.hint ?? null,
    now: () => 1_700_000_000_000
  })
  partitions.onChange((change) => changes.push(change))
  return { partitions, ledger, world, changes }
}

describe('memory partitions: recall status before anything is verified', () => {
  it('signed out refuses with the typed status and never touches the ledger', async () => {
    const t = setup()
    expect(t.partitions.access()).toEqual({ status: 'signed-out' })
    expect(await t.partitions.activate()).toEqual({ status: 'signed-out' })
    expect(t.ledger.state.writes).toBe(0)
  })

  it('a signed-in identity that cannot be verified is unavailable, not the last owner', async () => {
    const t = setup()
    t.world.identity = { kind: 'unverified' }
    expect(await t.partitions.activate()).toEqual({ status: 'unavailable' })
  })
})

describe('memory partitions: adoption of the single-owner data', () => {
  it('the first verified owner adopts the existing data in place and the adoption is recorded', async () => {
    const t = setup()
    t.world.identity = verified(TENANT_1, OWNER_A)
    const access = await t.partitions.activate()
    expect(access).toMatchObject({ status: 'ok', legacy: true, relRoot: '.brain' })
    expect(t.ledger.state.writes).toBe(1)
    const ledger = JSON.parse(t.ledger.state.text ?? '{}')
    expect(ledger.legacy).toEqual({
      state: 'adopted',
      tenantKey: TENANT_1,
      ownerKey: OWNER_A,
      adoptedAt: 1_700_000_000_000
    })
    expect(t.ledger.state.text).not.toMatch(/@/)
  })

  it('adoption happens once: a later owner never adopts, and the first owner keeps it across sign-ins', async () => {
    const t = setup()
    t.world.identity = verified(TENANT_1, OWNER_A)
    await t.partitions.activate()
    t.world.identity = { kind: 'signed-out' }
    expect(t.partitions.access()).toEqual({ status: 'signed-out' })
    t.world.identity = verified(TENANT_1, OWNER_B)
    const b = await t.partitions.activate()
    expect(b).toMatchObject({ status: 'ok', legacy: false })
    expect(b.status === 'ok' && b.relRoot).toMatch(/^\.brain-p-[0-9a-f]{24}$/)
    t.world.identity = verified(TENANT_1, OWNER_A)
    const again = await t.partitions.activate()
    expect(again).toMatchObject({ status: 'ok', legacy: true, relRoot: '.brain' })
    const ledger = JSON.parse(t.ledger.state.text ?? '{}')
    expect(ledger.legacy.ownerKey).toBe(OWNER_A)
    expect(ledger.legacy.adoptedAt).toBe(1_700_000_000_000)
    // One write adopted the data; switching owners and coming back never rewrote the claim.
    expect(t.ledger.state.writes).toBe(1)
  })

  it('the same user in another tenant is a different partition', async () => {
    const t = setup()
    t.world.identity = verified(TENANT_1, OWNER_A)
    const first = await t.partitions.activate()
    t.world.identity = verified(TENANT_2, OWNER_A)
    const second = await t.partitions.activate()
    expect(first).toMatchObject({ legacy: true })
    expect(second).toMatchObject({ status: 'ok', legacy: false })
    expect(second.status === 'ok' && first.status === 'ok' && second.partitionId !== first.partitionId).toBe(true)
  })

  it('owners get different roots, and a partition root is stable for the same owner', async () => {
    const t = setup()
    t.world.identity = verified(TENANT_1, OWNER_A)
    await t.partitions.activate()
    t.world.identity = verified(TENANT_1, OWNER_B)
    const b1 = await t.partitions.activate()
    t.world.identity = verified(TENANT_2, OWNER_B)
    const other = await t.partitions.activate()
    t.world.identity = verified(TENANT_1, OWNER_B)
    const b2 = await t.partitions.activate()
    expect(b1).toEqual(b2)
    expect(other.status === 'ok' && b1.status === 'ok' && other.relRoot !== b1.relRoot).toBe(true)
  })

  it('data left by an earlier build belongs to the owner that build remembered, not to whoever signs in first', async () => {
    const t = setup({ hint: OWNER_A })
    t.world.identity = verified(TENANT_1, OWNER_B)
    const b = await t.partitions.activate()
    expect(b).toMatchObject({ status: 'ok', legacy: false })
    expect(t.ledger.state.writes).toBe(0)
    t.world.identity = verified(TENANT_1, OWNER_A)
    expect(await t.partitions.activate()).toMatchObject({ status: 'ok', legacy: true })
    expect(JSON.parse(t.ledger.state.text ?? '{}').legacy.ownerKey).toBe(OWNER_A)
  })

  it('two sign-ins racing adopt exactly once, in order', async () => {
    const t = setup()
    let release!: () => void
    t.ledger.state.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    t.world.identity = verified(TENANT_1, OWNER_A)
    const first = t.partitions.activate()
    t.world.identity = verified(TENANT_1, OWNER_B)
    const second = t.partitions.activate()
    release()
    const [a, b] = await Promise.all([first, second])
    // The first sign-in is already gone when its activation finishes, so it is refused as stale; its claim stands.
    expect(a).toEqual({ status: 'stale' })
    expect(b).toMatchObject({ status: 'ok', legacy: false })
    expect(t.ledger.state.writes).toBe(1)
    expect(JSON.parse(t.ledger.state.text ?? '{}').legacy.ownerKey).toBe(OWNER_A)
  })

  it('a ledger that cannot be written leaves the memory closed and the claim unrecorded, then retries', async () => {
    const t = setup()
    t.ledger.state.failWrites = 1
    t.world.identity = verified(TENANT_1, OWNER_A)
    expect(await t.partitions.activate()).toEqual({ status: 'unavailable' })
    expect(t.partitions.access().status).not.toBe('ok')
    expect(await t.partitions.activate()).toMatchObject({ status: 'ok', legacy: true })
    expect(t.ledger.state.writes).toBe(1)
  })

  it('a ledger that cannot be read fails closed and is never overwritten', async () => {
    const t = setup({ ledger: '{ not json' })
    t.world.identity = verified(TENANT_1, OWNER_A)
    expect(await t.partitions.activate()).toEqual({ status: 'unavailable' })
    expect(t.ledger.state.text).toBe('{ not json')
    expect(t.ledger.state.writes).toBe(0)
  })

  it('an unconfigured installation (no sign-in exists) uses the unclaimed data and claims nothing', async () => {
    const t = setup()
    t.world.identity = { kind: 'local-unsigned' }
    expect(await t.partitions.activate()).toMatchObject({ status: 'ok', legacy: true })
    expect(t.ledger.state.writes).toBe(0)
  })

  it('once the data is adopted, an unsigned session no longer reads it', async () => {
    const t = setup()
    t.world.identity = verified(TENANT_1, OWNER_A)
    await t.partitions.activate()
    t.world.identity = { kind: 'local-unsigned' }
    expect(await t.partitions.activate()).toEqual({ status: 'signed-out' })
  })
})

describe('memory partitions: account switch', () => {
  it('reports stale until the new partition is active, then ok under the new owner', async () => {
    const t = setup()
    t.world.identity = verified(TENANT_1, OWNER_A)
    await t.partitions.activate()
    expect(t.partitions.access().status).toBe('ok')
    t.world.identity = verified(TENANT_2, OWNER_B)
    expect(t.partitions.access()).toEqual({ status: 'stale' })
    await t.partitions.activate()
    expect(t.partitions.access()).toMatchObject({ status: 'ok', legacy: false })
  })

  it('tells listeners when the partition in force changes, and not when it does not', async () => {
    const t = setup()
    t.world.identity = verified(TENANT_1, OWNER_A)
    await t.partitions.activate()
    await t.partitions.activate()
    t.world.identity = { kind: 'signed-out' }
    t.partitions.access()
    t.world.identity = verified(TENANT_1, OWNER_B)
    await t.partitions.activate()
    expect(t.changes).toHaveLength(3)
    expect(t.changes[0]).toEqual({ from: null, to: 'legacy' })
    expect(t.changes[1]).toEqual({ from: 'legacy', to: null })
    expect(t.changes[2].from).toBeNull()
    expect(t.changes[2].to).toMatch(/^[0-9a-f]{24}$/)
  })

  it('a listener that throws never blocks the switch', async () => {
    const t = setup()
    t.partitions.onChange(() => {
      throw new Error('boom')
    })
    t.world.identity = verified(TENANT_1, OWNER_A)
    expect(await t.partitions.activate()).toMatchObject({ status: 'ok' })
  })

  it('audits an adoption as an outcome token without any key', async () => {
    const audit = vi.fn()
    const ledger = memoryLedger()
    const world = { identity: verified(TENANT_1, OWNER_A) as MemoryIdentity }
    const partitions = createMemoryPartitions({
      source: { identity: () => world.identity },
      ledger: ledger.io,
      legacyOwnerHint: async () => null,
      audit
    })
    await partitions.activate()
    expect(audit).toHaveBeenCalledTimes(1)
    expect(audit).toHaveBeenCalledWith('memory.partition_adopted', {})
  })
})
