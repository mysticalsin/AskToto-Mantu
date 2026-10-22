import { describe, expect, it, vi } from 'vitest'
import type { DesktopActionRequest, DesktopActionResult } from '@shared/desktop-actions'
import {
  COMMAND_PROPOSAL_TTL_ASSISTIVE_MS,
  COMMAND_PROPOSAL_TTL_MS,
  type MetisCommandNotice
} from '@shared/metis-command-contract'
import { METIS_COMMAND_PROPOSAL_TTL_MS } from '@shared/metis-command-proposal'
import { CommandControl, type CommandControlDeps, type CommandControlState } from './command-control'

const NOTE: DesktopActionRequest = { id: 'desktop.create_note', args: { title: 'Groceries' } }
const OWNER = { webContentsId: 11, revision: 3 }
const ok = (): Promise<DesktopActionResult> =>
  Promise.resolve({ id: 'desktop.create_note', ok: true, outcome: 'unknown' })

function make(overrides: Partial<CommandControlDeps> = {}) {
  let now = 1_000_000
  const states: CommandControlState[] = []
  const execute = vi.fn(ok)
  const control = new CommandControl({
    execute,
    policyAllows: () => true,
    onState: (state) => states.push(state),
    now: () => now,
    platform: 'darwin',
    ...overrides
  })
  return { control, execute, states, advance: (ms: number) => (now += ms) }
}

describe('proposal TTL (one number for the runtime and CommandControl)', () => {
  it('is 12 s, and 30 s with assistive technology on', () => {
    expect(COMMAND_PROPOSAL_TTL_MS).toBe(12_000)
    expect(COMMAND_PROPOSAL_TTL_ASSISTIVE_MS).toBe(30_000)
    expect(METIS_COMMAND_PROPOSAL_TTL_MS).toBe(COMMAND_PROPOSAL_TTL_MS)
  })

  it('stamps expiresAt from the TTL in force when the card is proposed', () => {
    const plain = make()
    plain.control.propose(OWNER, NOTE)
    expect(plain.control.getState()).toMatchObject({ expiresAt: 1_000_000 + 12_000 })

    let assistive = true
    const withAt = make({ assistiveTechnology: () => assistive })
    withAt.control.propose(OWNER, NOTE)
    expect(withAt.control.getState()).toMatchObject({ expiresAt: 1_000_000 + 30_000 })
    assistive = false
    withAt.control.propose(OWNER, NOTE)
    expect(withAt.control.getState()).toMatchObject({ expiresAt: 1_000_000 + 12_000 })
  })

  it('never auto-confirms: the TTL expiry cancels and nothing runs', async () => {
    vi.useFakeTimers()
    try {
      const { control, execute, states } = make()
      const proposal = control.propose(OWNER, NOTE)
      vi.advanceTimersByTime(12_001)
      expect(states.at(-1)).toEqual({ proposalId: null })
      expect(await control.confirm({ ...proposal, webContentsId: 11 })).toEqual({
        ok: false,
        reason: 'proposal_missing'
      })
      expect(execute).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the card state main publishes', () => {
  it('carries the main-built preview, the action id and the risk, bound to the argsHash', () => {
    const { control, states } = make()
    const proposal = control.propose(OWNER, NOTE)
    expect(states.at(-1)).toMatchObject({
      proposalId: proposal.proposalId,
      argsHash: proposal.argsHash,
      actionId: 'desktop.create_note',
      risk: 'create',
      appIconKey: 'notes',
      preview: { title: 'Create a note in Notes', argument: 'Groceries', confirmLabel: 'Create' }
    })
  })

  it('builds the preview from the request alone: transcript-looking text elsewhere never appears', () => {
    const previewFor = vi.fn((_request: DesktopActionRequest) => ({
      actionId: 'desktop.create_note' as const,
      risk: 'create' as const,
      preview: { title: 'Create a note in Notes', argument: 'Groceries', confirmLabel: 'Create' }
    }))
    const { control, states } = make({ previewFor })
    control.propose(OWNER, NOTE)
    expect(previewFor).toHaveBeenCalledTimes(1)
    expect(previewFor.mock.calls[0]).toEqual([NOTE])
    expect(JSON.stringify(states)).not.toContain('transcript')
  })

  it('refuses to propose an action it cannot preview, so a card is never shown without the exact consequence', () => {
    const { control, states } = make()
    expect(() =>
      control.propose(OWNER, { id: 'desktop.create_note', args: { title: 'a‮b' } } as DesktopActionRequest)
    ).toThrow('preview_unavailable')
    expect(states.at(-1)).toEqual({ proposalId: null })
  })

  it('denies confirmation with the wrong argsHash even with a valid nonce', async () => {
    const { control, execute } = make()
    const proposal = control.propose(OWNER, NOTE)
    expect(await control.confirm({ ...proposal, argsHash: 'f'.repeat(64), webContentsId: 11 })).toEqual({
      ok: false,
      reason: 'args_mismatch'
    })
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('confirm with a stale or blurred owner', () => {
  it('is denied by the policy re-check, consumes the proposal and never reaches the adapter', async () => {
    let focused = true
    const { control, execute } = make({ policyAllows: () => focused })
    const proposal = control.propose(OWNER, NOTE)
    focused = false // the owner blurred between the card and Return
    expect(await control.confirm({ ...proposal, webContentsId: 11 })).toEqual({ ok: false, reason: 'policy_denied' })
    expect(execute).not.toHaveBeenCalled()
    expect(control.getState()).toEqual({ proposalId: null })
  })

  it('is denied for a different window than the one that was shown the card', async () => {
    const { control, execute } = make()
    const proposal = control.propose(OWNER, NOTE)
    expect(await control.confirm({ ...proposal, webContentsId: 99 })).toEqual({ ok: false, reason: 'owner_mismatch' })
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('minimum delay before a confirmation can land (main-side Return guard)', () => {
  it('refuses a confirmation inside the delay without consuming the proposal, and accepts it afterwards', async () => {
    const { control, execute, advance } = make({ minConfirmDelayMs: 300 })
    const proposal = control.propose(OWNER, NOTE)
    advance(299)
    expect(await control.confirm({ ...proposal, webContentsId: 11 })).toEqual({ ok: false, reason: 'too_soon' })
    expect(execute).not.toHaveBeenCalled()
    expect(control.getState()).toMatchObject({ proposalId: proposal.proposalId })
    advance(1)
    expect(await control.confirm({ ...proposal, webContentsId: 11 })).toMatchObject({ reason: 'outcome_unverified' })
    expect(execute).toHaveBeenCalledTimes(1)
  })
})

describe('preflight (runs before the card and again before dispatch, so a card never promises what cannot happen)', () => {
  const denied: MetisCommandNotice = {
    code: 'automation_denied',
    copy: "Métis isn't allowed to control Notes.",
    settingsKind: 'automation'
  }

  it('proposeChecked shows no card and publishes honest copy when the propose-stage preflight fails', async () => {
    const notices: MetisCommandNotice[] = []
    const preflight = vi.fn(async () => ({ ok: false as const, notice: denied }))
    const { control, states } = make({ preflight, onNotice: (notice) => notices.push(notice) })
    expect(await control.proposeChecked(OWNER, NOTE)).toBeNull()
    expect(preflight).toHaveBeenCalledWith(NOTE, 'propose')
    expect(notices).toEqual([denied])
    expect(states).toEqual([])
    expect(control.getState()).toEqual({ proposalId: null })
  })

  it('proposeChecked proposes when the preflight passes, and skips it when the proposal went stale meanwhile', async () => {
    const { control } = make({ preflight: async () => ({ ok: true }) })
    expect(await control.proposeChecked(OWNER, NOTE)).toMatchObject({ proposalId: expect.any(String) })

    const stale = make({ preflight: async () => ({ ok: true }) })
    expect(await stale.control.proposeChecked(OWNER, NOTE, { stillWanted: () => false })).toBeNull()
    expect(stale.control.getState()).toEqual({ proposalId: null })
  })

  it('runs again after Return and before the adapter; a failure there dispatches nothing', async () => {
    const order: string[] = []
    let allow = true
    const preflight = vi.fn(async (_request: DesktopActionRequest, stage: string) => {
      order.push(`preflight:${stage}`)
      return allow ? { ok: true as const } : { ok: false as const, notice: denied }
    })
    const execute = vi.fn(async () => {
      order.push('execute')
      return ok()
    })
    const notices: MetisCommandNotice[] = []
    const { control } = make({ preflight, execute, onNotice: (notice) => notices.push(notice) })
    const first = (await control.proposeChecked(OWNER, NOTE))!
    await control.confirm({ ...first, webContentsId: 11 })
    expect(order).toEqual(['preflight:propose', 'preflight:confirm', 'execute'])

    allow = false
    order.length = 0
    const second = control.propose(OWNER, NOTE)
    const result = await control.confirm({ ...second, webContentsId: 11 })
    expect(result).toEqual({ ok: false, reason: 'preflight_failed' })
    expect(order).toEqual(['preflight:confirm'])
    expect(notices.at(-1)).toEqual(denied)
  })

  it('treats a throwing preflight as a denial, never as permission', async () => {
    const { control, execute } = make({
      preflight: async () => {
        throw new Error('helper crashed')
      }
    })
    const proposal = control.propose(OWNER, NOTE)
    const result = await control.confirm({ ...proposal, webContentsId: 11 })
    expect(result).toEqual({ ok: false, reason: 'preflight_failed' })
    expect(execute).not.toHaveBeenCalled()
  })

  it.each([
    'screen_locked',
    'system_suspend',
    'window_closed',
    'window_replaced'
  ])('dispatches nothing when %s lands while the confirm-stage check is still running (an Automation prompt can take seconds)', async (reason) => {
    let finishCheck: (result: { ok: true }) => void = () => {}
    const preflight = vi.fn((_request: DesktopActionRequest, stage: string) =>
      stage === 'confirm'
        ? new Promise<{ ok: true }>((resolve) => {
            finishCheck = resolve
          })
        : Promise.resolve({ ok: true as const })
    )
    const { control, execute } = make({ preflight })
    const proposal = control.propose(OWNER, NOTE)
    const pending = control.confirm({ ...proposal, webContentsId: 11 })
    await vi.waitFor(() => expect(preflight).toHaveBeenCalledWith(NOTE, 'confirm'))
    control.revokeForLifecycleEvent(reason)
    finishCheck({ ok: true })
    expect(await pending).toEqual({ ok: false, reason: 'interrupted' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('still dispatches when the card window only blurred during the check (the system prompt takes focus)', async () => {
    let finishCheck: (result: { ok: true }) => void = () => {}
    const preflight = vi.fn((_request: DesktopActionRequest, stage: string) =>
      stage === 'confirm'
        ? new Promise<{ ok: true }>((resolve) => {
            finishCheck = resolve
          })
        : Promise.resolve({ ok: true as const })
    )
    const { control, execute } = make({ preflight })
    const proposal = control.propose(OWNER, NOTE)
    const pending = control.confirm({ ...proposal, webContentsId: 11 })
    await vi.waitFor(() => expect(preflight).toHaveBeenCalledWith(NOTE, 'confirm'))
    control.revokeForLifecycleEvent('window_blurred')
    control.revokeForLifecycleEvent('runtime_proposal_cleared')
    finishCheck({ ok: true })
    await pending
    expect(execute).toHaveBeenCalledTimes(1)
  })
})

describe('card lifecycle hooks (focus exception is for a proposed card only)', () => {
  it('presents on propose and releases with the reason on cancel, expiry, policy denial and confirm', async () => {
    const presented = vi.fn()
    const released: string[] = []
    const card = { presented, release: (reason: string) => void released.push(reason) }
    const { control, advance } = make({ card })

    const a = control.propose(OWNER, NOTE)
    expect(presented).toHaveBeenCalledTimes(1)
    await control.cancel({ proposalId: a.proposalId, nonce: a.nonce, webContentsId: 11 })

    const b = control.propose(OWNER, NOTE)
    advance(13_000)
    await control.confirm({ ...b, webContentsId: 11 })

    const c = control.propose(OWNER, NOTE)
    await control.confirm({ ...c, webContentsId: 11 })
    expect(released).toEqual(['cancelled', 'expired', 'confirmed'])
    expect(presented).toHaveBeenCalledTimes(3)
  })

  it('releases before the adapter runs, so an action that opens an app is not pulled back to the previous one', async () => {
    const order: string[] = []
    const card = { presented: () => {}, release: (reason: string) => void order.push(`release:${reason}`) }
    const execute = vi.fn(async () => {
      order.push('execute')
      return ok()
    })
    const { control } = make({ card, execute })
    const proposal = control.propose(OWNER, NOTE)
    await control.confirm({ ...proposal, webContentsId: 11 })
    expect(order).toEqual(['release:confirmed', 'execute'])
  })

  it('keeps the owner focused while the policy re-check runs, and releases after it', async () => {
    const order: string[] = []
    const card = { presented: () => {}, release: (reason: string) => void order.push(`release:${reason}`) }
    const { control } = make({
      card,
      policyAllows: () => {
        order.push('policy')
        return true
      }
    })
    const proposal = control.propose(OWNER, NOTE)
    await control.confirm({ ...proposal, webContentsId: 11 })
    expect(order).toEqual(['policy', 'release:confirmed'])
  })

  it('reports lifecycle revocations to the hook with their reason and survives a throwing hook', () => {
    const released: string[] = []
    const { control } = make({
      card: {
        presented: () => {
          throw new Error('window gone')
        },
        release: (reason: string) => void released.push(reason)
      }
    })
    expect(() => control.propose(OWNER, NOTE)).not.toThrow()
    control.revokeForLifecycleEvent('screen_locked')
    expect(released).toEqual(['screen_locked'])
  })
})
