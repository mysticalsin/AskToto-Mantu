import { describe, expect, it, vi } from 'vitest'
import type { DesktopActionResult } from '@shared/desktop-actions'
import { CommandControl, type CommandExecutionContext } from './command-control'
import { createActionGrantService, type OsPermissionSeam, type PurchaseSeam } from './features/grants'

const NOTE = { id: 'desktop.create_note', args: { title: 'Synthetic private title' } } as const
const OPEN_X = { id: 'desktop.open_x', args: {} } as const
const SEARCH = { id: 'desktop.google_search', args: { q: 'synthetic query' } } as const
const OWNER = { webContentsId: 11, revision: 1 }

const verified = (
  request: { id: DesktopActionResult['id'] },
  context: CommandExecutionContext
): DesktopActionResult => ({
  id: request.id,
  ok: true,
  outcome: 'verified',
  receipt: { idempotencyKey: context.idempotencyKey, argsHash: context.argsHash, observation: 'observed' }
})

function make(
  options: { purchase?: PurchaseSeam; permission?: OsPermissionSeam; task?: string; policy?: () => boolean } = {}
) {
  const audit = vi.fn()
  const execute = vi.fn(async (request: { id: DesktopActionResult['id'] }, context: CommandExecutionContext) =>
    verified(request, context)
  )
  let task = options.task ?? 'task-A'
  const grants = createActionGrantService({
    platform: 'darwin',
    audit,
    authGeneration: () => 5,
    context: () => ({ taskLineageId: task }),
    purchase: options.purchase,
    permission: options.permission ?? { check: async () => ({ status: 'granted' }) }
  })
  const control = new CommandControl({
    execute: execute as never,
    policyAllows: options.policy ?? (() => true),
    audit,
    grants
  })
  return { control, execute, audit, grants, setTask: (next: string) => (task = next) }
}

describe('CommandControl: approving with a scope', () => {
  it('a plain approval issues no standing grant and the result shape is unchanged', async () => {
    const { control } = make()
    const proposal = control.propose(OWNER, NOTE)
    expect(await control.confirm({ ...proposal, webContentsId: 11 })).toEqual({ ok: true, outcome: 'verified' })
    expect(control.listGrants()).toEqual([])
  })

  it('approving "for this task" runs the action and records a task grant that skips the next card', async () => {
    const { control, execute } = make()
    const proposal = control.propose(OWNER, NOTE)
    const result = await control.confirm({ ...proposal, webContentsId: 11, grantScope: 'task' })
    expect(result).toMatchObject({ ok: true, outcome: 'verified', grant: { ok: true, scope: 'task' } })
    expect(execute).toHaveBeenCalledTimes(1)
    const decision = await control.grantDecision(
      11,
      { id: 'desktop.create_note', args: { title: 'Another' } },
      'push-to-talk'
    )
    expect(decision.outcome).toBe('run')
  })

  it('a grant approved in task A never skips the card in task B', async () => {
    const h = make()
    const proposal = h.control.propose(OWNER, NOTE)
    await h.control.confirm({ ...proposal, webContentsId: 11, grantScope: 'task' })
    h.setTask('task-B')
    expect((await h.control.grantDecision(11, NOTE, 'push-to-talk')).outcome).toBe('confirm')
    h.setTask('task-A')
    expect((await h.control.grantDecision(11, NOTE, 'push-to-talk')).outcome).toBe('run')
  })

  it('a class that always asks still runs once when approved, but no grant is recorded', async () => {
    const { control, execute } = make()
    const proposal = control.propose(OWNER, SEARCH)
    const result = await control.confirm({ ...proposal, webContentsId: 11, grantScope: 'conversation' })
    expect(result).toMatchObject({ ok: true, grant: { ok: false, reason: 'not_grantable' } })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(control.listGrants()).toEqual([])
  })

  it('a rejected confirmation never records a grant', async () => {
    const { control, execute } = make()
    const proposal = control.propose(OWNER, NOTE)
    const result = await control.confirm({
      ...proposal,
      argsHash: 'f'.repeat(64),
      webContentsId: 11,
      grantScope: 'task'
    })
    expect(result).toEqual({ ok: false, reason: 'args_mismatch' })
    expect(execute).not.toHaveBeenCalled()
    expect(control.listGrants()).toEqual([])
  })

  it('a policy denial never records a grant', async () => {
    const { control } = make({ policy: () => false })
    const proposal = control.propose(OWNER, NOTE)
    expect(await control.confirm({ ...proposal, webContentsId: 11, grantScope: 'task' })).toEqual({
      ok: false,
      reason: 'policy_denied'
    })
    expect(control.listGrants()).toEqual([])
  })

  it('without a main-owned scope id the grant is refused as scope_unavailable but the action still runs', async () => {
    const audit = vi.fn()
    const execute = vi.fn(async (r: { id: DesktopActionResult['id'] }, c: CommandExecutionContext) => verified(r, c))
    const grants = createActionGrantService({ platform: 'darwin', audit, context: () => ({}) })
    const control = new CommandControl({ execute: execute as never, policyAllows: () => true, grants })
    const proposal = control.propose(OWNER, NOTE)
    expect(await control.confirm({ ...proposal, webContentsId: 11, grantScope: 'conversation' })).toMatchObject({
      ok: true,
      grant: { ok: false, reason: 'scope_unavailable' }
    })
    expect(execute).toHaveBeenCalledTimes(1)
  })
})

describe('CommandControl: purchase and permission are decided separately from the approval', () => {
  it('an explicit approval is refused with purchase_denied when the quota is exhausted, and nothing runs', async () => {
    const { control, execute, audit } = make({ purchase: { check: async () => 'exhausted' as const } })
    const proposal = control.propose(OWNER, NOTE)
    expect(await control.confirm({ ...proposal, webContentsId: 11 })).toEqual({ ok: false, reason: 'purchase_denied' })
    expect(execute).not.toHaveBeenCalled()
    expect(audit).toHaveBeenCalledWith('command.revoked', {
      actionId: 'desktop.create_note',
      reason: 'purchase_denied'
    })
  })

  it('an explicit approval is refused with permission_denied when the OS has said no, and nothing runs', async () => {
    const { control, execute, audit } = make({
      permission: { check: async () => ({ status: 'denied', permission: 'automation', target: 'Notes' }) }
    })
    const proposal = control.propose(OWNER, NOTE)
    expect(await control.confirm({ ...proposal, webContentsId: 11 })).toEqual({
      ok: false,
      reason: 'permission_denied'
    })
    expect(execute).not.toHaveBeenCalled()
    expect(audit).toHaveBeenCalledWith('command.revoked', {
      actionId: 'desktop.create_note',
      reason: 'permission_denied'
    })
  })

  it('an unreadable permission does not stop an explicit approval', async () => {
    const { control, execute } = make({
      permission: { check: async () => ({ status: 'unknown', permission: 'automation' }) }
    })
    const proposal = control.propose(OWNER, NOTE)
    expect(await control.confirm({ ...proposal, webContentsId: 11 })).toEqual({ ok: true, outcome: 'verified' })
    expect(execute).toHaveBeenCalledTimes(1)
  })
})

describe('CommandControl: grant revocation', () => {
  async function withGrant() {
    const h = make()
    const proposal = h.control.propose(OWNER, OPEN_X)
    await h.control.confirm({ ...proposal, webContentsId: 11, grantScope: 'task' })
    return h
  }

  it('sign-out revokes the grant even though no proposal is pending', async () => {
    const h = await withGrant()
    expect(h.control.listGrants()).toHaveLength(1)
    h.control.revokeForLifecycleEvent('auth_session_cleared')
    expect(h.control.listGrants()).toEqual([])
    expect(h.audit).toHaveBeenCalledWith('grant.revoked', expect.objectContaining({ reason: 'sign_out' }))
  })

  it('an owner switch revokes the grant', async () => {
    const h = await withGrant()
    h.control.revokeForLifecycleEvent('renderer_replaced')
    expect(h.control.listGrants()).toEqual([])
  })

  it('blur and hide leave the grant alone', async () => {
    const h = await withGrant()
    h.control.revokeForLifecycleEvent('window_blurred')
    h.control.revokeForLifecycleEvent('window_hidden')
    expect(h.control.listGrants()).toHaveLength(1)
  })

  it('Stop, task end and conversation end revoke through the control', async () => {
    const h = await withGrant()
    h.control.onInputSessionStop('user-stop')
    expect(h.control.listGrants()).toEqual([])
    const g = await withGrant()
    expect(g.control.endTaskGrants('task-A')).toBe(1)
  })

  it('a grant decision from a different owner is an owner switch', async () => {
    const h = await withGrant()
    expect((await h.control.grantDecision(99, OPEN_X, 'push-to-talk')).outcome).toBe('confirm')
    expect(h.control.listGrants()).toEqual([])
  })

  it('without a grant service every decision is the confirm card', async () => {
    const control = new CommandControl({ execute: vi.fn() as never, policyAllows: () => true })
    expect(await control.grantDecision(11, NOTE, 'push-to-talk')).toMatchObject({ outcome: 'confirm' })
    expect(control.listGrants()).toEqual([])
    expect(control.useGrant('x')).toBe(false)
    expect(() => control.revokeForLifecycleEvent('auth_session_cleared')).not.toThrow()
  })
})
