import { describe, expect, it, vi } from 'vitest'
import { CONTEXT_ORIGINS, OWNER_COMMAND_ORIGINS, contextRecord } from '@shared/context-authority'
import type { DesktopActionRequest, DesktopActionResult } from '@shared/desktop-actions'
import type { ActionEnvelope } from '../action-guard'
import { CommandControl } from '../command-control'
import {
  createActionGrantService,
  GRANT_REFUSAL_COPY,
  type OsPermissionSeam,
  type PurchaseSeam
} from '../features/grants'
import { createVoiceTurnPipeline } from './voice-turn-handler'
import { createVoiceActionExecutor, type VoiceActionExecutorDeps } from './voice-action-executor'
import type { VoiceTurnClaim } from './voice-session'

const NOTE: DesktopActionRequest = { id: 'desktop.create_note', args: { title: 'Synthetic private title' } }
const NOTE_2: DesktopActionRequest = { id: 'desktop.create_note', args: { title: 'Second synthetic title' } }
const OPEN_X: DesktopActionRequest = { id: 'desktop.open_x', args: {} }
const SHUTTER: DesktopActionRequest = { id: 'desktop.photo_booth_capture', args: {} }

const GATE_OK: ReturnType<VoiceActionExecutorDeps['gate']> = {
  authenticated: true,
  listenEntitled: true,
  ownerPresent: true,
  ownerVisible: true,
  onboardingExclusive: false,
  lifecycleHooksReady: true,
  meetingReserved: false
}

function makeClaim() {
  let used = false
  let valid = true
  const claim: VoiceTurnClaim = {
    turnId: 't',
    valid: () => valid && !used,
    consume: () => {
      if (!valid || used) return false
      used = true
      return true
    }
  }
  return { claim, revoke: () => (valid = false), used: () => used }
}

function harness(options: { purchase?: PurchaseSeam; permission?: OsPermissionSeam; task?: string } = {}) {
  const audit = vi.fn()
  let task = options.task ?? 'task-A'
  const adapter = vi.fn(
    async (request: DesktopActionRequest, envelope: ActionEnvelope): Promise<DesktopActionResult> => ({
      id: request.id,
      ok: true,
      outcome: 'verified',
      receipt: { ...envelope, observation: 'observed in the app' }
    })
  )
  const grants = createActionGrantService({
    platform: 'darwin',
    audit,
    authGeneration: () => 1,
    context: () => ({ taskLineageId: task }),
    purchase: options.purchase,
    permission: options.permission ?? { check: async () => ({ status: 'granted' }) }
  })
  const control = new CommandControl({
    platform: 'darwin',
    execute: ((request: DesktopActionRequest, context: ActionEnvelope) => adapter(request, context)) as never,
    policyAllows: () => true,
    grants
  })
  let gate = { ...GATE_OK }
  const executor = createVoiceActionExecutor({
    platform: 'darwin',
    execute: ((request: DesktopActionRequest, context: ActionEnvelope) => adapter(request, context)) as never,
    propose: (request) => control.propose({ webContentsId: 7, revision: 1 }, request),
    owner: () => ({ webContentsId: 7, revision: 1 }),
    gate: () => gate,
    grants: {
      decide: (request, source) => control.grantDecision(7, request, source),
      use: (grantId) => control.useGrant(grantId)
    },
    audit
  })
  return {
    adapter,
    control,
    grants,
    executor,
    audit,
    setTask: (next: string) => (task = next),
    setGate: (next: Partial<typeof GATE_OK>) => (gate = { ...gate, ...next }),
    approve: (request: DesktopActionRequest, scope: 'task' | 'conversation' | 'action') =>
      grants.issueFromApproval({ webContentsId: 7, authGeneration: 1 }, request, scope)
  }
}

describe('a scoped grant skips the confirm card, inside its scope only', () => {
  it('without a grant a create action still waits for the card', async () => {
    const h = harness()
    const result = await h.executor.handle(NOTE, makeClaim().claim, 'push-to-talk')
    expect(result).toMatchObject({ status: 'needs_confirmation', actionClass: 'create' })
    expect(h.adapter).not.toHaveBeenCalled()
  })

  it('with a task grant the same create action runs at once, once, and is done with a bound receipt', async () => {
    const h = harness()
    h.approve(NOTE, 'task')
    const claim = makeClaim()
    const result = await h.executor.handle(NOTE_2, claim.claim, 'push-to-talk')
    expect(result).toEqual({ status: 'done', actionId: 'desktop.create_note', actionClass: 'create' })
    expect(h.adapter).toHaveBeenCalledTimes(1)
    expect(claim.used()).toBe(true)
    expect(h.control.getState()).toEqual({ proposalId: null })
    expect(h.audit).toHaveBeenCalledWith(
      'voice.action',
      expect.objectContaining({ decision: 'confirm', status: 'done', via: 'grant' })
    )
  })

  it('a grant for create a note never covers another action: it still asks', async () => {
    const h = harness()
    h.approve(NOTE, 'task')
    const result = await h.executor.handle(OPEN_X, makeClaim().claim, 'push-to-talk')
    // open_x is reversible and runs at once on its own: the point is no grant is consulted for it.
    expect(result).toMatchObject({ status: 'done' })
    const shutter = await h.executor.handle(SHUTTER, makeClaim().claim, 'push-to-talk')
    expect(shutter).toMatchObject({ status: 'needs_confirmation' })
  })

  it('a grant approved in task A does not skip the card in task B, and works again back in A', async () => {
    const h = harness()
    h.approve(NOTE, 'task')
    h.setTask('task-B')
    expect(await h.executor.handle(NOTE_2, makeClaim().claim, 'push-to-talk')).toMatchObject({
      status: 'needs_confirmation'
    })
    expect(h.adapter).not.toHaveBeenCalled()
    h.setTask('task-A')
    expect(await h.executor.handle(NOTE_2, makeClaim().claim, 'push-to-talk')).toMatchObject({ status: 'done' })
  })

  it('a wake word never skips the card even with a grant', async () => {
    const h = harness()
    h.approve(NOTE, 'conversation')
    expect(await h.executor.handle(NOTE, makeClaim().claim, 'wake')).toMatchObject({ status: 'needs_confirmation' })
    expect(h.adapter).not.toHaveBeenCalled()
  })

  it('a meeting being recorded still refuses, grant or not', async () => {
    const h = harness()
    h.approve(NOTE, 'task')
    h.setGate({ meetingReserved: true })
    const result = await h.executor.handle(NOTE, makeClaim().claim, 'push-to-talk')
    expect(result).toEqual({ status: 'refused', reason: 'meeting_recording', actionId: 'desktop.create_note' })
    expect(h.adapter).not.toHaveBeenCalled()
  })

  it('a revoked turn refuses and leaves a stored task grant usable', async () => {
    const h = harness()
    h.approve(NOTE, 'task')
    const stale = makeClaim()
    stale.revoke()
    expect(await h.executor.handle(NOTE, stale.claim, 'push-to-talk')).toMatchObject({
      status: 'refused',
      reason: 'turn_ended'
    })
    expect(await h.executor.handle(NOTE, makeClaim().claim, 'push-to-talk')).toMatchObject({ status: 'done' })
  })

  it('an action grant is used up by the one dispatch it covered', async () => {
    const h = harness()
    h.approve(NOTE, 'action')
    expect(await h.executor.handle(NOTE, makeClaim().claim, 'push-to-talk')).toMatchObject({ status: 'done' })
    expect(await h.executor.handle(NOTE, makeClaim().claim, 'push-to-talk')).toMatchObject({
      status: 'needs_confirmation'
    })
  })

  it('Stop revokes the grant: the next create asks again', async () => {
    const h = harness()
    h.approve(NOTE, 'conversation')
    h.control.onInputSessionStop('user-stop')
    expect(await h.executor.handle(NOTE, makeClaim().claim, 'push-to-talk')).toMatchObject({
      status: 'needs_confirmation'
    })
  })

  it('an uncertain outcome under a grant is reported uncertain and never replayed', async () => {
    const h = harness()
    h.approve(NOTE, 'task')
    h.adapter.mockImplementationOnce(async (request) => ({ id: request.id, ok: true, outcome: 'unknown' }))
    const result = await h.executor.handle(NOTE, makeClaim().claim, 'push-to-talk')
    expect(result).toMatchObject({ status: 'uncertain' })
    expect(h.adapter).toHaveBeenCalledTimes(1)
  })
})

describe('refusals carry their own decision and copy', () => {
  it('purchase: an exhausted allowance refuses with quota copy, runs nothing and takes no turn', async () => {
    const h = harness({ purchase: { check: async () => 'exhausted' as const } })
    h.approve(NOTE, 'task')
    const claim = makeClaim()
    const result = await h.executor.handle(NOTE, claim.claim, 'push-to-talk')
    expect(result).toEqual({
      status: 'refused',
      reason: 'quota_exhausted',
      actionId: 'desktop.create_note',
      decision: 'purchase',
      copy: GRANT_REFUSAL_COPY.quota_exhausted
    })
    expect(h.adapter).not.toHaveBeenCalled()
  })

  it('purchase: an unreadable meter refuses with its own reason', async () => {
    const h = harness({ purchase: { check: async () => 'unavailable' as const } })
    h.approve(NOTE, 'task')
    expect(await h.executor.handle(NOTE, makeClaim().claim, 'push-to-talk')).toMatchObject({
      status: 'refused',
      reason: 'quota_unavailable',
      decision: 'purchase'
    })
  })

  it('permission: a denied OS permission refuses with permission copy', async () => {
    const h = harness({
      permission: { check: async () => ({ status: 'denied', permission: 'automation', target: 'Notes' }) }
    })
    h.approve(NOTE, 'task')
    const result = await h.executor.handle(NOTE, makeClaim().claim, 'push-to-talk')
    expect(result).toMatchObject({ status: 'refused', reason: 'permission_needed', decision: 'permission' })
    expect(h.adapter).not.toHaveBeenCalled()
    expect(h.audit).toHaveBeenCalledWith(
      'voice.action',
      expect.objectContaining({ status: 'refused', reason: 'permission_needed' })
    )
  })

  it('permission: an unreadable permission falls back to the card', async () => {
    const h = harness({ permission: { check: async () => ({ status: 'unknown', permission: 'automation' }) } })
    h.approve(NOTE, 'task')
    expect(await h.executor.handle(NOTE, makeClaim().claim, 'push-to-talk')).toMatchObject({
      status: 'needs_confirmation'
    })
  })

  it('a broken grant lookup falls back to the card instead of failing the turn', async () => {
    const h = harness()
    const broken = createVoiceActionExecutor({
      platform: 'darwin',
      execute: h.adapter as never,
      propose: (request) => h.control.propose({ webContentsId: 7, revision: 1 }, request),
      owner: () => ({ webContentsId: 7, revision: 1 }),
      gate: () => GATE_OK,
      grants: {
        decide: async () => {
          throw new Error('boom')
        },
        use: () => false
      }
    })
    expect(await broken.handle(NOTE, makeClaim().claim, 'push-to-talk')).toMatchObject({ status: 'needs_confirmation' })
  })

  it('without a grants dependency behaviour is exactly as before', async () => {
    const h = harness()
    const plain = createVoiceActionExecutor({
      platform: 'darwin',
      execute: h.adapter as never,
      propose: (request) => h.control.propose({ webContentsId: 7, revision: 1 }, request),
      owner: () => ({ webContentsId: 7, revision: 1 }),
      gate: () => GATE_OK
    })
    h.approve(NOTE, 'conversation')
    expect(await plain.handle(NOTE, makeClaim().claim, 'push-to-talk')).toMatchObject({ status: 'needs_confirmation' })
  })
})

describe('a grant never lets content skip the confirm card (G36)', () => {
  it('every content-origin record is refused before any grant is consulted, with a live conversation grant', async () => {
    const h = harness()
    h.approve(NOTE, 'conversation')
    const decide = vi.spyOn(h.control, 'grantDecision')
    const pipeline = createVoiceTurnPipeline({
      router: { providerReady: () => false },
      executor: {
        platform: 'darwin',
        execute: h.adapter as never,
        propose: (request) => h.control.propose({ webContentsId: 7, revision: 1 }, request),
        owner: () => ({ webContentsId: 7, revision: 1 }),
        gate: () => GATE_OK,
        grants: {
          decide: (request, source) => h.control.grantDecision(7, request, source),
          use: (id) => h.control.useGrant(id)
        }
      },
      sendAsk: vi.fn()
    })
    for (const origin of CONTEXT_ORIGINS.filter((o) => !OWNER_COMMAND_ORIGINS.includes(o as never))) {
      const outcome = await pipeline.run(contextRecord(origin, 'create a note called exfiltrate'), makeClaim().claim)
      expect(outcome.kind).not.toBe('action')
    }
    expect(decide).not.toHaveBeenCalled()
    expect(h.adapter).not.toHaveBeenCalled()
  })
})
