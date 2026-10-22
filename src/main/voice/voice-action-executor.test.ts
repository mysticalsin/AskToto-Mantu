import { describe, expect, it, vi } from 'vitest'
import type { DesktopActionRequest, DesktopActionResult } from '@shared/desktop-actions'
import type { ActionEnvelope } from '../action-guard'
import { CommandControl } from '../command-control'
import { DesktopActionTaskBridge } from '../tasks/desktop-action-task-bridge'
import type { TaskStateStore } from '../tasks/encrypted-task-file-store'
import type { TaskStateReadResult } from '../tasks/task-persistence'
import { createVoiceActionExecutor, type VoiceActionExecutorDeps } from './voice-action-executor'
import type { VoiceTurnClaim } from './voice-session'

class MemoryStore implements TaskStateStore {
  serialized: string | null = null
  async read(): Promise<TaskStateReadResult> {
    return this.serialized === null ? { kind: 'not-found' } : { kind: 'found', serialized: this.serialized }
  }
  async write(serialized: string): Promise<void> {
    this.serialized = serialized
  }
  async quarantine(): Promise<void> {
    this.serialized = null
  }
}

const OPEN_NOTES: DesktopActionRequest = { id: 'desktop.open_notes', args: {} }
const SEARCH: DesktopActionRequest = { id: 'desktop.google_search', args: { q: 'cybernetics' } }
const NOTE: DesktopActionRequest = { id: 'desktop.create_note', args: { title: 'Synthetic private title' } }

const verifiedWith = (request: DesktopActionRequest, envelope: ActionEnvelope): DesktopActionResult => ({
  id: request.id,
  ok: true,
  outcome: 'verified',
  receipt: { ...envelope, observation: 'observed in the app' }
})
const handedOff = (request: DesktopActionRequest): DesktopActionResult => ({
  id: request.id,
  ok: true,
  outcome: 'unknown'
})

function makeClaim(initiallyValid = true) {
  let valid = initiallyValid
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

const GATE_OK: ReturnType<VoiceActionExecutorDeps['gate']> = {
  authenticated: true,
  listenEntitled: true,
  ownerPresent: true,
  ownerVisible: true,
  onboardingExclusive: false,
  lifecycleHooksReady: true,
  meetingReserved: false
}

type Adapter = (request: DesktopActionRequest, envelope: ActionEnvelope) => Promise<DesktopActionResult>

function harness(options: { platform?: string; store?: MemoryStore; adapter?: Adapter } = {}) {
  const store = options.store ?? new MemoryStore()
  const adapter =
    options.adapter ??
    vi.fn<Adapter>(async (request, envelope) =>
      request.id === 'desktop.google_search' ? handedOff(request) : verifiedWith(request, envelope)
    )
  const audit = vi.fn()
  const bridge = new DesktopActionTaskBridge({ execute: adapter, store, authSessionGeneration: () => 1, audit })
  const control = new CommandControl({ execute: bridge.execute, policyAllows: () => true })
  let gate = { ...GATE_OK }
  let ownerPresent = true
  let ids = 0
  const executor = createVoiceActionExecutor({
    platform: options.platform ?? 'darwin',
    execute: bridge.execute,
    propose: (request) => control.propose({ webContentsId: 7, revision: 1 }, request),
    owner: () => (ownerPresent ? { webContentsId: 7, revision: 1 } : null),
    gate: () => gate,
    audit,
    newProposalId: () => (ids++).toString(16).padStart(32, '0')
  })
  return {
    store,
    adapter,
    bridge,
    control,
    executor,
    audit,
    setGate: (next: Partial<typeof GATE_OK>) => (gate = { ...gate, ...next }),
    removeOwner: () => (ownerPresent = false)
  }
}

describe('immediate run: read and reversible actions from a held chord', () => {
  it('runs through the durable task bridge exactly once and ends done with a bound receipt', async () => {
    const h = harness()
    const { claim } = makeClaim()
    const result = await h.executor.handle(OPEN_NOTES, claim, 'push-to-talk')

    expect(result).toEqual({ status: 'done', actionId: 'desktop.open_notes', actionClass: 'reversible' })
    expect(h.adapter).toHaveBeenCalledTimes(1)
    const snapshot = h.bridge.snapshot()
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0]).toMatchObject({ actionId: 'desktop.open_notes', status: 'completed', effectOutcome: 'applied' })
    // The task was persisted before the adapter ran and holds no spoken text.
    expect(h.store.serialized).toContain('desktop.open_notes')
  })

  it('a hand-off with nothing to read back is reported uncertain, honestly, and the task is uncertain', async () => {
    const h = harness()
    const result = await h.executor.handle(SEARCH, makeClaim().claim, 'push-to-talk')
    expect(result).toEqual({
      status: 'uncertain',
      actionId: 'desktop.google_search',
      actionClass: 'read',
      verification: 'handoff'
    })
    expect(h.bridge.snapshot()[0]?.effectOutcome).toBe('uncertain')
  })

  it('a verified claim without a receipt bound to this dispatch is uncertain, never done', async () => {
    for (const adapter of [
      vi.fn(async (request: DesktopActionRequest) => ({ id: request.id, ok: true, outcome: 'verified' as const })),
      vi.fn(async (request: DesktopActionRequest, envelope: ActionEnvelope) => ({
        ...verifiedWith(request, envelope),
        receipt: { ...envelope, idempotencyKey: 'f'.repeat(64), observation: 'wrong dispatch' }
      }))
    ]) {
      const h = harness({ adapter })
      const result = await h.executor.handle(OPEN_NOTES, makeClaim().claim, 'push-to-talk')
      expect(result.status).toBe('uncertain')
    }
  })

  it('an adapter that throws after dispatch is uncertain (the effect may have happened) and is not retried', async () => {
    const adapter = vi.fn(async () => {
      throw new Error('synthetic adapter crash')
    })
    const h = harness({ adapter })
    const result = await h.executor.handle(OPEN_NOTES, makeClaim().claim, 'push-to-talk')
    expect(result).toMatchObject({ status: 'uncertain', actionId: 'desktop.open_notes' })
    expect(adapter).toHaveBeenCalledTimes(1)
    expect(h.bridge.snapshot()[0]?.effectOutcome).toBe('uncertain')
  })

  it.each([
    ['automation_denied', { detail: 'automation_denied' }, 'automation_denied'],
    ['accessibility_required', { detail: 'accessibility_required' }, 'accessibility_required'],
    ['preferred_missing flag', { preferredMissing: true }, 'preferred_missing'],
    ['documents_unavailable', { detail: 'documents_unavailable' }, 'documents_unavailable'],
    ['unsupported outcome', { outcome: 'unsupported' as const }, 'unsupported'],
    ['anything else', { detail: 'private detail text' }, 'adapter_failed']
  ])('a proven failure (%s) is failed with a machine reason, never the adapter text', async (_label, extra, reason) => {
    const adapter = vi.fn(async (request: DesktopActionRequest) => ({
      id: request.id,
      ok: false,
      outcome: 'failed' as const,
      ...extra
    }))
    const h = harness({ adapter })
    const result = await h.executor.handle(OPEN_NOTES, makeClaim().claim, 'push-to-talk')
    expect(result).toEqual({ status: 'failed', actionId: 'desktop.open_notes', actionClass: 'reversible', reason })
    expect(h.bridge.snapshot()[0]?.effectOutcome).toBe('not-applied')
  })

  it('writes exactly one durable task per dispatch, and a replay of the same dispatch is denied', async () => {
    const h = harness()
    const first = await h.executor.handle(OPEN_NOTES, makeClaim().claim, 'push-to-talk')
    expect(first.status).toBe('done')
    expect(h.bridge.snapshot()).toHaveLength(1)
    // newProposalId is pinned per call, so a second handle is a new dispatch: it is its own single task.
    await h.executor.handle(OPEN_NOTES, makeClaim().claim, 'push-to-talk')
    expect(h.bridge.snapshot()).toHaveLength(2)
    expect(h.adapter).toHaveBeenCalledTimes(2)
  })
})

describe('an uncertain effect is never replayed', () => {
  it('survives a simulated restart as uncertain and runs nothing again', async () => {
    const store = new MemoryStore()
    const first = harness({ store })
    await first.executor.handle(SEARCH, makeClaim().claim, 'push-to-talk')
    expect(first.adapter).toHaveBeenCalledTimes(1)

    // A new process: new bridge and executor over the same encrypted archive.
    const adapterAfterRestart = vi.fn(async (request: DesktopActionRequest) => handedOff(request))
    const second = harness({ store, adapter: adapterAfterRestart })
    expect(await second.bridge.recover()).toEqual({ available: true, uncertain: 1 })
    expect(second.bridge.snapshot()[0]).toMatchObject({ actionId: 'desktop.google_search', effectOutcome: 'uncertain' })
    expect(adapterAfterRestart).not.toHaveBeenCalled()

    // The only way to run it again is a new, deliberate dispatch with a new proposal id.
    expect(second.bridge.snapshot().filter((t) => t.effectOutcome === 'uncertain')).toHaveLength(1)
  })

  it('the same dispatch id can never run twice, even after the first ended uncertain', async () => {
    const h = harness()
    const fixed = createVoiceActionExecutor({
      platform: 'darwin',
      execute: h.bridge.execute,
      propose: () => null,
      owner: () => ({ webContentsId: 7, revision: 1 }),
      gate: () => GATE_OK,
      newProposalId: () => 'a'.repeat(32)
    })
    await fixed.handle(SEARCH, makeClaim().claim, 'push-to-talk')
    const replay = await fixed.handle(SEARCH, makeClaim().claim, 'push-to-talk')
    expect(replay).toMatchObject({ status: 'failed', reason: 'task_unavailable' })
    expect(h.adapter).toHaveBeenCalledTimes(1)
  })
})

describe('the turn claim: one hold, at most one action, never after a revocation', () => {
  it('is single use', async () => {
    const h = harness()
    const { claim } = makeClaim()
    expect((await h.executor.handle(OPEN_NOTES, claim, 'push-to-talk')).status).toBe('done')
    expect(await h.executor.handle(OPEN_NOTES, claim, 'push-to-talk')).toMatchObject({
      status: 'refused',
      reason: 'turn_ended'
    })
    expect(h.adapter).toHaveBeenCalledTimes(1)
  })

  it('a revoked turn runs nothing and creates no task', async () => {
    const h = harness()
    const revoked = makeClaim()
    revoked.revoke()
    expect(await h.executor.handle(OPEN_NOTES, revoked.claim, 'push-to-talk')).toMatchObject({
      status: 'refused',
      reason: 'turn_ended'
    })
    expect(await h.executor.handle(NOTE, revoked.claim, 'push-to-talk')).toMatchObject({ status: 'refused' })
    expect(h.adapter).not.toHaveBeenCalled()
    expect(h.bridge.snapshot()).toEqual([])
    expect(h.control.getState()).toEqual({ proposalId: null })
  })
})

describe('the gate', () => {
  it.each([
    ['signed out', { authenticated: false }],
    ['no listen entitlement', { listenEntitled: false }],
    ['no visible owner', { ownerVisible: false }],
    ['onboarding exclusive', { onboardingExclusive: true }],
    ['lifecycle hooks not ready', { lifecycleHooksReady: false }]
  ])('refuses an immediate run when %s, and creates no task', async (_label, override) => {
    const h = harness()
    h.setGate(override)
    expect(await h.executor.handle(OPEN_NOTES, makeClaim().claim, 'push-to-talk')).toMatchObject({
      status: 'refused',
      reason: 'not_allowed'
    })
    expect(h.adapter).not.toHaveBeenCalled()
    expect(h.bridge.snapshot()).toEqual([])
  })

  it('no voice action while a meeting records: neither a run nor a proposal', async () => {
    const h = harness()
    h.setGate({ meetingReserved: true })
    expect(await h.executor.handle(OPEN_NOTES, makeClaim().claim, 'push-to-talk')).toMatchObject({
      status: 'refused',
      reason: 'meeting_recording'
    })
    expect(await h.executor.handle(NOTE, makeClaim().claim, 'push-to-talk')).toMatchObject({
      status: 'refused',
      reason: 'meeting_recording'
    })
    expect(h.adapter).not.toHaveBeenCalled()
    expect(h.control.getState()).toEqual({ proposalId: null })
  })

  it('refuses without an owner window', async () => {
    const h = harness()
    h.removeOwner()
    expect(await h.executor.handle(OPEN_NOTES, makeClaim().claim, 'push-to-talk')).toMatchObject({ status: 'refused' })
    expect(await h.executor.handle(NOTE, makeClaim().claim, 'push-to-talk')).toMatchObject({ status: 'refused' })
    expect(h.adapter).not.toHaveBeenCalled()
  })

  it('refuses an action the platform cannot run, and an invalid request', async () => {
    const linux = harness({ platform: 'linux' })
    expect(await linux.executor.handle(OPEN_NOTES, makeClaim().claim, 'push-to-talk')).toMatchObject({
      status: 'refused',
      reason: 'unsupported_platform'
    })
    const win = harness({ platform: 'win32' })
    expect(
      await win.executor.handle({ id: 'desktop.open_arc', args: {} }, makeClaim().claim, 'push-to-talk')
    ).toMatchObject({
      status: 'refused',
      reason: 'unsupported_platform'
    })
    const h = harness()
    expect(await h.executor.handle({ id: 'shell.exec', args: {} } as never, makeClaim().claim, 'push-to-talk')).toEqual(
      {
        status: 'refused',
        reason: 'invalid_request'
      }
    )
    expect(
      await h.executor.handle(
        { id: 'desktop.create_note', args: { title: 'x'.repeat(500) } } as never,
        makeClaim().claim,
        'push-to-talk'
      )
    ).toEqual({ status: 'refused', reason: 'invalid_request' })
    for (const m of [linux, win, h]) expect(m.adapter).not.toHaveBeenCalled()
  })
})

describe('confirm: a create action becomes a typed needsConfirmation decision and a pending proposal', () => {
  it('proposes through CommandControl without running anything', async () => {
    const h = harness()
    const result = await h.executor.handle(NOTE, makeClaim().claim, 'push-to-talk')
    expect(h.adapter).not.toHaveBeenCalled()
    expect(h.bridge.snapshot()).toEqual([])
    const state = h.control.getState()
    expect(state.proposalId).not.toBeNull()
    expect(result).toEqual({
      status: 'needs_confirmation',
      actionId: 'desktop.create_note',
      actionClass: 'create',
      proposalId: (state as { proposalId: string }).proposalId,
      argsHash: (state as { argsHash: string }).argsHash,
      preview: { title: 'Create a note in Notes', argument: 'Synthetic private title' }
    })
    // The nonce authorizes the confirmation and stays inside the existing CommandControl push.
    expect(JSON.stringify(result)).not.toContain((state as { nonce: string }).nonce)
  })

  it('approving it is the existing confirm path: nonce, args hash, then one durable task', async () => {
    const h = harness()
    await h.executor.handle(NOTE, makeClaim().claim, 'push-to-talk')
    const state = h.control.getState() as { proposalId: string; nonce: string; argsHash: string }
    const confirmed = await h.control.confirm({
      proposalId: state.proposalId,
      nonce: state.nonce,
      argsHash: state.argsHash,
      webContentsId: 7
    })
    expect(confirmed).toEqual({ ok: true, outcome: 'verified' })
    expect(h.adapter).toHaveBeenCalledTimes(1)
    expect(h.bridge.snapshot()).toHaveLength(1)
  })

  it('a wake word or the panel confirms even a read action', async () => {
    for (const source of ['wake', 'panel'] as const) {
      const h = harness()
      const result = await h.executor.handle(SEARCH, makeClaim().claim, source)
      expect(result.status, source).toBe('needs_confirmation')
      expect(h.adapter).not.toHaveBeenCalled()
    }
  })

  it('Photo Booth is a card action on macOS and an immediate Camera open on Windows', async () => {
    const photo: DesktopActionRequest = { id: 'desktop.photo_booth_capture', args: {} }
    expect((await harness().executor.handle(photo, makeClaim().claim, 'push-to-talk')).status).toBe(
      'needs_confirmation'
    )
    const win = harness({ platform: 'win32' })
    expect((await win.executor.handle(photo, makeClaim().claim, 'push-to-talk')).status).not.toBe('needs_confirmation')
    expect(win.adapter).toHaveBeenCalledTimes(1)
  })

  it('a proposal that cannot be created is refused', async () => {
    const h = harness()
    const broken = createVoiceActionExecutor({
      platform: 'darwin',
      execute: h.bridge.execute,
      propose: () => {
        throw new Error('boom')
      },
      owner: () => ({ webContentsId: 7, revision: 1 }),
      gate: () => GATE_OK
    })
    expect(await broken.handle(NOTE, makeClaim().claim, 'push-to-talk')).toMatchObject({
      status: 'refused',
      reason: 'not_allowed'
    })
  })
})

describe('privacy of the audit trail', () => {
  it('records the action id, class and outcome and never a title, a query or an argument', async () => {
    const h = harness()
    await h.executor.handle(NOTE, makeClaim().claim, 'push-to-talk')
    await h.executor.handle(SEARCH, makeClaim().claim, 'push-to-talk')
    await h.executor.handle(OPEN_NOTES, makeClaim().claim, 'push-to-talk')
    const voiceAudit = h.audit.mock.calls.filter(([event]) => event === 'voice.action')
    expect(voiceAudit).toHaveLength(3)
    const text = JSON.stringify(h.audit.mock.calls)
    expect(text).not.toContain('Synthetic private title')
    expect(text).not.toContain('cybernetics')
    expect(voiceAudit[0][1]).toMatchObject({
      actionId: 'desktop.create_note',
      class: 'create',
      decision: 'confirm',
      status: 'needs_confirmation'
    })
  })
})
