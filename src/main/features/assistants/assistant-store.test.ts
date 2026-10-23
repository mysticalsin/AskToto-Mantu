import { describe, expect, it } from 'vitest'
import { createAssistantStore } from './assistant-store'
import { assistantIdFor, idempotencyKeyFor, normalizeDraft, type AssistantEntity } from './assistant-model'
import {
  harness,
  KEY_A,
  KEY_B,
  memoryIo,
  open,
  scopeOf,
  seal,
  TENANT_1,
  TENANT_2
} from './__fixtures__/assistant-harness'

function entityFor(scope: { ownerKey: string; tenantKey: string }, name: string): AssistantEntity {
  const draft = normalizeDraft({ name, base: 'sales', instructions: 'synthetic-private-instruction' })
  const key = idempotencyKeyFor(scope, draft)
  return {
    assistantId: assistantIdFor(key),
    ownerKey: scope.ownerKey,
    tenantKey: scope.tenantKey,
    ...draft,
    createdAt: 10,
    updatedAt: 10,
    revision: 1,
    archived: false,
    idempotencyKey: key
  }
}

describe('assistant store (G48)', () => {
  it('stores sealed bytes only: no name or instructions are readable at rest', async () => {
    const h = harness()
    const entity = entityFor(scopeOf(KEY_A, TENANT_1), 'Quarterly Review Coach')
    const result = await h.store.transact((view) => ({ commit: true, own: [...view.own, entity], value: 1 }))
    expect(result).toEqual({ ok: true, value: 1 })
    const raw = [...h.io.files.values()][0]!
    expect(raw.toString('utf8')).not.toContain('Quarterly')
    expect(raw.toString('utf8')).not.toContain('synthetic-private-instruction')
    expect(open(raw)).toContain('Quarterly Review Coach')
    expect(open(raw)).toContain(KEY_A)
    expect(open(raw)).toContain(TENANT_1)
  })

  it('hides everything when another owner or another tenant is in force', async () => {
    const h = harness()
    await h.store.transact((view) => ({
      commit: true,
      own: [...view.own, entityFor(scopeOf(KEY_A, TENANT_1), 'Mine')],
      value: 0
    }))
    const readOwn = () => h.store.transact((view) => ({ commit: false, value: view.own.length }))
    expect(await readOwn()).toEqual({ ok: true, value: 1 })
    h.current.scope = scopeOf(KEY_B, TENANT_1)
    expect(await readOwn()).toEqual({ ok: true, value: 0 })
    h.current.scope = scopeOf(KEY_A, TENANT_2)
    expect(await readOwn()).toEqual({ ok: true, value: 0 })
    h.current.scope = null
    expect(await readOwn()).toEqual({ ok: false, reason: 'signed-out' })
  })

  it('never shows an entity planted in the partition file under another owner or tenant, and keeps it intact', async () => {
    const h = harness()
    const mine = scopeOf(KEY_A, TENANT_1)
    const foreignOwner = entityFor(scopeOf(KEY_B, TENANT_1), 'Foreign owner')
    const foreignTenant = entityFor(scopeOf(KEY_A, TENANT_2), 'Foreign tenant')
    h.io.files.set(
      mine.partitionId,
      seal(
        JSON.stringify({
          v: 1,
          partitionId: mine.partitionId,
          ownerKey: mine.ownerKey,
          tenantKey: mine.tenantKey,
          entities: [foreignOwner, foreignTenant],
          migration: null
        })
      )
    )
    const seen = await h.store.transact((view) => ({ commit: false, value: view.own.map((e) => e.name) }))
    expect(seen).toEqual({ ok: true, value: [] })
    await h.store.transact((view) => ({ commit: true, own: [...view.own, entityFor(mine, 'Mine')], value: 0 }))
    const doc = JSON.parse(open(h.io.files.get(mine.partitionId)!)) as { entities: AssistantEntity[] }
    expect(doc.entities.map((e) => e.name).sort()).toEqual(['Foreign owner', 'Foreign tenant', 'Mine'])
  })

  it('refuses a sealed file copied from another owner even if it is placed at the current partition path', async () => {
    const h = harness()
    const original = scopeOf(KEY_A, TENANT_1)
    await h.store.transact((view) => ({
      commit: true,
      own: [...view.own, entityFor(original, 'Private to A')],
      value: 0
    }))
    h.current.scope = { ...scopeOf(KEY_B, TENANT_1), partitionId: original.partitionId }
    expect(await h.store.transact((view) => ({ commit: false, value: view.own.map((entry) => entry.name) }))).toEqual({
      ok: false,
      reason: 'unavailable'
    })
    expect(h.io.writes).toBe(1)
  })

  it('refuses a write when the owner changes while it is in flight, and writes nothing', async () => {
    const h = harness()
    const slow = memoryIo()
    const original = slow.read.bind(slow)
    slow.read = async (id) => {
      const data = await original(id)
      h.current.scope = scopeOf(KEY_B, TENANT_1) // the owner switches during the await
      return data
    }
    const store = createAssistantStore({ io: slow, seal, open, scope: () => h.current.scope })
    const result = await store.transact((view) => ({
      commit: true,
      own: [...view.own, entityFor(scopeOf(KEY_A, TENANT_1), 'X')],
      value: 0
    }))
    expect(result).toEqual({ ok: false, reason: 'stale' })
    expect(slow.writes).toBe(0)
  })

  it('does not return a read taken under another owner either', async () => {
    const h = harness()
    await h.store.transact((view) => ({
      commit: true,
      own: [...view.own, entityFor(scopeOf(KEY_A, TENANT_1), 'Mine')],
      value: 0
    }))
    const racing = memoryIo()
    racing.files = h.io.files
    const original = racing.read.bind(racing)
    racing.read = async (id) => {
      const data = await original(id)
      h.current.scope = scopeOf(KEY_B, TENANT_1)
      return data
    }
    const store = createAssistantStore({ io: racing, seal, open, scope: () => h.current.scope })
    expect(await store.transact((view) => ({ commit: false, value: view.own.length }))).toEqual({
      ok: false,
      reason: 'stale'
    })
  })

  it('does not return a committed result if the owner switches while the write is in flight', async () => {
    const h = harness()
    const slow = memoryIo()
    let markWriteStarted!: () => void
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve
    })
    let finishWrite!: () => void
    const writing = new Promise<void>((resolve) => {
      finishWrite = resolve
    })
    slow.write = async (id, data) => {
      markWriteStarted()
      await writing
      slow.writes += 1
      slow.files.set(id, data)
    }
    const store = createAssistantStore({ io: slow, seal, open, scope: () => h.current.scope })
    const result = store.transact((view) => ({
      commit: true,
      own: [...view.own, entityFor(scopeOf(KEY_A, TENANT_1), 'Private to A')],
      value: 'private result'
    }))
    await writeStarted
    h.current.scope = scopeOf(KEY_B, TENANT_1)
    finishWrite()
    expect(await result).toEqual({ ok: false, reason: 'stale' })
    expect(slow.writes).toBe(1)
  })

  it('reports unavailable and never overwrites a file it cannot open or validate', async () => {
    const h = harness()
    const mine = scopeOf(KEY_A, TENANT_1)
    const garbage = Buffer.from('not sealed by this profile')
    h.io.files.set(mine.partitionId, garbage)
    const write = () =>
      h.store.transact((view) => ({ commit: true, own: [...view.own, entityFor(mine, 'Mine')], value: 0 }))
    expect(await write()).toEqual({ ok: false, reason: 'unavailable' })
    h.io.files.set(
      mine.partitionId,
      seal(
        JSON.stringify({
          v: 1,
          partitionId: mine.partitionId,
          ownerKey: mine.ownerKey,
          tenantKey: mine.tenantKey,
          entities: [{ nope: true }],
          migration: null
        })
      )
    )
    const before = h.io.files.get(mine.partitionId)!
    expect(await write()).toEqual({ ok: false, reason: 'unavailable' })
    expect(h.io.files.get(mine.partitionId)).toBe(before)
    expect(h.io.writes).toBe(0)
  })

  it('serializes concurrent transactions so no update is lost', async () => {
    const h = harness()
    const mine = scopeOf(KEY_A, TENANT_1)
    await Promise.all(
      ['One', 'Two', 'Three'].map((name) =>
        h.store.transact((view) => ({ commit: true, own: [...view.own, entityFor(mine, name)], value: 0 }))
      )
    )
    expect(await h.store.transact((view) => ({ commit: false, value: view.own.length }))).toEqual({
      ok: true,
      value: 3
    })
  })
})
