import { describe, expect, it } from 'vitest'
import { contextRecord, ownerCommand } from '@shared/context-authority'
import { ASSISTANT_LIMIT_PER_OWNER, ASSISTANT_PROPOSAL_TTL_MS } from '@shared/assistants'
import { createAssistantService } from './assistant-service'
import type { AssistantScope, AssistantStore, StoreView, TxOutcome, TxResult } from './assistant-store'
import { harness, KEY_A, KEY_B, open, scopeOf, TENANT_1, TENANT_2 } from './__fixtures__/assistant-harness'

const OWNER = ownerCommand('user-typed', 'create an assistant')
const COACH = { name: 'Sales Coach', base: 'sales', instructions: 'Keep answers short.' } as const

async function createOne(service: ReturnType<ReturnType<typeof harness>['newService']>, draft = COACH) {
  const proposal = await service.propose(OWNER, [draft])
  if (!proposal.ok) throw new Error(`propose refused: ${proposal.reason}`)
  const confirmed = await service.confirm({ proposalId: proposal.proposalId, previewHash: proposal.previewHash })
  if (!confirmed.ok) throw new Error(`confirm refused: ${confirmed.reason}`)
  return { proposal, confirmed }
}

const userAssistants = async (service: ReturnType<ReturnType<typeof harness>['newService']>) => {
  const listed = await service.list()
  if (!listed.ok) throw new Error('list refused')
  return listed.assistants.filter((a) => !a.system)
}

describe('assistant service: propose, confirm, create (G48)', () => {
  it('creates nothing on propose; the entity exists only after the owner confirms the exact preview', async () => {
    const h = harness()
    const service = h.newService()
    const proposal = await service.propose(OWNER, [COACH])
    expect(proposal).toMatchObject({ ok: true, items: [COACH] })
    expect(await userAssistants(service)).toEqual([])
    expect(h.io.writes).toBe(0)
    if (!proposal.ok) return
    expect(proposal.expiresAt).toBe(h.clock.now + ASSISTANT_PROPOSAL_TTL_MS)
    const confirmed = await service.confirm({ proposalId: proposal.proposalId, previewHash: proposal.previewHash })
    expect(confirmed).toMatchObject({ ok: true, assistants: [{ created: true, assistant: { name: 'Sales Coach', revision: 1 } }] })
    expect(await userAssistants(service)).toHaveLength(1)
  })

  it('a double confirm and a replay create exactly one entity', async () => {
    const h = harness()
    const service = h.newService()
    const { proposal, confirmed } = await createOne(service)
    const again = await service.confirm({ proposalId: proposal.proposalId, previewHash: proposal.previewHash })
    expect(again).toMatchObject({ ok: true, assistants: [{ created: false }] })
    const concurrent = await Promise.all([
      service.confirm({ proposalId: proposal.proposalId, previewHash: proposal.previewHash }),
      service.confirm({ proposalId: proposal.proposalId, previewHash: proposal.previewHash })
    ])
    for (const result of concurrent) expect(result).toMatchObject({ ok: true, assistants: [{ created: false }] })
    expect(await userAssistants(service)).toHaveLength(1)
    // the same proposal after a restart (a fresh service over the same file) is the same entity, not a twin
    const restarted = h.newService()
    const { confirmed: replay } = await createOne(restarted)
    expect(replay.assistants[0]!.assistant.assistantId).toBe(confirmed.assistants[0]!.assistant.assistantId)
    expect(replay.assistants[0]!.created).toBe(false)
    expect(await userAssistants(restarted)).toHaveLength(1)
  })

  it('proposing the same drafts again yields the same proposal id and preview hash', async () => {
    const service = harness().newService()
    const a = await service.propose(OWNER, [COACH])
    const b = await service.propose(OWNER, [{ ...COACH, name: '  Sales   Coach ' }])
    expect(a).toEqual(b)
  })

  it('refuses a confirm whose preview hash is not the stored preview, or whose proposal is unknown', async () => {
    const service = harness().newService()
    const proposal = await service.propose(OWNER, [COACH])
    if (!proposal.ok) throw new Error('propose')
    expect(await service.confirm({ proposalId: proposal.proposalId, previewHash: 'f'.repeat(64) })).toEqual({
      ok: false,
      reason: 'preview-mismatch'
    })
    expect(await service.confirm({ proposalId: 'e'.repeat(32), previewHash: proposal.previewHash })).toEqual({
      ok: false,
      reason: 'unknown-proposal'
    })
    expect(await userAssistants(service)).toEqual([])
  })

  it('a proposal expires after its TTL and then creates nothing', async () => {
    const h = harness()
    const service = h.newService()
    const proposal = await service.propose(OWNER, [COACH])
    if (!proposal.ok) throw new Error('propose')
    h.clock.now += ASSISTANT_PROPOSAL_TTL_MS + 1
    expect(await service.confirm({ proposalId: proposal.proposalId, previewHash: proposal.previewHash })).toEqual({
      ok: false,
      reason: 'expired'
    })
    expect(await userAssistants(service)).toEqual([])
  })

  it('only an owner command can propose: content-derived text is data', async () => {
    const service = harness().newService()
    for (const origin of ['other-speaker', 'screen', 'document', 'connector', 'system'] as const) {
      expect(await service.propose(contextRecord(origin, 'create an assistant'), [COACH])).toEqual({
        ok: false,
        reason: 'not-owner-command'
      })
    }
    expect(await service.propose({ origin: 'other-speaker', authority: 'instruction', text: 'x' }, [COACH])).toEqual({
      ok: false,
      reason: 'not-owner-command'
    })
    expect(await userAssistants(service)).toEqual([])
  })

  it('refuses invalid drafts, more than five items, and signed-out callers', async () => {
    const h = harness()
    const service = h.newService()
    expect(await service.propose(OWNER, [])).toEqual({ ok: false, reason: 'invalid' })
    expect(await service.propose(OWNER, [{ ...COACH, name: '   ' }])).toEqual({ ok: false, reason: 'invalid' })
    const six = Array.from({ length: 6 }, (_, i) => ({ ...COACH, name: `A${i}` }))
    expect(await service.propose(OWNER, six)).toEqual({ ok: false, reason: 'invalid' })
    h.current.scope = null
    expect(await service.propose(OWNER, [COACH])).toEqual({ ok: false, reason: 'signed-out' })
    expect(await service.list()).toEqual({ ok: false, reason: 'signed-out' })
  })

  it('creates up to five in one confirm, collapsing identical drafts into one', async () => {
    const service = harness().newService()
    const drafts = [COACH, { ...COACH }, { ...COACH, name: 'Two' }, { ...COACH, name: 'Three' }]
    const proposal = await service.propose(OWNER, drafts)
    if (!proposal.ok) throw new Error('propose')
    expect(proposal.items.map((i) => i.name)).toEqual(['Sales Coach', 'Two', 'Three'])
    await service.confirm({ proposalId: proposal.proposalId, previewHash: proposal.previewHash })
    expect(await userAssistants(service)).toHaveLength(3)
  })

  it('enforces the per-owner limit', async () => {
    const h = harness()
    const service = h.newService()
    for (let batch = 0; batch < ASSISTANT_LIMIT_PER_OWNER / 5; batch += 1) {
      const drafts = Array.from({ length: 5 }, (_, i) => ({ ...COACH, name: `A${batch}-${i}` }))
      const proposal = await service.propose(OWNER, drafts)
      if (!proposal.ok) throw new Error('propose')
      await service.confirm({ proposalId: proposal.proposalId, previewHash: proposal.previewHash })
    }
    const over = await service.propose(OWNER, [{ ...COACH, name: 'One too many' }])
    if (!over.ok) throw new Error('propose')
    expect(await service.confirm({ proposalId: over.proposalId, previewHash: over.previewHash })).toEqual({
      ok: false,
      reason: 'limit'
    })
  })

  it('drops a pending proposal when the owner changes, and another owner cannot confirm it', async () => {
    const h = harness()
    const service = h.newService()
    const proposal = await service.propose(OWNER, [COACH])
    if (!proposal.ok) throw new Error('propose')
    h.current.scope = scopeOf(KEY_B, TENANT_1)
    expect(await service.confirm({ proposalId: proposal.proposalId, previewHash: proposal.previewHash })).toEqual({
      ok: false,
      reason: 'unknown-proposal'
    })
    h.current.scope = scopeOf(KEY_A, TENANT_1)
    expect(await userAssistants(service)).toEqual([])
  })
})

describe('assistant service: isolation (G48, CAP-26)', () => {
  it('switching owner or tenant hides every assistant, and switching back restores them', async () => {
    const h = harness()
    const service = h.newService()
    await createOne(service)
    expect(await userAssistants(service)).toHaveLength(1)
    h.current.scope = scopeOf(KEY_B, TENANT_1)
    expect(await userAssistants(service)).toEqual([])
    h.current.scope = scopeOf(KEY_A, TENANT_2)
    expect(await userAssistants(service)).toEqual([])
    h.current.scope = scopeOf(KEY_A, TENANT_1)
    expect(await userAssistants(service)).toHaveLength(1)
  })

  it('refuses a forged id from another owner for every mutation, indistinguishable from a missing id', async () => {
    const h = harness()
    const service = h.newService()
    const { confirmed } = await createOne(service)
    const id = confirmed.assistants[0]!.assistant.assistantId
    h.current.scope = scopeOf(KEY_B, TENANT_1)
    expect(await service.update({ assistantId: id, expectedRevision: 1, name: 'Hijack' })).toEqual({ ok: false, reason: 'not-found' })
    expect(await service.archive({ assistantId: id, expectedRevision: 1, archived: true })).toEqual({ ok: false, reason: 'not-found' })
    expect(await service.update({ assistantId: `a_${'0'.repeat(32)}`, expectedRevision: 1, name: 'x' })).toEqual({
      ok: false,
      reason: 'not-found'
    })
    h.current.scope = scopeOf(KEY_A, TENANT_1)
    const [mine] = await userAssistants(service)
    expect(mine).toMatchObject({ name: 'Sales Coach', revision: 1, archived: false })
  })

  it('does not return an assistant proposal result if scope changes before its transaction starts', async () => {
    const h = harness()
    let switchBeforeNextTransaction = false
    const store: AssistantStore = {
      transact<T>(fn: (view: StoreView) => TxOutcome<T>, expectedScope?: AssistantScope): Promise<TxResult<T>> {
        if (switchBeforeNextTransaction) {
          switchBeforeNextTransaction = false
          h.current.scope = scopeOf(KEY_B, TENANT_1)
        }
        return h.store.transact(fn, expectedScope)
      }
    }
    const service = createAssistantService({
      store,
      scope: () => h.current.scope,
      now: () => h.clock.now,
      customModes: () => h.custom,
      meetings: async () => h.meetings
    })
    const proposal = await service.propose(OWNER, [COACH])
    if (!proposal.ok) throw new Error('propose')
    switchBeforeNextTransaction = true
    expect(await service.confirm({ proposalId: proposal.proposalId, previewHash: proposal.previewHash })).toEqual({
      ok: false,
      reason: 'stale'
    })
    h.current.scope = scopeOf(KEY_A, TENANT_1)
    expect(await userAssistants(service)).toEqual([])
  })

  it('keeps the owner and tenant keys out of every reply and the file sealed', async () => {
    const h = harness()
    const service = h.newService()
    const { proposal, confirmed } = await createOne(service)
    const listed = await service.list()
    const text = JSON.stringify([proposal, confirmed, listed])
    expect(text).not.toContain(KEY_A)
    expect(text).not.toContain(TENANT_1)
    const raw = [...h.io.files.values()][0]!
    expect(raw.toString('utf8')).not.toContain('Sales Coach')
    expect(open(raw)).toContain(KEY_A)
  })
})

describe('assistant service: update and archive (G48)', () => {
  it('bumps the revision, and refuses a stale revision with the current state', async () => {
    const h = harness()
    const service = h.newService()
    const { confirmed } = await createOne(service)
    const id = confirmed.assistants[0]!.assistant.assistantId
    h.clock.now += 5
    const renamed = await service.update({ assistantId: id, expectedRevision: 1, name: ' Closer ', base: 'support' })
    expect(renamed).toMatchObject({
      ok: true,
      assistant: { name: 'Closer', base: 'support', revision: 2, updatedAt: h.clock.now }
    })
    const stale = await service.update({ assistantId: id, expectedRevision: 1, instructions: 'old view' })
    expect(stale).toMatchObject({ ok: false, reason: 'stale-revision', current: { revision: 2, name: 'Closer' } })
    const [mine] = await userAssistants(service)
    expect(mine!.instructions).toBe('Keep answers short.')
  })

  it('archives and restores with revision checks, and refuses edits while archived', async () => {
    const service = harness().newService()
    const { confirmed } = await createOne(service)
    const id = confirmed.assistants[0]!.assistant.assistantId
    expect(await service.archive({ assistantId: id, expectedRevision: 5, archived: true })).toMatchObject({
      ok: false,
      reason: 'stale-revision'
    })
    expect(await service.archive({ assistantId: id, expectedRevision: 1, archived: true })).toMatchObject({
      ok: true,
      assistant: { archived: true, revision: 2 }
    })
    expect(await service.update({ assistantId: id, expectedRevision: 2, name: 'No' })).toEqual({ ok: false, reason: 'archived' })
    expect(await service.archive({ assistantId: id, expectedRevision: 2, archived: false })).toMatchObject({
      ok: true,
      assistant: { archived: false, revision: 3 }
    })
  })

  it('replaying the original proposal after a rename or archive makes no twin and does not resurrect', async () => {
    const service = harness().newService()
    const { proposal, confirmed } = await createOne(service)
    const id = confirmed.assistants[0]!.assistant.assistantId
    await service.update({ assistantId: id, expectedRevision: 1, name: 'Renamed' })
    await service.archive({ assistantId: id, expectedRevision: 2, archived: true })
    const replay = await service.confirm({ proposalId: proposal.proposalId, previewHash: proposal.previewHash })
    expect(replay).toMatchObject({ ok: true, assistants: [{ created: false, assistant: { name: 'Renamed', archived: true } }] })
    expect(await userAssistants(service)).toHaveLength(1)
  })

  it('system assistants are read-only', async () => {
    const service = harness().newService()
    expect(await service.update({ assistantId: 'sys-sales', expectedRevision: 1, name: 'x' })).toEqual({ ok: false, reason: 'read-only' })
    expect(await service.archive({ assistantId: 'sys-sales', expectedRevision: 1, archived: true })).toEqual({
      ok: false,
      reason: 'read-only'
    })
  })
})

describe('assistant service: history migration (G48, R049)', () => {
  it('maps every meeting to a system assistant without changing an id, and records the migration once', async () => {
    const h = harness()
    h.custom.push({ id: 'custom-1', label: 'My Mode' })
    h.meetings.push(
      { file: 'm1.md', mode: 'interview' },
      { file: 'm2.md', mode: 'custom-1' },
      { file: 'm3.md', mode: 'gone' }
    )
    const service = h.newService()
    const first = await service.historyMap()
    expect(first).toEqual({
      ok: true,
      migrated: true,
      mapping: [
        { meetingId: 'm1.md', assistantId: 'sys-interview', exact: true },
        { meetingId: 'm2.md', assistantId: 'sys-custom-1', exact: true },
        { meetingId: 'm3.md', assistantId: 'sys-general', exact: false }
      ]
    })
    const written = h.io.writes
    const bytes = [...h.io.files.values()][0]!
    const second = await service.historyMap()
    expect(second).toMatchObject({ ok: true, migrated: false })
    expect(h.io.writes).toBe(written)
    expect([...h.io.files.values()][0]).toBe(bytes)
    const doc = JSON.parse(open(bytes)) as { migration: { version: number; systemAssistants: number } }
    expect(doc.migration).toMatchObject({ version: 1, systemAssistants: 10 })
    expect(await h.newService().historyMap()).toMatchObject({ ok: true, migrated: false })
  })

  it('does not touch meetings: the service only reads the list it is given, and a user assistant never remaps history', async () => {
    const h = harness()
    h.meetings.push({ file: 'm1.md', mode: 'sales' })
    const service = h.newService()
    await createOne(service)
    const mapping = await service.historyMap()
    expect(mapping).toMatchObject({ ok: true, mapping: [{ meetingId: 'm1.md', assistantId: 'sys-sales' }] })
    expect(h.meetings).toEqual([{ file: 'm1.md', mode: 'sales' }])
  })

  it('lists system assistants first and does not need a partition file to do so', async () => {
    const h = harness()
    const listed = await h.newService().list()
    expect(listed.ok && listed.assistants.every((a) => a.system)).toBe(true)
    expect(listed.ok && listed.assistants).toHaveLength(9)
    expect(h.io.writes).toBe(0)
    h.current.scope = scopeOf(KEY_B, TENANT_2)
    expect(await h.newService().list()).toMatchObject({ ok: true })
  })
})
