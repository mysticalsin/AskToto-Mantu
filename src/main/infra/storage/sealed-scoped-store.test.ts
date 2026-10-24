import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createSealedScopedStore, type SealedScope } from './sealed-scoped-store'

const A: SealedScope = { partitionId: 'a'.repeat(24), ownerKey: 'a'.repeat(64), tenantKey: '1'.repeat(64) }
const B: SealedScope = { partitionId: 'b'.repeat(24), ownerKey: 'b'.repeat(64), tenantKey: '2'.repeat(64) }

const Schema = z
  .object({
    v: z.literal(1),
    partitionId: z.string(),
    ownerKey: z.string(),
    tenantKey: z.string(),
    n: z.number()
  })
  .strict()
type Doc = z.infer<typeof Schema>

const seal = (plain: string): Buffer => Buffer.from(Buffer.from(plain, 'utf8').map((byte) => byte ^ 0x5a))
const open = (sealed: Buffer): string => Buffer.from(sealed.map((byte) => byte ^ 0x5a)).toString('utf8')

function rig(initial: SealedScope | null = A) {
  const files = new Map<string, Buffer>()
  const state = {
    scope: initial,
    onRead: undefined as (() => void) | undefined,
    onWrite: undefined as (() => void) | undefined
  }
  const store = createSealedScopedStore<Doc>({
    schema: Schema,
    empty: (scope) => ({ v: 1, ...scope, n: 0 }),
    io: {
      async read(partitionId, name) {
        const bytes = files.get(`${partitionId}/${name ?? ''}`) ?? null
        state.onRead?.()
        return bytes
      },
      async write(partitionId, data, name) {
        state.onWrite?.()
        files.set(`${partitionId}/${name ?? ''}`, data)
      }
    },
    seal,
    open,
    scope: () => state.scope
  })
  const bump = () => store.transact((doc) => ({ commit: true, doc: { ...doc, n: doc.n + 1 }, value: doc.n + 1 }))
  return { files, state, store, bump }
}

describe('sealed scoped store core (G49, extracted from G48)', () => {
  it('serialises transactions so concurrent increments never lose an update', async () => {
    const r = rig()
    const results = await Promise.all([r.bump(), r.bump(), r.bump()])
    expect(results.map((x) => (x.ok ? x.value : -1))).toEqual([1, 2, 3])
  })

  it('answers signed-out without a scope', async () => {
    expect(await rig(null).bump()).toEqual({ ok: false, reason: 'signed-out' })
  })

  it('refuses stale when the scope changes before the read, after the read and after the write', async () => {
    const before = rig()
    expect(await before.store.transact((d) => ({ commit: false, value: d.n }), B)).toEqual({
      ok: false,
      reason: 'stale'
    })

    const afterRead = rig()
    afterRead.state.onRead = () => (afterRead.state.scope = B)
    expect(await afterRead.bump()).toEqual({ ok: false, reason: 'stale' })
    expect(afterRead.files.size).toBe(0)

    const afterWrite = rig()
    afterWrite.state.onWrite = () => (afterWrite.state.scope = B)
    expect(await afterWrite.bump()).toEqual({ ok: false, reason: 'stale' })
    // The write stayed bound to the captured partition.
    expect([...afterWrite.files.keys()]).toEqual([`${A.partitionId}/`])
  })

  it('never overwrites a file it cannot open, and keeps named documents apart', async () => {
    const r = rig()
    r.files.set(`${A.partitionId}/`, Buffer.from('not sealed json'))
    expect(await r.bump()).toEqual({ ok: false, reason: 'unavailable' })
    expect(r.files.get(`${A.partitionId}/`)!.toString()).toBe('not sealed json')
    const named = await r.store.transact((d) => ({ commit: true, doc: { ...d, n: 7 }, value: 7 }), undefined, 'x')
    expect(named).toEqual({ ok: true, value: 7 })
    expect(r.files.has(`${A.partitionId}/x`)).toBe(true)
  })

  it('rejects a document whose owner, tenant or partition differs from the scope', async () => {
    const r = rig()
    for (const forged of [
      { ...A, ownerKey: 'c'.repeat(64) },
      { ...A, tenantKey: 'c'.repeat(64) },
      { ...A, partitionId: 'c'.repeat(24) }
    ]) {
      r.files.set(`${A.partitionId}/`, seal(JSON.stringify({ v: 1, ...forged, n: 5 })))
      expect(await r.bump()).toEqual({ ok: false, reason: 'unavailable' })
    }
  })

  it('reports a throwing callback as unavailable without writing', async () => {
    const r = rig()
    expect(
      await r.store.transact(() => {
        throw new Error('boom')
      })
    ).toEqual({ ok: false, reason: 'unavailable' })
  })
})
