import { describe, expect, it, vi } from 'vitest'
import { VoiceAskSchema } from '@shared/voice/voice-turn'
import type { VoiceActionExecutorDeps } from './voice-action-executor'
import { createVoiceTurnPipeline, type VoiceTurnOutcome } from './voice-turn-handler'
import type { VoiceTurnClaim } from './voice-session'

function claimFake() {
  let valid = true
  let used = false
  const claim: VoiceTurnClaim = {
    turnId: 'turn-1',
    valid: () => valid && !used,
    consume: () => {
      if (!valid || used) return false
      used = true
      return true
    }
  }
  return { claim, revoke: () => (valid = false) }
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

function make(options: { providerReady?: boolean; execute?: VoiceActionExecutorDeps['execute'] } = {}) {
  const sendAsk = vi.fn()
  const audit = vi.fn()
  const outcomes: VoiceTurnOutcome[] = []
  const execute =
    options.execute ?? vi.fn(async (request) => ({ id: request.id, ok: true, outcome: 'unknown' as const }))
  const propose = vi.fn(() => ({ proposalId: 'p'.repeat(32), nonce: 'n'.repeat(64), argsHash: 'h'.repeat(64) }))
  const pipeline = createVoiceTurnPipeline({
    router: { providerReady: () => options.providerReady ?? false },
    executor: {
      platform: 'darwin',
      execute,
      propose,
      owner: () => ({ webContentsId: 7, revision: 1 }),
      gate: () => GATE
    },
    sendAsk,
    onOutcome: (outcome) => void outcomes.push(outcome),
    audit
  })
  return { pipeline, sendAsk, audit, outcomes, execute, propose }
}

describe('voice turn pipeline', () => {
  it('routes an action to the executor and reports its typed outcome', async () => {
    const h = make()
    const outcome = await h.pipeline.run('open notes', claimFake().claim)
    expect(outcome).toMatchObject({ kind: 'action', result: { status: 'uncertain', actionId: 'desktop.open_notes' } })
    expect(h.sendAsk).not.toHaveBeenCalled()
  })

  it('a create request is a needsConfirmation decision and a pending proposal, not an execution', async () => {
    const h = make()
    const outcome = await h.pipeline.run('create a note called Groceries', claimFake().claim)
    expect(outcome).toMatchObject({
      kind: 'action',
      result: {
        status: 'needs_confirmation',
        actionId: 'desktop.create_note',
        preview: { title: 'Create a note in Notes', argument: 'Groceries' }
      }
    })
    expect(h.propose).toHaveBeenCalledWith({ id: 'desktop.create_note', args: { title: 'Groceries' } })
    expect(h.execute).not.toHaveBeenCalled()
  })

  it("a question goes to the renderer's Ask path as a schema-valid message, once", async () => {
    const h = make()
    const { claim } = claimFake()
    expect(await h.pipeline.run('what is the capital of Portugal', claim)).toEqual({ kind: 'ask', delivered: true })
    expect(h.sendAsk).toHaveBeenCalledTimes(1)
    expect(VoiceAskSchema.safeParse(h.sendAsk.mock.calls[0][0]).success).toBe(true)
    expect(h.sendAsk.mock.calls[0][0]).toEqual({ turnId: 'turn-1', text: 'what is the capital of Portugal' })
    // The claim is spent: the same turn cannot ask or act again.
    expect(await h.pipeline.run('what is the capital of Portugal', claim)).toEqual({ kind: 'stale' })
    expect(h.sendAsk).toHaveBeenCalledTimes(1)
  })

  it('a question too long for the Ask contract is dropped, not truncated or sent as an action', async () => {
    const h = make()
    const outcome = await h.pipeline.run(`what ${'is this '.repeat(300)}`, claimFake().claim)
    expect(outcome).toEqual({ kind: 'ask', delivered: false })
    expect(h.sendAsk).not.toHaveBeenCalled()
  })

  it('unsupported, incomplete and cancelled requests do nothing and say so', async () => {
    const h = make()
    expect(await h.pipeline.run('delete my email', claimFake().claim)).toEqual({ kind: 'unsupported' })
    expect(await h.pipeline.run('create a note', claimFake().claim)).toEqual({ kind: 'incomplete', missing: 'title' })
    expect(await h.pipeline.run('never mind', claimFake().claim)).toEqual({ kind: 'cancelled' })
    expect(h.sendAsk).not.toHaveBeenCalled()
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.propose).not.toHaveBeenCalled()
  })

  it('a turn revoked while routing does nothing at all', async () => {
    const h = make()
    const revoked = claimFake()
    revoked.revoke()
    expect(await h.pipeline.run('open notes', revoked.claim)).toEqual({ kind: 'stale' })
    expect(await h.pipeline.run('what is love', revoked.claim)).toEqual({ kind: 'stale' })
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.sendAsk).not.toHaveBeenCalled()
  })

  it('handle is fire-and-forget: it reports the outcome to the subscriber and never throws', async () => {
    const h = make()
    h.pipeline.handle('open notes', claimFake().claim)
    await vi.waitFor(() => expect(h.outcomes).toHaveLength(1))
    expect(h.outcomes[0].kind).toBe('action')

    const throwing = createVoiceTurnPipeline({
      router: { providerReady: () => false },
      executor: {
        platform: 'darwin',
        execute: vi.fn(),
        propose: () => null,
        owner: () => ({ webContentsId: 7, revision: 1 }),
        gate: () => GATE
      },
      sendAsk: () => {
        throw new Error('renderer gone')
      },
      onOutcome: () => {
        throw new Error('subscriber bug')
      }
    })
    expect(() => throwing.handle('what is this', claimFake().claim)).not.toThrow()
  })

  it("the audit trail carries statuses and classes only, never the person's words", async () => {
    const h = make()
    await h.pipeline.run('create a note called Synthetic private words', claimFake().claim)
    await h.pipeline.run('what is synthetic private words', claimFake().claim)
    await h.pipeline.run('delete synthetic private words', claimFake().claim)
    expect(JSON.stringify(h.audit.mock.calls).toLowerCase()).not.toContain('synthetic')
    expect(h.audit.mock.calls.map(([event]) => event)).toEqual(['voice.action', 'voice.action', 'voice.action'])
  })
})
