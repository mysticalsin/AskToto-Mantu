import { describe, expect, it, vi } from 'vitest'
import type { DesktopActionReceipt, DesktopActionResult } from '@shared/desktop-actions'
import {
  CommandControl,
  commandConfirmationPolicyAllows,
  type CommandConfirmationPolicyInput,
  type CommandExecutionContext
} from './command-control'
import { actionArgsHash, actionIdempotencyKey } from './action-guard'

const allowCommandPolicy = (): boolean => true
const receiptFor = (context: CommandExecutionContext, observation = 'Notes is frontmost'): DesktopActionReceipt => ({
  idempotencyKey: context.idempotencyKey,
  argsHash: context.argsHash,
  observation
})
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
    const proposal = controller.propose({ webContentsId: 11, revision: 3 }, { id: 'desktop.open_notes', args: {} })

    expect(await controller.confirm({ ...proposal, webContentsId: 12 })).toEqual({
      ok: false,
      reason: 'owner_mismatch'
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it('consumes a proposal before the adapter resolves, preventing duplicate confirmation', async () => {
    let resolveExecute: () => void = () => {}
    const execute = vi.fn(
      (_request: unknown, context: CommandExecutionContext) =>
        new Promise<DesktopActionResult>((resolve) => {
          resolveExecute = () =>
            resolve({ id: 'desktop.open_notes', ok: true, outcome: 'verified', receipt: receiptFor(context) })
        })
    )
    const controller = new CommandControl({ execute, policyAllows: allowCommandPolicy })
    const proposal = controller.propose({ webContentsId: 11, revision: 3 }, { id: 'desktop.open_notes', args: {} })

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
    const proposal = controller.propose({ webContentsId: 11, revision: 3 }, { id: 'desktop.open_notes', args: {} })

    expect(await controller.confirm({ ...proposal, webContentsId: 11 })).toEqual({
      ok: false,
      reason: 'outcome_unverified'
    })
    expect(audit).toHaveBeenCalledWith('command.confirmed', {
      actionId: 'desktop.open_notes',
      outcome: 'unknown'
    })
  })

  it('preserves an unknown result with ok false as outcome_unverified after auditing', async () => {
    const audit = vi.fn()
    const controller = new CommandControl({
      execute: async () => ({
        id: 'desktop.open_notes',
        ok: false,
        outcome: 'unknown',
        detail: 'The launch acknowledgment is uncertain.'
      }),
      policyAllows: allowCommandPolicy,
      audit
    })
    const proposal = controller.propose({ webContentsId: 11, revision: 3 }, { id: 'desktop.open_notes', args: {} })

    expect(await controller.confirm({ ...proposal, webContentsId: 11 })).toEqual({
      ok: false,
      reason: 'outcome_unverified'
    })
    expect(audit).toHaveBeenCalledWith('command.confirmed', {
      actionId: 'desktop.open_notes',
      outcome: 'unknown'
    })
  })

  it('keeps a mismatched unknown result id as adapter_failed before uncertainty mapping', async () => {
    const audit = vi.fn()
    const controller = new CommandControl({
      execute: async () => ({ id: 'desktop.open_arc', ok: false, outcome: 'unknown' }),
      policyAllows: allowCommandPolicy,
      audit
    })
    const proposal = controller.propose({ webContentsId: 11, revision: 3 }, { id: 'desktop.open_notes', args: {} })

    expect(await controller.confirm({ ...proposal, webContentsId: 11 })).toEqual({
      ok: false,
      reason: 'adapter_failed'
    })
    expect(audit).toHaveBeenCalledWith('command.confirmed', {
      actionId: 'desktop.open_notes',
      outcome: 'failed'
    })
  })

  it.each([
    'failed',
    'cancelled',
    'unsupported'
  ] as const)('keeps a matching known %s result as adapter_failed', async (outcome) => {
    const controller = new CommandControl({
      execute: async () => ({ id: 'desktop.open_notes', ok: false, outcome }),
      policyAllows: allowCommandPolicy
    })
    const proposal = controller.propose({ webContentsId: 11, revision: 3 }, { id: 'desktop.open_notes', args: {} })

    expect(await controller.confirm({ ...proposal, webContentsId: 11 })).toEqual({
      ok: false,
      reason: 'adapter_failed'
    })
  })

  it('reports a dispatch that rejects as unverified, because the effect may already have happened', async () => {
    const audit = vi.fn()
    const controller = new CommandControl({
      execute: async () => {
        throw new Error('adapter connection lost after launch')
      },
      policyAllows: allowCommandPolicy,
      audit
    })
    const proposal = controller.propose({ webContentsId: 11, revision: 3 }, { id: 'desktop.open_notes', args: {} })

    expect(await controller.confirm({ ...proposal, webContentsId: 11 })).toEqual({
      ok: false,
      reason: 'outcome_unverified'
    })
    expect(audit).toHaveBeenCalledWith('command.confirmed', {
      actionId: 'desktop.open_notes',
      outcome: 'unknown'
    })
  })

  it('hands the executor the confirmed proposal identity and the sender-derived owner', async () => {
    const execute = vi.fn(async () => ({ id: 'desktop.open_notes' as const, ok: true, outcome: 'unknown' as const }))
    const controller = new CommandControl({ execute, policyAllows: allowCommandPolicy })
    const proposal = controller.propose({ webContentsId: 11, revision: 3 }, { id: 'desktop.open_notes', args: {} })

    await controller.confirm({ ...proposal, webContentsId: 11 })
    const argsHash = actionArgsHash({ id: 'desktop.open_notes', args: {} })
    expect(execute).toHaveBeenCalledWith(
      { id: 'desktop.open_notes', args: {} },
      {
        proposalId: proposal.proposalId,
        owner: { webContentsId: 11, revision: 3 },
        argsHash,
        idempotencyKey: actionIdempotencyKey(proposal.proposalId, argsHash),
        dependsOn: []
      }
    )
  })

  it('does not attribute a verified result for another action to the confirmed action', async () => {
    const audit = vi.fn()
    const controller = new CommandControl({
      execute: async () => ({ id: 'desktop.open_arc', ok: true, outcome: 'verified' }),
      policyAllows: allowCommandPolicy,
      audit
    })
    const proposal = controller.propose({ webContentsId: 11, revision: 3 }, { id: 'desktop.open_notes', args: {} })

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
    expect(await controller.confirm({ ...replaced, webContentsId: 11 })).toEqual({
      ok: false,
      reason: 'proposal_mismatch'
    })
    expect(await controller.confirm({ ...current, nonce: `${current.nonce}x`, webContentsId: 11 })).toEqual({
      ok: false,
      reason: 'nonce_mismatch'
    })
    expect(await controller.cancel({ ...current, webContentsId: 11 })).toEqual({ ok: true })
    expect(await controller.confirm({ ...current, webContentsId: 11 })).toEqual({
      ok: false,
      reason: 'proposal_missing'
    })
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
    const execute = vi.fn(async (_request: unknown, context: CommandExecutionContext) => ({
      id: 'desktop.create_note' as const,
      ok: true,
      outcome: 'verified' as const,
      receipt: receiptFor(context)
    }))
    const controller = new CommandControl({ execute, policyAllows: allowCommandPolicy })
    const request = { id: 'desktop.create_note' as const, args: { title: 'hello' } }
    const proposal = controller.propose({ webContentsId: 11, revision: 4 }, request)
    request.args.title = 'changed after propose'

    expect(await controller.confirm({ ...proposal, webContentsId: 11 })).toEqual({ ok: true, outcome: 'verified' })
    expect(execute).toHaveBeenCalledWith(
      { id: 'desktop.create_note', args: { title: 'hello' } },
      expect.objectContaining({
        proposalId: proposal.proposalId,
        owner: { webContentsId: 11, revision: 4 },
        argsHash: actionArgsHash({ id: 'desktop.create_note', args: { title: 'hello' } })
      })
    )
  })
  describe('G04 ActionGuard binding', () => {
    const owner = { webContentsId: 11, revision: 3 }
    const NOTES = { id: 'desktop.open_notes' as const, args: {} }

    it('exposes the args hash in the proposal and the renderer state, never the arguments', () => {
      const controller = new CommandControl({ execute: vi.fn(), policyAllows: allowCommandPolicy })
      const proposal = controller.propose(owner, { id: 'desktop.create_note', args: { title: 'private title' } })
      expect(proposal.argsHash).toBe(actionArgsHash({ id: 'desktop.create_note', args: { title: 'private title' } }))
      expect(controller.getState()).toMatchObject({ argsHash: proposal.argsHash })
      expect(JSON.stringify(controller.getState())).not.toContain('private title')
    })

    it.each([
      ['a wrong hash', (hash: string) => `${hash.slice(0, 63)}${hash.endsWith('0') ? '1' : '0'}`],
      ['the hash of another action', () => actionArgsHash({ id: 'desktop.open_arc', args: {} })],
      ['a missing hash', () => undefined as unknown as string]
    ])('rejects confirmation with %s without executing, and keeps the proposal confirmable', async (_name, bad) => {
      const execute = vi.fn(async (_r: unknown, context: CommandExecutionContext) => ({
        id: 'desktop.open_notes' as const,
        ok: true,
        outcome: 'verified' as const,
        receipt: receiptFor(context)
      }))
      const controller = new CommandControl({ execute, policyAllows: allowCommandPolicy })
      const proposal = controller.propose(owner, NOTES)

      expect(await controller.confirm({ ...proposal, argsHash: bad(proposal.argsHash), webContentsId: 11 })).toEqual({
        ok: false,
        reason: 'args_mismatch'
      })
      expect(execute).not.toHaveBeenCalled()
      expect(await controller.confirm({ ...proposal, webContentsId: 11 })).toEqual({ ok: true, outcome: 'verified' })
    })

    it('lets a cancel through on the id and nonce alone', async () => {
      const controller = new CommandControl({ execute: vi.fn(), policyAllows: allowCommandPolicy })
      const proposal = controller.propose(owner, NOTES)
      expect(
        await controller.cancel({ proposalId: proposal.proposalId, nonce: proposal.nonce, webContentsId: 11 })
      ).toEqual({ ok: true })
    })

    it('treats a verified result with no bound receipt as unverified', async () => {
      const audit = vi.fn()
      const controller = new CommandControl({
        execute: async () => ({ id: 'desktop.open_notes', ok: true, outcome: 'verified' }),
        policyAllows: allowCommandPolicy,
        audit
      })
      const proposal = controller.propose(owner, NOTES)
      expect(await controller.confirm({ ...proposal, webContentsId: 11 })).toEqual({
        ok: false,
        reason: 'outcome_unverified'
      })
      expect(audit).toHaveBeenCalledWith('command.confirmed', { actionId: 'desktop.open_notes', outcome: 'unknown' })
    })

    it.each([
      ['another key', (c: CommandExecutionContext) => ({ ...receiptFor(c), idempotencyKey: 'f'.repeat(64) })],
      ['other arguments', (c: CommandExecutionContext) => ({ ...receiptFor(c), argsHash: 'f'.repeat(64) })],
      ['an empty observation', (c: CommandExecutionContext) => receiptFor(c, '')]
    ])('treats a receipt bound to %s as unverified', async (_name, receipt) => {
      const controller = new CommandControl({
        execute: async (_request, context) => ({
          id: 'desktop.open_notes',
          ok: true,
          outcome: 'verified',
          receipt: receipt(context)
        }),
        policyAllows: allowCommandPolicy
      })
      const proposal = controller.propose(owner, NOTES)
      expect(await controller.confirm({ ...proposal, webContentsId: 11 })).toEqual({
        ok: false,
        reason: 'outcome_unverified'
      })
    })

    it('hands the executor a distinct idempotency key per proposal of the same action', async () => {
      const keys: string[] = []
      const controller = new CommandControl({
        execute: async (_request, context) => {
          keys.push(context.idempotencyKey)
          return { id: 'desktop.open_notes', ok: true, outcome: 'unknown' }
        },
        policyAllows: allowCommandPolicy
      })
      for (let i = 0; i < 2; i += 1) {
        const proposal = controller.propose(owner, NOTES)
        await controller.confirm({ ...proposal, webContentsId: 11 })
      }
      expect(keys).toHaveLength(2)
      expect(keys[0]).not.toBe(keys[1])
    })

    it('passes validated dependencies to the executor and rejects malformed ones at propose time', async () => {
      const execute = vi.fn(async () => ({ id: 'desktop.open_notes' as const, ok: false, outcome: 'unknown' as const }))
      const controller = new CommandControl({ execute, policyAllows: allowCommandPolicy })
      const dep = 'd'.repeat(32)
      const proposal = controller.propose(owner, NOTES, { dependsOn: [dep] })
      await controller.confirm({ ...proposal, webContentsId: 11 })
      expect(execute).toHaveBeenCalledWith(NOTES, expect.objectContaining({ dependsOn: [dep] }))

      expect(() => controller.propose(owner, NOTES, { dependsOn: ['nope'] })).toThrow('DEPENDENCY_INVALID')
      expect(() => controller.propose(owner, NOTES, { dependsOn: [dep, dep] })).toThrow('DEPENDENCY_DUPLICATE')
      // A rejected proposal never replaces or leaves behind confirmable authority.
      expect(controller.getState()).toEqual({ proposalId: null })
    })
  })
})
