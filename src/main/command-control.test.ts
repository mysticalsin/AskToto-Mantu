import { describe, expect, it, vi } from 'vitest'
import { CommandControl } from './command-control'

describe('CommandControl', () => {
  it('rejects confirmation from a different renderer owner without executing', async () => {
    const execute = vi.fn(async () => ({ id: 'desktop.open_notes' as const, ok: true, outcome: 'unknown' as const }))
    const controller = new CommandControl({ execute })
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
        resolveExecute = () => resolve({ id: 'desktop.open_notes', ok: true, outcome: 'unknown' })
      })
    )
    const controller = new CommandControl({ execute })
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
    expect(await first).toEqual({ ok: true, outcome: 'unknown' })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('rejects an expired, replaced, cancelled, or nonce-mismatched proposal', async () => {
    let now = 100
    const execute = vi.fn(async () => ({ id: 'desktop.open_notes' as const, ok: true, outcome: 'unknown' as const }))
    const controller = new CommandControl({ execute, now: () => now, ttlMs: 10 })
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

  it('revokes lifecycle-owned authority and audits action metadata only', () => {
    const audit = vi.fn()
    const controller = new CommandControl({
      execute: async () => ({ id: 'desktop.open_notes', ok: true, outcome: 'unknown' }),
      audit
    })
    controller.propose({ webContentsId: 11, revision: 4 }, { id: 'desktop.open_notes', args: {} })
    controller.revokeForLifecycleEvent('renderer_replaced')
    expect(controller.getState()).toEqual({ proposalId: null })
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
    const execute = vi.fn(async () => ({ id: 'desktop.open_notes' as const, ok: true, outcome: 'unknown' as const }))
    const controller = new CommandControl({ execute, policyAllows: () => false })
    const proposal = controller.propose({ webContentsId: 11, revision: 4 }, { id: 'desktop.open_notes', args: {} })
    expect(await controller.confirm({ ...proposal, webContentsId: 11 })).toEqual({ ok: false, reason: 'policy_denied' })
    expect(execute).not.toHaveBeenCalled()
  })
})
