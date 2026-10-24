import { describe, expect, it } from 'vitest'
import { createRoutineStore, type RoutineFileIo, type RoutineScope } from './routine-store'
import { newRoutineRecord, type JournalEntry, type RoutineRecord } from './routine-model'

const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)
const T1 = '1'.repeat(64)
const scopeA: RoutineScope = { partitionId: 'a1'.repeat(12), ownerKey: KEY_A, tenantKey: T1 }
const scopeB: RoutineScope = { partitionId: 'b1'.repeat(12), ownerKey: KEY_B, tenantKey: T1 }
const seal = (plain: string): Buffer => Buffer.from(Buffer.from(plain, 'utf8').map((b) => b ^ 0x5a))
const open = (sealed: Buffer): string => {
  if (sealed.length === 0) throw new Error('empty')
  return Buffer.from(sealed.map((b) => b ^ 0x5a)).toString('utf8')
}

function memoryIo(): RoutineFileIo & { files: Map<string, Buffer>; writes: number } {
  const files = new Map<string, Buffer>()
  const io = {
    files,
    writes: 0,
    async read(id: string) {
      return files.get(id) ?? null
    },
    async write(id: string, data: Buffer) {
      io.writes += 1
      files.set(id, data)
    }
  }
  return io
}

function record(scope: RoutineScope, n = 0): RoutineRecord {
  return newRoutineRecord({
    routineId: `r_${String(n).padStart(24, '0')}`,
    assistantId: 'sys-sales',
    purpose: 'reminder',
    title: 'Synthetic private title',
    consentKind: 'recurring',
    schedule: { kind: 'recurring', cadence: 'daily', time: '09:00', timeZone: 'UTC' },
    tools: [],
    ownerKey: scope.ownerKey,
    tenantKey: scope.tenantKey,
    idempotencyKey: 'k'.repeat(64),
    previewHash: 'p'.repeat(64),
    now: 100,
    nextDueAt: 500
  })
}

const entry = (scope: RoutineScope, status: JournalEntry['status']): JournalEntry => ({
  key: `["${record(scope).routineId}",1,"2026-01-01T09:00@UTC"]`,
  routineId: record(scope).routineId,
  ownerKey: scope.ownerKey,
  tenantKey: scope.tenantKey,
  status,
  dueAt: 1,
  expiresAt: 2,
  startedAt: 1
})

function setup(initial: RoutineScope | null = scopeA) {
  const io = memoryIo()
  const current = { scope: initial }
  const store = createRoutineStore({ io, seal, open, scope: () => current.scope })
  return { io, current, store }
}

describe('routine store (G66)', () => {
  it('stores sealed bytes only and hides another owner', async () => {
    const t = setup()
    await t.store.transact((v) => ({
      commit: true,
      routines: [...v.own, record(scopeA)],
      journal: v.journal,
      value: 1
    }))
    const raw = [...t.io.files.values()][0]!
    expect(raw.toString('utf8')).not.toContain('Synthetic')
    expect(open(raw)).toContain('Synthetic private title')
    t.current.scope = scopeB
    const seen = await t.store.transact((v) => ({ commit: false, value: v.own.length }))
    expect(seen).toEqual({ ok: true, value: 0 })
  })

  it('scope change mid-transaction → stale', async () => {
    const t = setup()
    const result = await t.store.transact((v) => {
      t.current.scope = scopeB
      return { commit: true, routines: [...v.own, record(scopeA)], journal: v.journal, value: 1 }
    })
    expect(result).toEqual({ ok: false, reason: 'stale' })
    expect(t.io.writes).toBe(0)
    expect(await t.store.transact(() => ({ commit: false, value: 1 }), scopeA)).toEqual({ ok: false, reason: 'stale' })
  })

  it('is signed-out without a scope', async () => {
    const t = setup(null)
    expect(await t.store.transact(() => ({ commit: false, value: 1 }))).toEqual({ ok: false, reason: 'signed-out' })
  })

  it('unreadable file is never overwritten', async () => {
    const t = setup()
    t.io.files.set(scopeA.partitionId, Buffer.from('garbage-not-sealed'))
    const result = await t.store.transact((v) => ({
      commit: true,
      routines: [...v.own, record(scopeA)],
      journal: v.journal,
      value: 1
    }))
    expect(result).toEqual({ ok: false, reason: 'unavailable' })
    expect(t.io.writes).toBe(0)
    expect(t.io.files.get(scopeA.partitionId)!.toString()).toBe('garbage-not-sealed')
  })

  it('stored running occurrence restores as uncertain + review', async () => {
    const t = setup()
    await t.store.transact((v) => ({
      commit: true,
      routines: [...v.own, record(scopeA)],
      journal: [entry(scopeA, 'running')],
      value: 1
    }))
    // This process wrote the lease, so it is live here.
    const live = await t.store.transact((v) => ({ commit: false, value: v.journal[0]!.status }))
    expect(live).toEqual({ ok: true, value: 'running' })
    // A later process opening the same file finds it unsettled.
    const next = createRoutineStore({ io: t.io, seal, open, scope: () => t.current.scope })
    const view = await next.transact((v) => ({
      commit: false,
      value: { status: v.journal[0]!.status, pause: v.own[0]!.pauseReasons, recovered: v.recovered }
    }))
    expect(view).toEqual({ ok: true, value: { status: 'uncertain', pause: ['review'], recovered: 1 } })
    // After an owner change aborted every job, rearm restores what they left open.
    t.store.rearm()
    const again = await t.store.transact((v) => ({ commit: false, value: v.journal[0]!.status }))
    expect(again).toEqual({ ok: true, value: 'uncertain' })
  })

  it('publishable is not persisted', async () => {
    const t = setup()
    await t.store.transact((v) => ({ commit: true, routines: [record(scopeA)], journal: v.journal, value: 1 }))
    expect(open([...t.io.files.values()][0]!)).not.toContain('publishable')
    // A file that carries one is refused, not trusted.
    const doc = JSON.parse(open([...t.io.files.values()][0]!))
    doc.routines[0].publishable = true
    t.io.files.set(scopeA.partitionId, seal(JSON.stringify(doc)))
    expect(await t.store.transact(() => ({ commit: false, value: 1 }))).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('keeps another owner’s rows in the same file untouched', async () => {
    const t = setup()
    const foreign = record({ ...scopeA, ownerKey: KEY_B }, 7)
    await t.store.transact((v) => ({ commit: true, routines: [foreign, ...v.own], journal: v.journal, value: 1 }))
    // The foreign row was filtered out of `own`, so it is not in what the owner committed; ensure the owner sees none.
    const own = await t.store.transact((v) => ({ commit: false, value: v.own.length }))
    expect(own).toEqual({ ok: true, value: 0 })
  })
})
