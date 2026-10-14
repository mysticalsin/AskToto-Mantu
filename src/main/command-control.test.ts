import { describe, expect, it, vi } from 'vitest'
import {
  CommandControl,
  commandConfirmationPolicyAllows,
  type CommandConfirmationPolicyInput
} from './command-control'

const allowCommandPolicy = (): boolean => true
const confirmedCommandPolicy: CommandConfirmationPolicyInput = {
  authenticated: true,
  listenEntitled: true,
  owner: { destroyed: false, visible: true, focused: true },
  onboardingExclusive: false,
  lifecycleHooksReady: true
}

describe('command confirmation policy', () => {
  it('allows confirmation only when the authenticated, entitled, focused owner and lifecycle hooks are ready', () => {
    expect(commandConfirmationPolicyAllows(confirmedCommandPolicy)).toBe(true)
  })

  it.each([
    ['auth is missing', { authenticated: false }],
    ['Listen entitlement is missing', { listenEntitled: false }],
    ['the owner is missing', { owner: null }],
    ['the owner is destroyed', { owner: { destroyed: true, visible: true, focused: true } }],
    ['the owner is hidden', { owner: { destroyed: false, visible: false, focused: true } }],
    ['the owner is unfocused', { owner: { destroyed: false, visible: true, focused: false } }],
    ['exclusive onboarding is active', { onboardingExclusive: true }],
    ['lifecycle revocation hooks are unavailable', { lifecycleHooksReady: false }]
  ] as const)('denies confirmation when %s', (_reason, override) => {
    expect(commandConfirmationPolicyAllows({ ...confirmedCommandPolicy, ...override })).toBe(false)
  })
})

describe('CommandControl', () => {
  it('rejects confirmation from a different renderer owner without executing', async () => {
    const execute = vi.fn(async () => ({ id: 'desktop.open_notes' as const, ok: true, outcome: 'unknown' as const }))
    const controller = new CommandControl({ execute, policyAllows: allowCommandPolicy })
    const proposal = controller.propose(
      { webContentsId: 11, revision: 3 },
      { id: 'desktop.open_notes', args: {} }
    )

    expect(await controller.confirm({ ...proposal, webContentsId: 12 })).toEqual({
      ok: false,
      reason: 'owner_mismatch'
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it('consumes a proposal before the adapter resolves, preventing duplicate confirmation', async () => {
    let resolveExecute: () => void = () => {}
    const execute = vi.fn(
      () => new Promise<import('@shared/desktop-actions').DesktopActionResult>((resolve) => {
        resolveExecute = () => resolve({ id: 'desktop.open_notes', ok: true, outcome: 'verified' })
      })
    )
    const controller = new CommandControl({ execute, policyAllows: allowCommandPolicy })
    const proposal = controller.propose(
      { webContentsId: 11, revision: 3 },
      { id: 'desktop.open_notes', args: {} }
    )

    const first = controller.confirm({ ...proposal, webContentsId: 11 })
    expect(await controller.confirm({ ...proposal, webContentsId: 11 })).toEqual({
      ok: false,
      reason: 'proposal_missing'
    })
    resolveExecute()
    expect(await first).toEqual({ ok: true, outcome: 'verified' })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('does not report success when the adapter accepted a request but cannot verify its outcome', async () => {
    const audit = vi.fn()
    const controller = new CommandControl({
      execute: async () => ({ id: 'desktop.open_notes', ok: true, outcome: 'unknown' }),
      policyAllows: allowCommandPolicy,
      audit
    })
    const proposal = controller.propose(
      { webContentsId: 11, revision: 3 },
      { id: 'desktop.open_notes', args: {} }
    )

    expect(await controller.confirm({ ...proposal, webContentsId: 11 })).toEqual({
      ok: false,
      reason: 'outcome_unverified'
    })
    expect(audit).toHaveBeenCalledWith('command.confirmed', {
      actionId: 'desktop.open_notes',
      outcome: 'unknown'
    })
  })

  it('does not attribute a verified result for another action to the confirmed action', async () => {
    const audit = vi.fn()
    const controller = new CommandControl({
      execute: async () => ({ id: 'desktop.open_arc', ok: true, outcome: 'verified' }),
      policyAllows: allowCommandPolicy,
      audit
    })
    const proposal = controller.propose(
      { webContentsId: 11, revision: 3 },
      { id: 'desktop.open_notes', args: {} }
    )

    expect(await controller.confirm({ ...proposal, webContentsId: 11 })).toEqual({
      ok: false,
      reason: 'adapter_failed'
    })
    expect(audit).toHaveBeenCalledWith('command.confirmed', {
      actionId: 'desktop.open_notes',
      outcome: 'failed'
    })
  })

  it('rejects an expired, replaced, cancelled, or nonce-mismatched proposal', async () => {
    let now = 100
    const execute = vi.fn(async () => ({ id: 'desktop.open_notes' as const, ok: true, outcome: 'unknown' as const }))
    const controller = new CommandControl({ execute, policyAllows: allowCommandPolicy, now: () => now, ttlMs: 10 })
    const expired = controller.propose({ webContentsId: 11, revision: 1 }, { id: 'desktop.open_notes', args: {} })
    now = 110
    expect(await controller.confirm({ ...expired, webContentsId: 11 })).toEqual({ ok: false, reason: 'expired' })

    const replaced = controller.propose({ webContentsId: 11, revision: 2 }, { id: 'desktop.open_notes', args: {} })
    const current = controller.propose({ webContentsId: 11, revision: 3 }, { id: 'desktop.open_notes', args: {} })
    expect(await controller.confirm({ ...replaced, webContentsId: 11 })).toEqual({ ok: false, reason: 'proposal_mismatch' })
    expect(await controller.confirm({ ...current, nonce: `${current.nonce}x`, webContentsId: 11 })).toEqual({
      ok: false,
      reason: 'nonce_mismatch'
    })
    expect(await controller.cancel({ ...current, webContentsId: 11 })).toEqual({ ok: true })
    expect(await controller.confirm({ ...current, webContentsId: 11 })).toEqual({ ok: false, reason: 'proposal_missing' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('revokes lifecycle-owned authority and audits action metadata only', async () => {
    const audit = vi.fn()
    const execute = vi.fn(async () => ({ id: 'desktop.open_notes' as const, ok: true, outcome: 'unknown' as const }))
    const controller = new CommandControl({
      execute,
      policyAllows: allowCommandPolicy,
      audit
    })
    const proposal = controller.propose({ webContentsId: 11, revision: 4 }, { id: 'desktop.open_notes', args: {} })
    controller.revokeForLifecycleEvent('renderer_replaced')
    expect(controller.getState()).toEqual({ proposalId: null })
    expect(await controller.confirm({ ...proposal, webContentsId: 11 })).toEqual({
      ok: false,
      reason: 'proposal_missing'
    })
    expect(execute).not.toHaveBeenCalled()
    expect(audit).toHaveBeenCalledWith('command.revoked', {
      actionId: 'desktop.open_notes',
      reason: 'renderer_replaced'
    })
  })

  it('expires the current proposal on its TTL timer', async () => {
    vi.useFakeTimers()
    try {
      const controller = new CommandControl({
        execute: async () => ({ id: 'desktop.open_notes', ok: true, outcome: 'unknown' }),
        policyAllows: allowCommandPolicy,
        ttlMs: 25
      })
      controller.propose({ webContentsId: 11, revision: 4 }, { id: 'desktop.open_notes', args: {} })
      await vi.advanceTimersByTimeAsync(25)
      expect(controller.getState()).toEqual({ proposalId: null })
    } finally {
      vi.useRealTimers()
    }
  })

  it('rechecks policy at confirmation time before invoking the static adapter', async () => {
    let allowed = true
    const execute = vi.fn(async () => ({ id: 'desktop.open_notes' as const, ok: true, outcome: 'unknown' as const }))
    const controller = new CommandControl({ execute, policyAllows: () => allowed })
    const proposal = controller.propose({ webContentsId: 11, revision: 4 }, { id: 'desktop.open_notes', args: {} })

    // Entitlement/foreground state can change while the proposal is displayed.
    allowed = false
    const result = await controller.confirm({ ...proposal, webContentsId: 11 })
    expect(result).toEqual({ ok: false, reason: 'policy_denied' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('fails closed when the confirmation policy throws', async () => {
    const execute = vi.fn(async () => ({ id: 'desktop.open_notes' as const, ok: true, outcome: 'verified' as const }))
    const controller = new CommandControl({
      execute,
      policyAllows: () => {
        throw new Error('policy unavailable')
      }
    })
    const proposal = controller.propose({ webContentsId: 11, revision: 4 }, { id: 'desktop.open_notes', args: {} })

    expect(await controller.confirm({ ...proposal, webContentsId: 11 })).toEqual({ ok: false, reason: 'policy_denied' })
    expect(execute).not.toHaveBeenCalled()
    expect(controller.getState()).toEqual({ proposalId: null })
  })

  it('snapshots the proposed action before exposing confirmation authority', async () => {
    const execute = vi.fn(async () => ({ id: 'desktop.create_note' as const, ok: true, outcome: 'verified' as const }))
    const controller = new CommandControl({ execute, policyAllows: allowCommandPolicy })
    const request = { id: 'desktop.create_note' as const, args: { title: 'hello' } }
    const proposal = controller.propose({ webContentsId: 11, revision: 4 }, request)
    request.args.title = 'changed after propose'

    expect(await controller.confirm({ ...proposal, webContentsId: 11 })).toEqual({ ok: true, outcome: 'verified' })
    expect(execute).toHaveBeenCalledWith({ id: 'desktop.create_note', args: { title: 'hello' } })
  })
})
