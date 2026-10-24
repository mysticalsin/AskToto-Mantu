import { describe, expect, it } from 'vitest'
import {
  CONVERSATION_LIMIT_PER_OWNER,
  CONVERSATION_TURN_LIMIT,
  DRAFT_MAX_PER_OWNER,
  DRAFT_TTL_MS
} from '@shared/conversations'
import { harness, turn } from './__fixtures__/conversation-harness'

async function started(h = harness()) {
  const service = h.newService()
  const opened = await service.open({ assistantId: 'sys-general' })
  if (!opened.ok) throw new Error('open failed')
  return { h, service, id: opened.conversation.id }
}
const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r)}`)
  return r as Extract<T, { ok: true }>
}

describe('conversation service (G49)', () => {
  it('opens one live thread per assistant and meeting, and returns it again', async () => {
    const { service, id } = await started()
    const again = ok(await service.open({ assistantId: 'sys-general' }))
    expect(again.created).toBe(false)
    expect(again.conversation.id).toBe(id)
    expect(ok(await service.open({ assistantId: 'sys-general', meetingFile: 'm1.md' })).created).toBe(true)
    expect(await service.open({ assistantId: 'sys-nope' })).toEqual({ ok: false, reason: 'not-found' })
    expect(await service.open({ assistantId: 'sys-general', meetingFile: 'gone.md' })).toEqual({
      ok: false,
      reason: 'not-found'
    })
  })

  it('starts a fresh empty thread on request, which later opens then return', async () => {
    const { h, service, id } = await started()
    ok(
      await service.append({
        conversationId: id,
        assistantId: 'sys-general',
        runId: 'r1',
        turns: [turn('user', 'old')]
      })
    )
    h.clock.now += 5
    const fresh = ok(await service.open({ assistantId: 'sys-general', fresh: true }))
    expect(fresh.created).toBe(true)
    expect(fresh.conversation.id).not.toBe(id)
    expect(ok(await service.history({ conversationId: fresh.conversation.id, limit: 5 })).turns).toEqual([])
    expect(ok(await service.open({ assistantId: 'sys-general' })).conversation.id).toBe(fresh.conversation.id)
    expect(ok(await service.history({ conversationId: id, limit: 5 })).turns).toHaveLength(1)
  })

  it("append clears that conversation's draft only", async () => {
    const { h, service, id } = await started()
    const other = ok(await service.open({ assistantId: 'sys-general', meetingFile: 'm1.md' })).conversation.id
    await service.draftSet({ conversationId: id, text: 'typing here' })
    await service.draftSet({ conversationId: other, text: 'typing there' })
    ok(
      await service.append({
        conversationId: id,
        assistantId: 'sys-general',
        runId: 'r1',
        turns: [turn('user', 'q'), turn('assistant', 'a')]
      })
    )
    expect(ok(await service.draftGet({ conversationId: id })).text).toBeNull()
    expect(ok(await service.draftGet({ conversationId: other })).text).toBe('typing there')
    expect(h.audits.some((a) => a.phase === 'appended')).toBe(true)
  })

  it('bounds drafts: expiry at the TTL, the per-owner cap, and an empty text deletes', async () => {
    const { h, service, id } = await started()
    await service.draftSet({ conversationId: id, text: 'keep me' })
    h.clock.now += DRAFT_TTL_MS - 1
    expect(ok(await service.draftGet({ conversationId: id })).text).toBe('keep me')
    h.clock.now += 1
    expect(ok(await service.draftGet({ conversationId: id })).text).toBeNull()
    await service.draftSet({ conversationId: id, text: 'again' })
    await service.draftSet({ conversationId: id, text: '' })
    expect(ok(await service.draftGet({ conversationId: id })).text).toBeNull()

    // More conversations than the draft cap: the least recently saved draft is evicted.
    const ids: string[] = []
    for (let i = 0; i < DRAFT_MAX_PER_OWNER + 2; i += 1) {
      h.assistants.push({ id: `sys-m${i}`, archived: false })
      ids.push(ok(await service.open({ assistantId: `sys-m${i}` })).conversation.id)
      h.clock.now += 10
      await service.draftSet({ conversationId: ids[i]!, text: `d${i}` })
    }
    expect(ok(await service.draftGet({ conversationId: ids[0]! })).text).toBeNull()
    expect(ok(await service.draftGet({ conversationId: ids[ids.length - 1]! })).text).toBe(`d${ids.length - 1}`)
  })

  it('on a remote-lost thread append creates a linked successor; the old one keeps its assistant and turns', async () => {
    const { h, service, id } = await started()
    h.remote.active = true
    ok(
      await service.append({
        conversationId: id,
        assistantId: 'sys-general',
        runId: 'r1',
        turns: [turn('user', 'q1'), turn('assistant', 'a1')]
      })
    )
    h.remote.epoch += 1 // Dust started a new conversation: the stamped one is gone
    const listed = ok(await service.list())
    expect(listed.conversations[0]).toMatchObject({ id, status: 'dead', deadReason: 'remote-lost' })
    h.assistants.push({ id: 'sys-sales', archived: false })
    const linked = ok(
      await service.append({ conversationId: id, assistantId: 'sys-sales', runId: 'r2', turns: [turn('user', 'q2')] })
    )
    expect(linked.linkedFrom).toBe(id)
    expect(linked.deadReason).toBe('remote-lost')
    expect(linked.conversationId).not.toBe(id)
    const all = ok(await service.list()).conversations
    const old = all.find((c) => c.id === id)!
    expect(old).toMatchObject({
      assistantId: 'sys-general',
      supersededBy: linked.conversationId,
      deadReason: 'superseded'
    })
    expect(all.find((c) => c.id === linked.conversationId)).toMatchObject({ assistantId: 'sys-sales', linkedFrom: id })
    const oldHistory = ok(await service.history({ conversationId: id, limit: 10 }))
    expect(oldHistory.turns.map((t) => t.text)).toEqual(['q1', 'a1'])
    // Appending to the superseded thread again continues the successor instead of forking a third.
    const next = ok(
      await service.append({ conversationId: id, assistantId: 'sys-sales', runId: 'r3', turns: [turn('user', 'q3')] })
    )
    expect(next.conversationId).toBe(linked.conversationId)
    expect(h.audits.some((a) => a.phase === 'linked')).toBe(true)
  })

  it.each([
    [
      'assistant-missing',
      (h: ReturnType<typeof harness>) => h.assistants.splice(0, 1, { id: 'sys-other', archived: false })
    ],
    ['assistant-archived', (h: ReturnType<typeof harness>) => (h.assistants[0]!.archived = true)],
    ['meeting-missing', (h: ReturnType<typeof harness>) => h.meetings.splice(0)]
  ])('keeps a %s thread readable instead of dropping it', async (reason, mutate) => {
    const h = harness()
    const service = h.newService()
    const opened = ok(await service.open({ assistantId: 'sys-general', meetingFile: 'm1.md' }))
    const id = opened.conversation.id
    ok(
      await service.append({
        conversationId: id,
        assistantId: 'sys-general',
        runId: 'r1',
        turns: [turn('user', 'kept')]
      })
    )
    mutate(h)
    const page = ok(await service.history({ conversationId: id, limit: 5 }))
    expect(page).toMatchObject({ status: 'dead', deadReason: reason })
    expect(page.turns.map((t) => t.text)).toEqual(['kept'])
    expect(ok(await service.list()).conversations).toHaveLength(1)
  })

  it('replays a duplicate runId without writing', async () => {
    const { h, service, id } = await started()
    const first = ok(
      await service.append({
        conversationId: id,
        assistantId: 'sys-general',
        runId: 'same',
        turns: [turn('user', 'q')]
      })
    )
    const before = h.indexIo.writes + h.turnIo.writes
    const second = ok(
      await service.append({
        conversationId: id,
        assistantId: 'sys-general',
        runId: 'same',
        turns: [turn('user', 'q')]
      })
    )
    expect(second).toEqual(first)
    expect(h.indexIo.writes + h.turnIo.writes).toBe(before)
    expect(h.audits.at(-1)?.phase).toBe('replayed')
  })

  it('serves an identical page before and after concurrent appends, and anchors the former top turn', async () => {
    const { service, id } = await started()
    for (let i = 1; i <= 6; i += 1) {
      ok(
        await service.append({
          conversationId: id,
          assistantId: 'sys-general',
          runId: `r${i}`,
          turns: [turn('user', `u${i}`), turn('assistant', `a${i}`)]
        })
      )
    }
    const latest = ok(await service.history({ conversationId: id, limit: 4 }))
    expect(latest.turns.map((t) => t.seq)).toEqual([9, 10, 11, 12])
    expect(latest.nextBefore).toBe('s9')
    expect(latest.latestSeq).toBe(12)
    expect(latest.anchor).toEqual({ turnId: latest.turns[3]!.id, seq: 12 })

    const pageBefore = ok(await service.history({ conversationId: id, before: 's9', limit: 4 }))
    await Promise.all([
      service.append({ conversationId: id, assistantId: 'sys-general', runId: 'c1', turns: [turn('user', 'late1')] }),
      service.append({ conversationId: id, assistantId: 'sys-general', runId: 'c2', turns: [turn('user', 'late2')] })
    ])
    const pageAfter = ok(await service.history({ conversationId: id, before: 's9', limit: 4 }))
    expect(pageAfter.turns).toEqual(pageBefore.turns)
    expect(pageAfter.turns.map((t) => t.seq)).toEqual([5, 6, 7, 8])
    expect(pageAfter.anchor?.seq).toBe(9) // the turn that was on top before older turns were prepended
    expect(pageAfter.latestSeq).toBe(14)

    const newer = ok(await service.history({ conversationId: id, after: 's12', limit: 10 }))
    expect(newer.turns.map((t) => t.text)).toEqual(['late1', 'late2'])
    const oldest = ok(await service.history({ conversationId: id, before: 's5', limit: 50 }))
    expect(oldest.turns.map((t) => t.seq)).toEqual([1, 2, 3, 4])
    expect(oldest.nextBefore).toBeNull()
  })

  it('restores the stored reading position as the first-load anchor while that turn exists', async () => {
    const { service, id } = await started()
    ok(
      await service.append({
        conversationId: id,
        assistantId: 'sys-general',
        runId: 'r1',
        turns: [turn('user', 'a'), turn('assistant', 'b')]
      })
    )
    const first = ok(await service.history({ conversationId: id, limit: 5 }))
    await service.setAnchor({ conversationId: id, turnId: first.turns[0]!.id })
    expect(ok(await service.history({ conversationId: id, limit: 5 })).anchor?.seq).toBe(1)
    expect(await service.setAnchor({ conversationId: id, turnId: `t_${'f'.repeat(32)}` })).toEqual({
      ok: false,
      reason: 'not-found'
    })
  })

  it('answers limit at the conversation and turn caps without pruning anything', async () => {
    const h = harness()
    const service = h.newService()
    for (let i = 0; i < CONVERSATION_LIMIT_PER_OWNER; i += 1) {
      h.assistants.push({ id: `sys-x${i}`, archived: false })
      ok(await service.open({ assistantId: `sys-x${i}` }))
    }
    expect(await service.open({ assistantId: 'sys-general' })).toEqual({ ok: false, reason: 'limit' })
    expect(ok(await service.list()).conversations).toHaveLength(CONVERSATION_LIMIT_PER_OWNER)

    const t = await started()
    for (let i = 0; i < CONVERSATION_TURN_LIMIT / 2; i += 1) {
      ok(
        await t.service.append({
          conversationId: t.id,
          assistantId: 'sys-general',
          runId: `r${i}`,
          turns: [turn('user', 'q'), turn('assistant', 'a')]
        })
      )
    }
    expect(
      await t.service.append({
        conversationId: t.id,
        assistantId: 'sys-general',
        runId: 'over',
        turns: [turn('user', 'q')]
      })
    ).toEqual({
      ok: false,
      reason: 'limit'
    })
    expect(ok(await t.service.history({ conversationId: t.id, limit: 1 })).latestSeq).toBe(CONVERSATION_TURN_LIMIT)
  }, 60_000)

  it('is not-found for an unknown id and signed-out without a scope', async () => {
    const { h, service } = await started()
    expect(await service.history({ conversationId: `c_${'9'.repeat(32)}`.replace(/9/g, 'a'), limit: 1 })).toEqual({
      ok: false,
      reason: 'not-found'
    })
    h.current.scope = null
    expect(await service.list()).toEqual({ ok: false, reason: 'signed-out' })
  })

  it('writes audit records that carry no text, ids, assistant or meeting names', async () => {
    const { h, service, id } = await started()
    await service.open({ assistantId: 'sys-general', meetingFile: 'm1.md' })
    ok(
      await service.append({
        conversationId: id,
        assistantId: 'sys-general',
        runId: 'r-secret',
        turns: [turn('user', 'private words here')]
      })
    )
    await service.draftSet({ conversationId: id, text: 'private draft words' })
    await service.history({ conversationId: 'bad' })
    const blob = JSON.stringify(h.audits)
    for (const forbidden of ['private', id, 'sys-general', 'm1.md', 'r-secret', 'words'])
      expect(blob).not.toContain(forbidden)
    expect(h.audits.length).toBeGreaterThan(3)
  })
})
