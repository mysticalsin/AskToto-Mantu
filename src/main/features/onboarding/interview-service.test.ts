import { describe, expect, it } from 'vitest'
import { draftsFromAnswers, type InterviewAnswers, type InterviewDraft } from '@shared/onboarding-interview'
import { createAssistantService, createAssistantStore } from '../assistants'
import { createInterviewService, createInterviewStore, type InterviewAuditPhase } from '.'

// Local copies of the G48 harness shapes: a feature's fixtures stay inside that feature.
const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)
const TENANT_1 = '1'.repeat(64)
const TENANT_2 = '2'.repeat(64)
const scopeOf = (ownerKey: string, tenantKey: string) => ({
  partitionId: `${ownerKey.slice(0, 2)}${tenantKey.slice(0, 2)}`.repeat(6),
  ownerKey,
  tenantKey
})
/** A reversible, non-plaintext seal: enough to prove nothing readable reaches the io. */
const seal = (plain: string): Buffer => Buffer.from(Buffer.from(plain, 'utf8').map((byte) => byte ^ 0x5a))
const open = (sealed: Buffer): string => Buffer.from(sealed.map((byte) => byte ^ 0x5a)).toString('utf8')
function memoryIo() {
  const files = new Map<string, Buffer>()
  return {
    files,
    async read(partitionId: string) {
      return files.get(partitionId) ?? null
    },
    async write(partitionId: string, data: Buffer) {
      files.set(partitionId, data)
    }
  }
}

const ANSWERS: InterviewAnswers = { role: 'consulting', meetings: ['client'], outcome: 'actions', tone: 'brief' }

function rig() {
  const assistantIo = memoryIo()
  const interviewIo = memoryIo()
  const current = { scope: scopeOf(KEY_A, TENANT_1) as ReturnType<typeof scopeOf> | null }
  const clock = { now: 1_000_000 }
  const audits: Array<{ phase: InterviewAuditPhase; detail: Record<string, unknown> }> = []
  const failNextInterviewWrite = { on: false }
  const io = {
    ...interviewIo,
    read: interviewIo.read,
    async write(partitionId: string, data: Buffer) {
      if (failNextInterviewWrite.on) {
        failNextInterviewWrite.on = false
        throw new Error('crash')
      }
      await interviewIo.write(partitionId, data)
    }
  }
  /** A fresh process: new in-memory proposal maps, same files on disk. */
  const boot = () => {
    const assistants = createAssistantService({
      store: createAssistantStore({ io: assistantIo, seal, open, scope: () => current.scope }),
      scope: () => current.scope,
      now: () => clock.now,
      customModes: () => [],
      meetings: async () => []
    })
    const interview = createInterviewService({
      store: createInterviewStore({ io, seal, open, scope: () => current.scope }),
      scope: () => current.scope,
      assistants,
      now: () => clock.now,
      audit: (phase, detail) => audits.push({ phase, detail })
    })
    return { assistants, interview }
  }
  const ownCount = async (assistants: ReturnType<typeof boot>['assistants']) => {
    const list = await assistants.list()
    return list.ok ? list.assistants.filter((a) => !a.system).length : -1
  }
  return { assistantIo, interviewIo, current, clock, audits, failNextInterviewWrite, boot, ownCount }
}

async function proposeAndConfirm(
  interview: ReturnType<ReturnType<typeof rig>['boot']>['interview'],
  drafts: InterviewDraft[]
) {
  const proposed = await interview.propose({ drafts })
  if (!proposed.ok) throw new Error(`propose refused: ${proposed.reason}`)
  return interview.confirm({ proposalId: proposed.proposalId, previewHash: proposed.previewHash })
}

describe('onboarding interview service (G56, R005/R006)', () => {
  it('resumes after a restart at the same step with the same answers', async () => {
    const r = rig()
    const first = r.boot().interview
    const saved = await first.save({
      status: 'in-progress',
      step: 2,
      answers: { role: 'sales', meetings: ['client'] },
      drafts: []
    })
    expect(saved.ok).toBe(true)
    const loaded = await r.boot().interview.load()
    expect(loaded.ok && loaded.view).toMatchObject({
      status: 'in-progress',
      step: 2,
      answers: { role: 'sales', meetings: ['client'] }
    })
    // sealed: nothing readable on disk
    for (const bytes of r.interviewIo.files.values()) expect(bytes.toString('utf8')).not.toContain('sales')
  })

  it('re-proposing saved drafts after a restart creates no duplicates', async () => {
    const r = rig()
    const drafts = draftsFromAnswers(ANSWERS)
    const a = r.boot()
    expect((await proposeAndConfirm(a.interview, drafts)).ok).toBe(true)
    const b = r.boot()
    const again = await proposeAndConfirm(b.interview, drafts)
    expect(again.ok && again.createdCount).toBe(0)
    expect(await r.ownCount(b.assistants)).toBe(3)
  })

  it('a crash between creating assistants and saving the interview leaves one set of assistants', async () => {
    const r = rig()
    const drafts = draftsFromAnswers(ANSWERS)
    const a = r.boot()
    const proposed = await a.interview.propose({ drafts })
    expect(proposed.ok).toBe(true)
    if (!proposed.ok) return
    // the assistants are created, then the process dies before the interview state is saved
    r.failNextInterviewWrite.on = true
    const crashed = await a.interview.confirm({ proposalId: proposed.proposalId, previewHash: proposed.previewHash })
    expect(crashed.ok).toBe(false)
    const b = r.boot()
    const resumed = await proposeAndConfirm(b.interview, drafts)
    expect(resumed.ok).toBe(true)
    expect(await r.ownCount(b.assistants)).toBe(3)
    const loaded = await b.interview.load()
    expect(loaded.ok && loaded.view.status).toBe('complete')
    expect(loaded.ok && loaded.view.createdIds).toHaveLength(3)
  })

  it('records each assistant once in the setup bucket across replays', async () => {
    const r = rig()
    const drafts = draftsFromAnswers(ANSWERS)
    await proposeAndConfirm(r.boot().interview, drafts)
    await proposeAndConfirm(r.boot().interview, drafts)
    const loaded = await r.boot().interview.load()
    expect(loaded.ok && loaded.meter).toEqual({
      bucket: 'setup',
      assistantsCreated: 3,
      interviewsCompleted: 1,
      workAllowanceStartsAt: null
    })
  })

  it('confirm writes only the setup bucket: the doc has no work meter', async () => {
    const r = rig()
    await proposeAndConfirm(r.boot().interview, draftsFromAnswers(ANSWERS))
    const [bytes] = [...r.interviewIo.files.values()]
    const doc = JSON.parse(open(bytes!)) as Record<string, unknown>
    expect(Object.keys(doc).sort()).toEqual(['interview', 'meter', 'ownerKey', 'partitionId', 'tenantKey', 'v'])
    expect(Object.keys(doc.meter as object).sort()).toEqual(['entries', 'workAllowanceStartsAt'])
    expect(JSON.stringify(doc.meter)).not.toMatch(/work"?:\s*\d|"kind":"(?!assistant-created|interview-completed)/)
  })

  it('another owner or tenant cannot load the doc', async () => {
    const r = rig()
    await r.boot().interview.save({ status: 'in-progress', step: 1, answers: { role: 'sales' }, drafts: [] })
    const partitionId = scopeOf(KEY_A, TENANT_1).partitionId
    for (const [ownerKey, tenantKey] of [
      [KEY_B, TENANT_1],
      [KEY_A, TENANT_2]
    ] as const) {
      r.current.scope = { partitionId, ownerKey, tenantKey }
      expect(await r.boot().interview.load()).toEqual({ ok: false, reason: 'unavailable' })
    }
    r.current.scope = null
    expect(await r.boot().interview.load()).toEqual({ ok: false, reason: 'signed-out' })
  })

  it('audit details carry phase tokens and counts only, never answer text', async () => {
    const r = rig()
    const i = r.boot().interview
    const answers = { role: 'other', roleOther: 'Secret Project Falcon' } as const
    await i.save({ status: 'in-progress', step: 1, answers, drafts: [] })
    await proposeAndConfirm(i, draftsFromAnswers(answers))
    const text = JSON.stringify(r.audits)
    expect(text).not.toContain('Falcon')
    expect(text).not.toMatch(/Meeting notes|Everyday helper/)
    for (const entry of r.audits)
      for (const key of Object.keys(entry.detail)) expect(['reason', 'count']).toContain(key)
  })

  it('sets workAllowanceStartsAt once; replay does not move it', async () => {
    const r = rig()
    const i = r.boot().interview
    const first = await i.setupEnded()
    expect(first).toEqual({ ok: true, workAllowanceStartsAt: 1_000_000 })
    r.clock.now = 2_000_000
    expect(await r.boot().interview.setupEnded()).toEqual({ ok: true, workAllowanceStartsAt: 1_000_000 })
  })

  it('discard clears a half-done interview but keeps a completed one', async () => {
    const r = rig()
    const i = r.boot().interview
    await i.save({ status: 'in-progress', step: 3, answers: ANSWERS, drafts: [] })
    const cleared = await i.discard()
    expect(cleared.ok && cleared.view).toEqual({
      status: 'in-progress',
      step: 0,
      answers: {},
      drafts: [],
      createdIds: []
    })
    await proposeAndConfirm(i, draftsFromAnswers(ANSWERS))
    const kept = await i.discard()
    expect(kept.ok && kept.view.status).toBe('complete')
    expect(await r.ownCount(r.boot().assistants)).toBe(3)
  })

  it('proposes only included drafts and refuses when none is included', async () => {
    const r = rig()
    const i = r.boot().interview
    const drafts = draftsFromAnswers(ANSWERS).map((d, index) => ({ ...d, include: index === 0 }))
    const proposed = await i.propose({ drafts })
    expect(proposed.ok && proposed.items).toHaveLength(1)
    const none = await i.propose({ drafts: drafts.map((d) => ({ ...d, include: false })) })
    expect(none).toEqual({ ok: false, reason: 'nothing-included' })
    expect(await i.save({ status: 'complete', step: 4, answers: {}, drafts: [] } as never)).toEqual({
      ok: false,
      reason: 'invalid'
    })
  })
})
