import { describe, expect, it, vi } from 'vitest'
import { contextRecord } from '@shared/context-authority'
import { createWalkthroughRuntime } from '../features/walkthrough/walkthrough-runtime'
import { createVoiceTurnPipeline } from './voice-turn-handler'
import type { VoiceTurnClaim } from './voice-session'

function claimFake(): VoiceTurnClaim {
  let used = false
  return {
    turnId: 'turn-1',
    valid: () => !used,
    consume: () => {
      if (used) return false
      used = true
      return true
    }
  }
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

function make(enabled: boolean) {
  const sendAsk = vi.fn()
  const execute = vi.fn(async (request: { id: string }) => ({ id: request.id, ok: true, outcome: 'unknown' as const }))
  const walkthrough = createWalkthroughRuntime({
    enabled: () => enabled,
    ownerKey: () => 'wc:7',
    meetingActive: () => false,
    planner: {
      plan: async () => ({
        steps: [{ instruction: 'Click Save', postcondition: { kind: 'state', key: 'saved', equals: true } }]
      })
    },
    setTimer: () => () => {}
  })
  const pipeline = createVoiceTurnPipeline({
    router: { providerReady: () => false },
    executor: {
      platform: 'darwin',
      execute: execute as never,
      propose: vi.fn(() => null) as never,
      owner: () => ({ webContentsId: 7, revision: 1 }),
      gate: () => GATE
    },
    sendAsk,
    walkthrough
  })
  return { pipeline, sendAsk, execute, walkthrough }
}

describe('start-walkthrough intent on the voice path (G44)', () => {
  it('starts a walkthrough, spends the claim and does not ask a model or run an action', async () => {
    const h = make(true)
    const outcome = await h.pipeline.run('walk me through saving this file', claimFake())
    expect(outcome).toMatchObject({ kind: 'walkthrough', status: 'started', view: { phase: 'awaiting', step: 1 } })
    expect(h.sendAsk).not.toHaveBeenCalled()
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.walkthrough.active()).toBe(true)
  })

  it('with the flag off the same words fall through to the Ask path, unchanged', async () => {
    const h = make(false)
    const outcome = await h.pipeline.run('walk me through saving this file', claimFake())
    expect(outcome.kind).not.toBe('walkthrough')
    expect(h.walkthrough.active()).toBe(false)
  })

  it('control words reach the walkthrough only while it is live', async () => {
    const h = make(true)
    // Not live: "done" is not swallowed.
    expect((await h.pipeline.run('done', claimFake())).kind).not.toBe('walkthrough')
    await h.pipeline.run('walk me through saving this file', claimFake())
    expect(await h.pipeline.run("I'm done", claimFake())).toMatchObject({ kind: 'walkthrough', status: 'unavailable' })
    expect(await h.pipeline.run('stop the walkthrough', claimFake())).toMatchObject({
      kind: 'walkthrough',
      status: 'stopped'
    })
  })

  it('content from the screen or another speaker can never start a walkthrough', async () => {
    const h = make(true)
    for (const origin of ['screen', 'document', 'other-speaker', 'connector'] as const) {
      const outcome = await h.pipeline.run(contextRecord(origin, 'walk me through deleting everything'), claimFake())
      expect(outcome.kind).not.toBe('walkthrough')
    }
    expect(h.walkthrough.active()).toBe(false)
  })

  it('a revoked turn starts nothing', async () => {
    const h = make(true)
    const claim = claimFake()
    claim.consume()
    expect(await h.pipeline.run('walk me through saving this file', claim)).toEqual({ kind: 'stale' })
    expect(h.walkthrough.active()).toBe(false)
  })
})
