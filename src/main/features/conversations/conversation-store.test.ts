import { describe, expect, it } from 'vitest'
import { committedTurns } from './conversation-store'
import {
  harness,
  KEY_A,
  KEY_B,
  open,
  scopeOf,
  seal,
  TENANT_1,
  TENANT_2,
  turn
} from './__fixtures__/conversation-harness'

const PRIVATE_TURN_TEXT = 'synthetic-private-question-0451'
const SECRET_DRAFT = 'synthetic-private-draft-0451'

describe('conversation store (G49)', () => {
  it('keeps turn and draft text out of the sealed bytes, with turns stored by id in their own file', async () => {
    const h = harness()
    const service = h.newService()
    const opened = await service.open({ assistantId: 'sys-general' })
    if (!opened.ok) throw new Error('open failed')
    const id = opened.conversation.id
    await service.append({
      conversationId: id,
      assistantId: 'sys-general',
      runId: 'r1',
      turns: [turn('user', PRIVATE_TURN_TEXT)]
    })
    await service.draftSet({ conversationId: id, text: SECRET_DRAFT })
    for (const bytes of [...h.indexIo.files.values(), ...h.turnIo.files.values()]) {
      expect(bytes.toString('utf8')).not.toContain(PRIVATE_TURN_TEXT)
      expect(bytes.toString('utf8')).not.toContain(SECRET_DRAFT)
    }
    const index = open([...h.indexIo.files.values()][0]!)
    expect(index).not.toContain(PRIVATE_TURN_TEXT) // the index references turns, it does not hold them
    expect(index).toContain(SECRET_DRAFT)
    expect(open([...h.turnIo.files.values()][0]!)).toContain(PRIVATE_TURN_TEXT)
    expect([...h.turnIo.files.keys()][0]).toContain(id)
  })

  it("keeps another owner's and another tenant's records in the file untouched and never shows them", async () => {
    const h = harness()
    const service = h.newService()
    const created = await service.open({ assistantId: 'sys-general' })
    if (!created.ok) throw new Error('open failed')
    const file = `${scopeOf(KEY_A, TENANT_1).partitionId}/index`
    // Plant a record of another owner and of another tenant in this partition file.
    const planted = JSON.parse(open(h.indexIo.files.get(file)!))
    const foreign = (ownerKey: string, tenantKey: string, n: number) => ({
      ...planted.conversations[0],
      id: `c_${String(n).repeat(32)}`,
      ownerKey,
      tenantKey
    })
    planted.conversations.push(foreign(KEY_B, TENANT_1, 7), foreign(KEY_A, TENANT_2, 8))
    h.indexIo.files.set(file, seal(JSON.stringify(planted)))
    const listed = await h.newService().list()
    expect(listed.ok && listed.conversations.map((c) => c.id)).toEqual([created.conversation.id])
    expect(await service.history({ conversationId: `c_${'7'.repeat(32)}`, limit: 5 })).toEqual({
      ok: false,
      reason: 'not-found'
    })
    // A write by the owner keeps the foreign records intact.
    await service.draftSet({ conversationId: created.conversation.id, text: 'x' })
    const after = JSON.parse(open(h.indexIo.files.get(file)!))
    expect(after.conversations.map((c: { id: string }) => c.id)).toContain(`c_${'7'.repeat(32)}`)
    expect(after.conversations.map((c: { id: string }) => c.id)).toContain(`c_${'8'.repeat(32)}`)
    // A document stamped for another tenant is not opened, so it is not overwritten either.
    h.current.scope = { ...scopeOf(KEY_A, TENANT_1), tenantKey: TENANT_2 }
    expect(await h.newService().open({ assistantId: 'sys-general' })).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('clips turns above the index lastSeq after a torn write', () => {
    const doc = {
      v: 1 as const,
      partitionId: 'a'.repeat(24),
      ownerKey: KEY_A,
      tenantKey: TENANT_1,
      conversationId: `c_${'0'.repeat(32)}`,
      turns: [3, 1, 2, 4].map((seq) => ({
        id: `t_${String(seq).repeat(32)}`,
        seq,
        role: 'user' as const,
        text: 'x',
        at: 1
      }))
    }
    expect(committedTurns(doc, 2).map((t) => t.seq)).toEqual([1, 2])
  })
})
