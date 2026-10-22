import { describe, expect, it, vi } from 'vitest'
import { COMMAND_CONFIRM_IPC } from '@shared/metis-command-contract'
import { IPC } from '@shared/ipc'
import { CommandConfirmation } from './command-confirmation'

function make(overrides: Record<string, unknown> = {}) {
  const send = vi.fn()
  const confirmation = new CommandConfirmation({
    platform: 'darwin',
    execute: vi.fn(async () => ({ id: 'desktop.create_note' as const, ok: true, outcome: 'unknown' as const })),
    isAuthenticated: () => true,
    hasListenEntitlement: () => true,
    getOwner: () => ({
      isDestroyed: () => false,
      isVisible: () => true,
      isFocused: () => true,
      webContents: { send }
    }),
    isOnboardingExclusive: () => false,
    audit: vi.fn(),
    ...overrides
  })
  confirmation.initialize({ on: vi.fn() }, vi.fn(), { warn: vi.fn(), error: vi.fn() })
  return { confirmation, send }
}

const NOTE = { id: 'desktop.create_note', args: { title: 'Groceries' } } as const

describe('CommandConfirmation card plumbing', () => {
  it('refuses a confirmation inside the default 300 ms Return guard, without consuming the proposal', async () => {
    const { confirmation } = make()
    const proposal = confirmation.propose({ webContentsId: 5, revision: 1 }, NOTE)
    expect(await confirmation.confirm({ ...proposal, webContentsId: 5 })).toEqual({ ok: false, reason: 'too_soon' })
    expect(confirmation.getState()).toMatchObject({ proposalId: proposal.proposalId })
  })

  it('publishes the preview with the state over the existing state channel', () => {
    const { confirmation, send } = make()
    confirmation.propose({ webContentsId: 5, revision: 1 }, NOTE)
    expect(send).toHaveBeenCalledWith(
      IPC.metisCommandState,
      expect.objectContaining({ preview: expect.objectContaining({ argument: 'Groceries' }), risk: 'create' })
    )
  })

  it('sends preflight notices to the owner window on the notice channel', async () => {
    const notice = { code: 'signed_out', copy: 'Sign in to Métis to use voice actions.' } as const
    const { confirmation, send } = make({ preflight: async () => ({ ok: false, notice }) })
    expect(await confirmation.proposeChecked({ webContentsId: 5, revision: 1 }, NOTE)).toBeNull()
    expect(send).toHaveBeenCalledWith(COMMAND_CONFIRM_IPC.notice, notice)
  })

  it('lives 30 s with assistive technology on', () => {
    const { confirmation } = make({ isAssistiveTechnologyOn: () => true })
    const before = Date.now()
    confirmation.propose({ webContentsId: 5, revision: 1 }, NOTE)
    const state = confirmation.getState()
    if (!state.proposalId) throw new Error('expected a proposal')
    expect(state.expiresAt - before).toBeGreaterThanOrEqual(30_000)
    expect(state.expiresAt - before).toBeLessThan(31_000)
  })
})
