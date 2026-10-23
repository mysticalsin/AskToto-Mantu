import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore, type ObservedContent } from './snapshot-store'
import { memoryIo, testOpen, testSeal, type Env } from './__fixtures__/context-grants-fixtures'

const observed = (over: Partial<ObservedContent> = {}): ObservedContent => ({
  sourceId: 'display:1',
  observationId: 'obs-1',
  generation: 0,
  capturedAt: 1_000,
  text: 'Quarterly plan: ship the synthetic widget in March.',
  app: 'Synthetic Editor',
  ...over
})

function setup(over: { ttlMs?: number; limit?: number; maxChars?: number } = {}) {
  const env: Env = { owner: 'owner-a', generation: 0, session: 's1', now: 1_000 }
  const io = memoryIo()
  const store = createSnapshotStore({
    io,
    seal: testSeal,
    open: testOpen,
    owner: () => env.owner,
    generation: () => env.generation,
    now: () => env.now,
    newId: (() => {
      let n = 0
      return () => `snap-${++n}`
    })(),
    ...over
  })
  return { env, io, store }
}

describe('snapshot store: only the owner explicitly asking fills it', () => {
  it('stores a snapshot bound to owner, capture source and generation, encrypted at rest', async () => {
    const { store, io } = setup()
    const result = await store.request({ gesture: 'typed-screen-intent', kind: 'screen' }, async () => observed())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.snapshot).toMatchObject({
      kind: 'screen',
      sourceId: 'display:1',
      app: 'Synthetic Editor',
      granted: false
    })
    expect(JSON.stringify(result)).not.toContain('Quarterly plan')
    const onDisk = [...io.files.values()].map((b) => b.toString('utf8')).join('')
    expect(onDisk).not.toContain('Quarterly plan')
    const read = await store.read(result.snapshot.snapshotId)
    expect(read?.text).toContain('Quarterly plan')
    expect(read?.meta).toMatchObject({
      ownerId: 'owner-a',
      generation: 0,
      sourceId: 'display:1',
      observationId: 'obs-1'
    })
    expect(read?.meta.gesture).toBe('typed-screen-intent')
  })

  it('refuses a gesture that is not an explicit owner gesture and never captures', async () => {
    const { store } = setup()
    const observe = vi.fn(async () => observed())
    for (const gesture of ['background', 'ambient', 'prewarm', 'hover', 'timer', '', undefined]) {
      const result = await store.request({ gesture: gesture as never, kind: 'screen' }, observe)
      expect(result).toEqual({ ok: false, reason: 'invalid' })
    }
    expect(observe).not.toHaveBeenCalled()
    expect(store.list()).toEqual([])
  })

  it('refuses when nobody is signed in or no memory partition is open', async () => {
    const { store, env } = setup()
    env.owner = null
    const observe = vi.fn(async () => observed())
    expect(await store.request({ gesture: 'capture-button', kind: 'screen' }, observe)).toEqual({
      ok: false,
      reason: 'signed-out'
    })
    expect(observe).not.toHaveBeenCalled()
  })

  it('refuses an observation with no text and one the capture failed', async () => {
    const { store } = setup()
    expect(
      await store.request({ gesture: 'capture-button', kind: 'screen' }, async () => observed({ text: '   ' }))
    ).toEqual({
      ok: false,
      reason: 'no-text'
    })
    expect(
      await store.request({ gesture: 'capture-button', kind: 'screen' }, async () => {
        throw new Error('boom')
      })
    ).toEqual({ ok: false, reason: 'capture-failed' })
  })

  it('caps the text, the count, and expires by TTL', async () => {
    const { store, env, io } = setup({ ttlMs: 5_000, limit: 2, maxChars: 10 })
    const a = await store.request({ gesture: 'capture-button', kind: 'screen' }, async () =>
      observed({ text: 'x'.repeat(50) })
    )
    expect(a.ok && a.snapshot.bytes).toBe(10)
    await store.request({ gesture: 'capture-button', kind: 'screen' }, async () => observed())
    // the oldest makes room rather than refusing the newest
    await store.request({ gesture: 'capture-button', kind: 'screen' }, async () => observed())
    expect(store.list()).toHaveLength(2)
    env.now += 5_001
    expect(store.list()).toEqual([])
    await store.sweep()
    expect(io.files.size).toBe(0)
  })

  it('deletes on request and the sealed file goes with it', async () => {
    const { store, io } = setup()
    const r = await store.request({ gesture: 'capture-button', kind: 'document' }, async () => observed())
    if (!r.ok) throw new Error('setup')
    expect(await store.remove(r.snapshot.snapshotId)).toBe(true)
    expect(store.list()).toEqual([])
    expect(io.files.size).toBe(0)
    expect(await store.read(r.snapshot.snapshotId)).toBeNull()
  })

  it('treats a snapshot as gone after sign-out, an owner switch or the capture generation moving', async () => {
    for (const change of [
      (e: Env) => void (e.owner = null),
      (e: Env) => void (e.owner = 'owner-b'),
      (e: Env) => void (e.generation = 1)
    ]) {
      const { store, env } = setup()
      const r = await store.request({ gesture: 'capture-button', kind: 'screen' }, async () => observed())
      if (!r.ok) throw new Error('setup')
      change(env)
      expect(store.list()).toEqual([])
      expect(await store.read(r.snapshot.snapshotId)).toBeNull()
    }
  })

  it('drops a capture that finishes after access was revoked (pending work)', async () => {
    const { store, env, io } = setup()
    let finish: (v: ObservedContent) => void = () => undefined
    const pending = store.request(
      { gesture: 'capture-button', kind: 'screen' },
      () => new Promise<ObservedContent>((r) => (finish = r))
    )
    await store.revokeAll('stop')
    finish(observed())
    expect(await pending).toEqual({ ok: false, reason: 'stale' })
    expect(store.list()).toEqual([])
    expect(io.files.size).toBe(0)
    // a frame taken under an older capture generation is also dropped
    env.generation = 3
    const old = await store.request({ gesture: 'capture-button', kind: 'screen' }, async () =>
      observed({ generation: 2 })
    )
    expect(old).toEqual({ ok: false, reason: 'stale' })
  })

  it('revokeAll removes every snapshot and its file', async () => {
    const { store, io } = setup()
    await store.request({ gesture: 'capture-button', kind: 'screen' }, async () => observed())
    await store.revokeAll('owner_switch')
    expect(store.list()).toEqual([])
    expect(io.files.size).toBe(0)
  })
})
