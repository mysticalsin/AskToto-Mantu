import { describe, expect, it } from 'vitest'
import { emptyOwnerData } from './model'
import { createSuggestionStore } from './store'
import { KEY_A, KEY_B, TENANT_1, TENANT_2, memoryIo, open, scopeOf, seal } from './__fixtures__/suggestions-harness'

const feedbackFor = (fingerprint: string) => ({
  fingerprint,
  evidenceDigest: 'd'.repeat(64),
  verdict: 'dismissed' as const,
  at: 1
})

function setup() {
  const io = memoryIo()
  const current = { scope: scopeOf(KEY_A, TENANT_1) as ReturnType<typeof scopeOf> | null }
  const store = createSuggestionStore({ io, seal, open, scope: () => current.scope })
  return { io, current, store }
}

describe('suggestion store (G67)', () => {
  it('is scoped to partition + owner + tenant and seals what it writes', async () => {
    const { io, current, store } = setup()
    const wrote = await store.transact((view) => ({
      commit: true,
      own: { ...view.own, feedback: [feedbackFor('f'.repeat(64))] },
      value: 1
    }))
    expect(wrote).toEqual({ ok: true, value: 1 })
    const [bytes] = [...io.files.values()]
    expect(bytes!.toString('utf8')).not.toContain('feedback')
    const other = (current.scope = scopeOf(KEY_B, TENANT_2))
    expect(other.partitionId).not.toBe(scopeOf(KEY_A, TENANT_1).partitionId)
    const seen = await store.transact((view) => ({ commit: false, value: view.own.feedback.length }))
    expect(seen).toEqual({ ok: true, value: 0 })
  })

  it('keeps foreign records in the same file but never shows them', async () => {
    const { io, current, store } = setup()
    await store.transact((view) => ({
      commit: true,
      own: { ...view.own, feedback: [feedbackFor('1'.repeat(64))] },
      value: 0
    }))
    // A different owner sharing the partition file (the same partition id by construction of this fixture).
    current.scope = { ...scopeOf(KEY_A, TENANT_1), ownerKey: KEY_B }
    const b = await store.transact((view) => ({
      commit: true,
      own: { ...view.own, feedback: [feedbackFor('2'.repeat(64))] },
      value: view.own.feedback.length
    }))
    expect(b).toEqual({ ok: true, value: 0 })
    expect(io.writes).toBe(2)
    current.scope = scopeOf(KEY_A, TENANT_1)
    const a = await store.transact((view) => ({ commit: false, value: view.own.feedback.map((f) => f.fingerprint) }))
    expect(a).toEqual({ ok: true, value: ['1'.repeat(64)] })
  })

  it('never overwrites a file it cannot open', async () => {
    const { io, store } = setup()
    const garbage = Buffer.from('not a sealed document')
    io.files.set(scopeOf(KEY_A, TENANT_1).partitionId, garbage)
    const result = await store.transact((view) => ({ commit: true, own: view.own, value: 0 }))
    expect(result).toEqual({ ok: false, reason: 'unavailable' })
    expect(io.writes).toBe(0)
    expect(io.files.get(scopeOf(KEY_A, TENANT_1).partitionId)).toBe(garbage)
  })

  it('answers signed-out without a scope, and stale when the expected scope is not the one in force', async () => {
    const { current, store } = setup()
    const expected = scopeOf(KEY_A, TENANT_1)
    current.scope = scopeOf(KEY_B, TENANT_1)
    expect(await store.transact(() => ({ commit: false, value: 0 }), expected)).toEqual({ ok: false, reason: 'stale' })
    current.scope = null
    expect(await store.transact(() => ({ commit: false, value: 0 }))).toEqual({ ok: false, reason: 'signed-out' })
  })

  it('withholds the result when the scope changes while the write is in flight', async () => {
    const { io, current, store } = setup()
    io.onWrite = () => {
      current.scope = scopeOf(KEY_B, TENANT_2)
    }
    const result = await store.transact((view) => ({ commit: true, own: view.own, value: 7 }))
    expect(result).toEqual({ ok: false, reason: 'stale' })
  })

  it('runs transactions one at a time', async () => {
    const { store } = setup()
    const order: number[] = []
    await Promise.all(
      [1, 2, 3].map((n) =>
        store.transact((view) => {
          order.push(n)
          return {
            commit: true,
            own: { ...view.own, feedback: [...view.own.feedback, feedbackFor(String(n).repeat(64))] },
            value: n
          }
        })
      )
    )
    const all = await store.transact((view) => ({ commit: false, value: view.own.feedback.length }))
    expect(order).toEqual([1, 2, 3])
    expect(all).toEqual({ ok: true, value: 3 })
    expect(emptyOwnerData().feedback).toEqual([])
  })
})
