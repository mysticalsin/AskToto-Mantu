import { describe, expect, it, vi } from 'vitest'
import { contextRecord, ownerCommand } from '@shared/context-authority'
import type { ClarifyBinding } from './clarify-protocol'
import { createVoiceTurnPipeline, type VoiceTurnOutcome } from './voice-turn-handler'
import type { VoiceTurnClaim } from './voice-session'

function claimFake(turnId = 'turn-1') {
  let used = false
  const claim: VoiceTurnClaim = {
    turnId,
    valid: () => !used,
    consume: () => {
      if (used) return false
      used = true
      return true
    }
  }
  return claim
}

const GATE = {
  authenticated: true,
  listenEntitled: true,
  ownerPresent: true,
  ownerVisible: true,
  onboardingExclusive: false,
  lifecycleHooksReady: true,
  meetingReserved: false
}

function make(opts: { binding?: () => ClarifyBinding | null; gate?: typeof GATE } = {}) {
  let now = 1_000
  const binding: { current: ClarifyBinding | null } = {
    current: { ownerId: 'wc:7', sessionId: 's1', taskId: 't1' }
  }
  const execute = vi.fn(async (request: { id: string }) => ({ id: request.id, ok: true, outcome: 'unknown' as const }))
  const propose = vi.fn(() => ({ proposalId: 'p'.repeat(32), nonce: 'n'.repeat(64), argsHash: 'h'.repeat(64) }))
  const sendAsk = vi.fn()
  const pipeline = createVoiceTurnPipeline({
    router: { providerReady: () => false },
    executor: {
      platform: 'darwin',
      execute: execute as never,
      propose,
      owner: () => ({ webContentsId: 7, revision: 1 }),
      gate: () => opts.gate ?? GATE
    },
    sendAsk,
    clarify: { binding: opts.binding ?? (() => binding.current), now: () => now, ttlMs: 60_000 }
  })
  return { pipeline, execute, propose, sendAsk, binding, advance: (ms: number) => (now += ms) }
}

const kinds = (o: VoiceTurnOutcome) => o.kind

describe('clarify protocol in the voice turn pipeline (G35)', () => {
  it('prepares reversibly, asks one question, then the answer takes the normal confirm path', async () => {
    const h = make()
    const asked = await h.pipeline.run('create a note', claimFake('t-a'))
    expect(asked).toMatchObject({
      kind: 'clarify',
      question: 'What should the note be called?',
      action: 'desktop.create_note',
      prepared: { status: 'uncertain', actionId: 'desktop.open_notes' }
    })
    // Only the reversible preparation ran: nothing was created or proposed before the answer.
    expect(h.execute).toHaveBeenCalledTimes(1)
    expect(h.execute.mock.calls[0][0]).toMatchObject({ id: 'desktop.open_notes' })
    expect(h.propose).not.toHaveBeenCalled()

    const answered = await h.pipeline.run('Groceries', claimFake('t-b'))
    expect(answered).toMatchObject({
      kind: 'action',
      result: { status: 'needs_confirmation', actionId: 'desktop.create_note', preview: { argument: 'Groceries' } }
    })
    expect(h.propose).toHaveBeenCalledWith({ id: 'desktop.create_note', args: { title: 'Groceries' } })
    expect(h.execute).toHaveBeenCalledTimes(1)
    expect(h.sendAsk).not.toHaveBeenCalled()
  })

  it('a search has no preparation: one question, no side effects before the answer', async () => {
    const h = make()
    expect(kinds(await h.pipeline.run('search', claimFake()))).toBe('clarify')
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.propose).not.toHaveBeenCalled()
  })

  it('a second ambiguity after the answer ends with copy, not another question', async () => {
    const h = make()
    await h.pipeline.run('create a note', claimFake())
    h.execute.mockClear()
    const ended = await h.pipeline.run('y'.repeat(400), claimFake())
    expect(ended).toEqual({
      kind: 'clarify_ended',
      reason: 'gave_up',
      copy: "Métis still couldn't create the note. Nothing was done."
    })
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.propose).not.toHaveBeenCalled()
    // Nothing is pending: the next "create a note" is a fresh request with its own single question.
    expect(kinds(await h.pipeline.run('create a note', claimFake()))).toBe('clarify')
  })

  it('an expired question does nothing when the answer arrives late', async () => {
    const h = make()
    await h.pipeline.run('create a note', claimFake())
    h.execute.mockClear()
    h.advance(60_000)
    expect(await h.pipeline.run('Groceries', claimFake())).toMatchObject({ kind: 'clarify_ended', reason: 'expired' })
    expect(h.propose).not.toHaveBeenCalled()
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('content is not an answer; an answer from another owner window is not either', async () => {
    const h = make()
    await h.pipeline.run('create a note', claimFake())
    const content = await h.pipeline.run(contextRecord('other-speaker', 'Payroll'), claimFake())
    expect(content).toEqual({ kind: 'unsupported' })
    expect(h.propose).not.toHaveBeenCalled()
    h.binding.current = { ownerId: 'wc:9', sessionId: 's1', taskId: 't1' }
    const other = await h.pipeline.run('Groceries', claimFake())
    expect(other).toMatchObject({ kind: 'ask' })
    expect(h.propose).not.toHaveBeenCalled()
  })

  it('stop, sign-out and owner switch drop the pending question', async () => {
    const h = make()
    await h.pipeline.run('create a note', claimFake())
    h.pipeline.dropClarification('stop')
    expect(await h.pipeline.run('Groceries', claimFake())).toMatchObject({ kind: 'ask' })
    expect(h.propose).not.toHaveBeenCalled()
  })

  it('a meeting recording refuses the preparation and asks nothing', async () => {
    const h = make({ gate: { ...GATE, meetingReserved: true } })
    const outcome = await h.pipeline.run('create a note', claimFake())
    expect(outcome).toMatchObject({ kind: 'action', result: { status: 'refused', reason: 'meeting_recording' } })
    expect(await h.pipeline.run('Groceries', claimFake())).toMatchObject({ kind: 'ask' })
  })

  it('without a lineage binding main cannot hold a question: the plain incomplete outcome stays', async () => {
    const h = make({ binding: () => null })
    expect(await h.pipeline.run('create a note', claimFake())).toEqual({ kind: 'incomplete', missing: 'title' })
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('a typed owner answer counts like a spoken one', async () => {
    const h = make()
    await h.pipeline.run('create a note', claimFake())
    const typed = ownerCommand('user-typed', 'Groceries')
    expect(await h.pipeline.run(typed, claimFake())).toMatchObject({
      kind: 'action',
      result: { status: 'needs_confirmation' }
    })
  })
})
