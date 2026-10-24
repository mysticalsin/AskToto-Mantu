import { describe, expect, it } from 'vitest'
import { KEY_A, KEY_B, TENANT_1, memoryIo, open, scopeOf, seal } from './__fixtures__/conversation-harness'
import { createWorkspaceStore } from './workspace-store'

const make = (io = memoryIo(), scope = scopeOf(KEY_A, TENANT_1)) => ({
  io,
  store: createWorkspaceStore({ io, seal, open, scope: () => scope })
})

describe('workspace store (G50)', () => {
  it('serves an empty doc per partition', async () => {
    const { store } = make()
    const tx = await store.transact((doc) => ({ commit: false, value: doc }), scopeOf(KEY_A, TENANT_1))
    expect(tx).toMatchObject({ ok: true, value: { v: 1, owners: [], reads: [], archived: [], pins: [] } })
  })

  it('round-trips a sealed doc that is not plaintext', async () => {
    const { io, store } = make()
    const scope = scopeOf(KEY_A, TENANT_1)
    await store.transact(
      (doc) => ({
        commit: true,
        doc: { ...doc, owners: [{ ownerKey: KEY_A, tenantKey: TENANT_1, baselinedAt: 5, selected: null, rev: 3 }] },
        value: null
      }),
      scope
    )
    const raw = [...io.files.values()][0]!.toString('utf8')
    expect(raw).not.toContain('baselinedAt')
    const again = await make(io).store.transact((doc) => ({ commit: false, value: doc.owners }), scope)
    expect(again).toMatchObject({ ok: true, value: [{ rev: 3 }] })
  })

  it('refuses a doc written under another owner scope and never overwrites it', async () => {
    const { io, store } = make()
    await store.transact((doc) => ({ commit: true, doc, value: null }), scopeOf(KEY_A, TENANT_1))
    const key = [...io.files.keys()][0]!
    const foreign = make(io, { ...scopeOf(KEY_A, TENANT_1), ownerKey: KEY_B })
    const before = io.files.get(key)
    const tx = await foreign.store.transact((doc) => ({ commit: true, doc, value: null }))
    expect(tx).toEqual({ ok: false, reason: 'unavailable' })
    expect(io.files.get(key)).toBe(before)
  })
})
