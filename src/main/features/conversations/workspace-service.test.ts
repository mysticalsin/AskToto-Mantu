import { describe, expect, it } from 'vitest'
import { WORKSPACE_PIN_MAX } from '@shared/conversation-workspace'
import {
  KEY_A,
  KEY_B,
  TENANT_1,
  TENANT_2,
  harness,
  open,
  scopeOf,
  seal,
  turn
} from './__fixtures__/conversation-harness'
import type { ConversationRecord } from './conversation-model'
import { createWorkspaceService } from './workspace-service'
import { createWorkspaceStore } from './workspace-store'

type H = ReturnType<typeof harness>

async function thread(h: H, text: string[] = [], assistantId = 'sys-general', fresh = true) {
  const service = h.newService()
  const opened = await service.open({ assistantId, fresh })
  if (!opened.ok) throw new Error('open failed')
  const id = opened.conversation.id
  const turnIds: string[] = []
  for (let at = 0; at < text.length; at += 2) {
    h.clock.now += 10
    await service.append({
      conversationId: id,
      assistantId,
      runId: `r${id.slice(-6)}${h.clock.now}`,
      turns: text.slice(at, at + 2).map((t, i) => turn(i % 2 === 0 ? 'user' : 'assistant', t))
    })
  }
  if (text.length > 0) {
    const hist = await service.history({ conversationId: id, limit: 50 })
    if (hist.ok) turnIds.push(...hist.turns.map((t) => t.id))
  }
  return { id, turnIds }
}

const get = async (ws: ReturnType<H['newWorkspace']>) => {
  const r = await ws.get()
  if (!r.ok) throw new Error(`get refused ${r.reason}`)
  return r
}

/** Rewrites the stored index (records of every owner in the partition file). */
const editIndex = async (h: H, fn: (records: ConversationRecord[]) => ConversationRecord[]) =>
  h
    .store()
    .index.transact(
      (doc) => ({ commit: true, doc: { ...doc, conversations: fn(doc.conversations) }, value: null }),
      scopeOf(KEY_A, TENANT_1)
    )

describe('workspace service (G50)', () => {
  it('selection persists across a new service instance', async () => {
    const h = harness()
    const { id } = await thread(h, ['hi', 'yo'])
    const ws = h.newWorkspace()
    expect(await ws.select({ conversationId: id })).toMatchObject({ ok: true, rev: 1 })
    expect((await get(h.newWorkspace())).selectedConversationId).toBe(id)
  })

  it('two callers see identical selection and counts', async () => {
    const h = harness()
    await thread(h, ['a'])
    const first = h.newWorkspace()
    const second = h.newWorkspace()
    const { id } = await thread(h, ['b'])
    await first.select({ conversationId: id })
    const a = await get(first)
    const b = await get(second)
    expect(b).toEqual(a)
    expect(a.selectedConversationId).toBe(id)
  })

  it('superseded selection forwards to successor', async () => {
    const h = harness()
    const { id } = await thread(h, ['one'])
    const ws = h.newWorkspace()
    await ws.select({ conversationId: id })
    h.assistants.length = 0 // the assistant is gone: the next append links a successor
    h.assistants.push({ id: 'sys-other', archived: false, name: 'Other' })
    const appended = await h.newService().append({
      conversationId: id,
      assistantId: 'sys-other',
      runId: 'r-link',
      turns: [turn('user', 'again')]
    })
    if (!appended.ok) throw new Error('append failed')
    const got = await get(ws)
    expect(got.selectedConversationId).toBe(appended.conversationId)
    expect(got.selectedConversationId).not.toBe(id)
    expect((await get(h.newWorkspace())).selectedConversationId).toBe(appended.conversationId)
  })

  it('deleted selection becomes null', async () => {
    const h = harness()
    const { id } = await thread(h, ['x'])
    const ws = h.newWorkspace()
    await ws.select({ conversationId: id })
    await editIndex(h, (records) => records.filter((r) => r.id !== id))
    expect((await get(ws)).selectedConversationId).toBeNull()
  })

  it('select foreign conversation is not-found', async () => {
    const h = harness()
    const { id } = await thread(h, ['x'])
    await editIndex(h, (records) => records.map((r) => (r.id === id ? { ...r, ownerKey: KEY_B } : r)))
    const ws = h.newWorkspace()
    expect(await ws.select({ conversationId: id })).toEqual({ ok: false, reason: 'not-found' })
    expect(await ws.select({ conversationId: `c_${'0'.repeat(32)}` })).toEqual({ ok: false, reason: 'not-found' })
    expect(await ws.select({ conversationId: null })).toMatchObject({ ok: true })
  })

  it('markRead resolves turnId and is monotonic', async () => {
    const h = harness()
    const { id, turnIds } = await thread(h, ['q1', 'a1', 'q2', 'a2'])
    const ws = h.newWorkspace()
    // First contact baselines history as read; a later turn is the first unread one.
    await get(ws)
    h.clock.now += 10
    await h.newService().append({
      conversationId: id,
      assistantId: 'sys-general',
      runId: 'rx',
      turns: [turn('user', 'q3'), turn('assistant', 'a3')]
    })
    const unread = (await get(ws)).items.find((i) => i.conversation.id === id)!
    expect(unread).toMatchObject({ unread: true, unreadTurns: 2 })
    const hist = await h.newService().history({ conversationId: id, limit: 50 })
    const ids = hist.ok ? hist.turns.map((t) => t.id) : []
    expect(ids).toHaveLength(6)
    await ws.markRead({ conversationId: id, throughTurnId: ids[4]! })
    expect((await get(ws)).items[0]).toMatchObject({ unread: true, unreadTurns: 1 })
    await ws.markRead({ conversationId: id, throughTurnId: turnIds[0]! }) // an older turn cannot regress
    expect((await get(ws)).items[0]).toMatchObject({ unread: true, unreadTurns: 1 })
    await ws.markRead({ conversationId: id, throughTurnId: ids[5]! })
    expect((await get(ws)).items[0]).toMatchObject({ unread: false, unreadTurns: 0 })
  })

  it('markRead with uncommitted turn is not-found', async () => {
    const h = harness()
    const { id } = await thread(h, ['q'])
    const ws = h.newWorkspace()
    expect(await ws.markRead({ conversationId: id, throughTurnId: `t_${'9'.repeat(32)}` })).toEqual({
      ok: false,
      reason: 'not-found'
    })
  })

  it('markUnread then markRead clears manual flag', async () => {
    const h = harness()
    const { id, turnIds } = await thread(h, ['q', 'a'])
    const ws = h.newWorkspace()
    expect((await get(ws)).counts).toEqual({ unreadConversations: 0, readConversations: 1, archivedConversations: 0 })
    await ws.markUnread({ conversationId: id })
    const marked = await get(ws)
    expect(marked.items[0]).toMatchObject({ unread: true, unreadTurns: 0 })
    expect(marked.counts.unreadConversations).toBe(1)
    await ws.markRead({ conversationId: id, throughTurnId: turnIds[1]! })
    expect((await get(ws)).items[0]).toMatchObject({ unread: false })
  })

  it('unread count after restart equals unread records', async () => {
    const h = harness()
    await thread(h, ['old'])
    await get(h.newWorkspace()) // baseline: existing history is read
    const a = await thread(h, ['n1'])
    const b = await thread(h, ['n2'])
    await thread(h, [])
    const before = await get(h.newWorkspace())
    expect(before.counts).toEqual({ unreadConversations: 2, readConversations: 2, archivedConversations: 0 })
    const hist = await h.newService().history({ conversationId: a.id, limit: 5 })
    await h.newWorkspace().markRead({ conversationId: a.id, throughTurnId: hist.ok ? hist.turns[0]!.id : '' })
    const after = await get(h.newWorkspace())
    expect(after.counts.unreadConversations).toBe(after.items.filter((i) => i.unread).length)
    expect(after.items.find((i) => i.conversation.id === b.id)!.unread).toBe(true)
    expect(after.counts.unreadConversations).toBe(1)
  })

  it('archive hides from items, search labels archived, restore returns it, history still readable', async () => {
    const h = harness()
    const { id } = await thread(h, ['needle in a haystack'])
    const ws = h.newWorkspace()
    await ws.setArchived({ conversationId: id, archived: true })
    const hidden = await get(ws)
    expect(hidden.items).toHaveLength(0)
    expect(hidden.counts.archivedConversations).toBe(1)
    const found = await ws.search({ query: 'needle', limit: 5 })
    expect(found).toMatchObject({ ok: true, hits: [{ conversationId: id, label: 'archived', matched: 'turn' }] })
    expect(await ws.search({ query: 'needle', limit: 5, includeArchived: false })).toMatchObject({ hits: [] })
    expect((await h.newService().history({ conversationId: id, limit: 5 })).ok).toBe(true)
    await ws.setArchived({ conversationId: id, archived: false })
    expect((await get(ws)).items.map((i) => i.conversation.id)).toEqual([id])
  })

  it('pin conversation and assistant; 13th pin refused limit', async () => {
    const h = harness()
    const a = await thread(h, ['a'])
    h.clock.now += 100
    const b = await thread(h, ['b'])
    const ws = h.newWorkspace()
    expect((await get(ws)).items.map((i) => i.conversation.id)).toEqual([b.id, a.id])
    await ws.setPinned({ kind: 'conversation', id: a.id, pinned: true })
    await ws.setPinned({ kind: 'assistant', id: 'sys-general', pinned: true })
    const pinned = await get(ws)
    expect(pinned.items.map((i) => [i.conversation.id, i.pinned])).toEqual([
      [a.id, true],
      [b.id, false]
    ])
    expect(pinned.pinnedAssistantIds).toEqual(['sys-general'])
    expect(await ws.setPinned({ kind: 'assistant', id: 'sys-missing', pinned: true })).toEqual({
      ok: false,
      reason: 'not-found'
    })
    for (let i = 0; i < WORKSPACE_PIN_MAX - 2; i += 1) {
      h.assistants.push({ id: `sys-p${i}`, archived: false, name: `P${i}` })
      expect(await ws.setPinned({ kind: 'assistant', id: `sys-p${i}`, pinned: true })).toMatchObject({ ok: true })
    }
    h.assistants.push({ id: 'sys-extra', archived: false, name: 'Extra' })
    expect(await ws.setPinned({ kind: 'assistant', id: 'sys-extra', pinned: true })).toEqual({
      ok: false,
      reason: 'limit'
    })
    expect(await ws.setPinned({ kind: 'conversation', id: a.id, pinned: false })).toMatchObject({ ok: true })
    expect((await get(ws)).items.every((i) => !i.pinned)).toBe(true)
  })

  it('search never returns foreign owner or foreign tenant hits (same partition file)', async () => {
    const h = harness()
    const mine = await thread(h, ['shared-needle mine'])
    const foreignA = await thread(h, ['shared-needle foreign owner'])
    const foreignT = await thread(h, ['shared-needle foreign tenant'])
    await editIndex(h, (records) =>
      records.map((r) =>
        r.id === foreignA.id ? { ...r, ownerKey: KEY_B } : r.id === foreignT.id ? { ...r, tenantKey: TENANT_2 } : r
      )
    )
    const ws = h.newWorkspace()
    const result = await ws.search({ query: 'SHARED-needle', limit: 10 })
    expect(result).toMatchObject({ ok: true })
    const ids = result.ok ? result.hits.map((hit) => hit.conversationId) : []
    expect(ids).toEqual([mine.id])
    const all = await get(ws)
    expect(all.items.map((i) => i.conversation.id)).toEqual([mine.id])
  })

  it('search matches assistant names and reports a scan budget as truncated', async () => {
    const h = harness()
    await thread(h, ['alpha'])
    await thread(h, ['beta'])
    const ws = h.newWorkspace()
    expect(await ws.search({ query: 'GENERAL', limit: 3 })).toMatchObject({
      ok: true,
      hits: [
        { matched: 'assistant-name', turnId: null, snippet: null, label: 'active' },
        { matched: 'assistant-name', turnId: null, snippet: null, label: 'active' }
      ],
      truncated: false
    })
    expect(await ws.search({ query: 'zzzz', limit: 5 })).toEqual({ ok: true, hits: [], truncated: false })
    expect(await ws.search({ query: 'a', limit: 5 })).toEqual({ ok: false, reason: 'invalid' })
  })

  it('search scan budget sets truncated', async () => {
    const h = harness()
    for (let i = 0; i < 102; i += 1) {
      h.clock.now += 1
      await thread(h, [`text ${i}`])
    }
    const result = await h.newWorkspace().search({ query: 'absent-term', limit: 5 })
    expect(result).toEqual({ ok: true, hits: [], truncated: true })
  })

  it('signed-out scope refuses every op', async () => {
    const h = harness(null)
    const ws = h.newWorkspace()
    const signedOut = { ok: false, reason: 'signed-out' }
    expect(await ws.get()).toEqual(signedOut)
    for (const call of [
      ws.select({ conversationId: null }),
      ws.markRead({}),
      ws.markUnread({}),
      ws.setArchived({}),
      ws.setPinned({}),
      ws.search({})
    ]) {
      expect(await call).toEqual(signedOut)
    }
  })

  it('context failure refuses unavailable and commits nothing', async () => {
    const h = harness()
    await thread(h, ['x'])
    const writes = h.wsIo.writes
    const brokenService = createWorkspaceService({
      conversations: h.store(),
      workspace: createWorkspaceStore({ io: h.wsIo, seal, open, scope: () => h.current.scope }),
      scope: () => h.current.scope,
      now: () => h.clock.now,
      assistants: async () => {
        throw new Error('assistants unreadable')
      },
      meetings: async () => [],
      remote: () => h.remote
    })
    expect(await brokenService.get()).toEqual({ ok: false, reason: 'unavailable' })
    expect(await brokenService.select({ conversationId: null })).toEqual({ ok: false, reason: 'unavailable' })
    expect(h.wsIo.writes).toBe(writes)
  })

  it('audit never contains query, snippet, ids or text', async () => {
    const h = harness()
    const { id, turnIds } = await thread(h, ['seeded-secret-text', 'reply'])
    const ws = h.newWorkspace()
    await get(ws)
    await ws.select({ conversationId: id })
    await ws.markRead({ conversationId: id, throughTurnId: turnIds[0]! })
    await ws.markUnread({ conversationId: id })
    await ws.setArchived({ conversationId: id, archived: true })
    await ws.setArchived({ conversationId: id, archived: false })
    await ws.setPinned({ kind: 'conversation', id, pinned: true })
    await ws.setPinned({ kind: 'conversation', id, pinned: false })
    await ws.search({ query: 'seeded-secret', limit: 5 })
    await ws.select({ conversationId: `c_${'0'.repeat(32)}` })
    const serialized = JSON.stringify(h.wsAudits)
    for (const forbidden of ['seeded-secret', 'General', id, turnIds[0]!, 'sys-general']) {
      expect(serialized).not.toContain(forbidden)
    }
    const phases = h.wsAudits.map((a) => a.phase)
    for (const phase of [
      'baselined',
      'selected',
      'read',
      'unread',
      'archived',
      'restored',
      'pinned',
      'unpinned',
      'searched',
      'refused'
    ]) {
      expect(phases).toContain(phase)
    }
    expect(h.wsAudits.find((a) => a.phase === 'searched')!.detail).toEqual({ count: 1 })
  })

  it('rev increments per mutation and subscribe fires', async () => {
    const h = harness()
    const { id, turnIds } = await thread(h, ['q'])
    const ws = h.newWorkspace()
    const seen: number[] = []
    const off = ws.subscribe((rev) => seen.push(rev))
    ws.subscribe(() => {
      throw new Error('listener failure is swallowed')
    })
    await ws.select({ conversationId: id })
    await ws.markUnread({ conversationId: id })
    await ws.markRead({ conversationId: id, throughTurnId: turnIds[0]! })
    expect(seen).toEqual([1, 2, 3])
    expect((await get(ws)).rev).toBe(3)
    off()
    await ws.setArchived({ conversationId: id, archived: true })
    expect(seen).toEqual([1, 2, 3])
    expect((await get(ws)).rev).toBe(4)
  })
})
