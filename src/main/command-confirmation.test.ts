import { describe, expect, it, vi } from 'vitest'
import { CommandConfirmation, type CommandPowerMonitor } from './command-confirmation'

type LifecycleEvent = 'suspend' | 'lock-screen'
type TestState = {
  authenticated: boolean
  listenEntitled: boolean
  owner: { destroyed: boolean; visible: boolean; focused: boolean } | null
  onboardingExclusive: boolean
}

class FakePowerMonitor implements CommandPowerMonitor {
  readonly listeners = new Map<LifecycleEvent, () => void>()

  constructor(private readonly failOn: LifecycleEvent | null = null) {}

  on(event: 'suspend', listener: () => void): this
  on(event: 'lock-screen', listener: () => void): this
  on(event: LifecycleEvent, listener: () => void): this {
    if (event === this.failOn) throw new Error(`registration failed: ${event}`)
    this.listeners.set(event, listener)
    return this
  }
}

function createConfirmation() {
  const state: TestState = {
    authenticated: true,
    listenEntitled: true,
    owner: { destroyed: false, visible: true, focused: true },
    onboardingExclusive: false
  }
  const execute = vi.fn(async () => ({ id: 'desktop.open_notes' as const, ok: true, outcome: 'verified' as const }))
  const sendCommandState = vi.fn()
  const confirmation = new CommandConfirmation({
    execute,
    isAuthenticated: () => state.authenticated,
    hasListenEntitlement: () => state.listenEntitled,
    getOwner: () => {
      const owner = state.owner
      return owner
        ? {
            isDestroyed: () => owner.destroyed,
            isVisible: () => owner.visible,
            isFocused: () => owner.focused,
            webContents: { send: sendCommandState }
          }
        : null
    },
    isOnboardingExclusive: () => state.onboardingExclusive,
    audit: vi.fn()
  })
  return { confirmation, execute, sendCommandState, state }
}

function proposalFor(confirmation: CommandConfirmation) {
  return confirmation.propose({ webContentsId: 17, revision: 1 }, { id: 'desktop.open_notes', args: {} })
}

function initialize(confirmation: CommandConfirmation, powerMonitor: FakePowerMonitor) {
  confirmation.initialize(powerMonitor, vi.fn(), { warn: vi.fn(), error: vi.fn() })
}

const policyDenials: Array<[string, (state: TestState) => void]> = [
  ['missing authentication', (state) => (state.authenticated = false)],
  ['missing Listen entitlement', (state) => (state.listenEntitled = false)],
  ['missing owner', (state) => (state.owner = null)],
  ['destroyed owner', (state) => (state.owner!.destroyed = true)],
  ['hidden owner', (state) => (state.owner!.visible = false)],
  ['unfocused owner', (state) => (state.owner!.focused = false)],
  ['exclusive onboarding', (state) => (state.onboardingExclusive = true)]
]

describe('CommandConfirmation lifecycle policy', () => {
  it.each(policyDenials)('denies confirmation with %s', async (_reason, deny) => {
    const { confirmation, execute, state } = createConfirmation()
    initialize(confirmation, new FakePowerMonitor())
    deny(state)
    const proposal = proposalFor(confirmation)

    expect(await confirmation.confirm({ ...proposal, webContentsId: 17 })).toEqual({
      ok: false,
      reason: 'policy_denied'
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it('denies confirmation until both lifecycle revocation hooks register', async () => {
    const { confirmation, execute } = createConfirmation()
    const proposal = proposalFor(confirmation)

    expect(await confirmation.confirm({ ...proposal, webContentsId: 17 })).toEqual({
      ok: false,
      reason: 'policy_denied'
    })
    expect(execute).not.toHaveBeenCalled()

    initialize(confirmation, new FakePowerMonitor())
    const readyProposal = proposalFor(confirmation)
    expect(await confirmation.confirm({ ...readyProposal, webContentsId: 17 })).toEqual({
      ok: true,
      outcome: 'verified'
    })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it.each(['suspend', 'lock-screen'] as const)(
    'denies confirmation if %s hook registration fails, even when the other hook succeeds',
    async (failedEvent) => {
      const { confirmation, execute } = createConfirmation()
      initialize(confirmation, new FakePowerMonitor(failedEvent))
      const proposal = proposalFor(confirmation)

      expect(await confirmation.confirm({ ...proposal, webContentsId: 17 })).toEqual({
        ok: false,
        reason: 'policy_denied'
      })
      expect(execute).not.toHaveBeenCalled()
    }
  )

  it.each(['suspend', 'lock-screen'] as const)('revokes a pending proposal on %s', async (event) => {
    const { confirmation, execute } = createConfirmation()
    const powerMonitor = new FakePowerMonitor()
    initialize(confirmation, powerMonitor)
    const proposal = proposalFor(confirmation)

    powerMonitor.listeners.get(event)?.()

    expect(await confirmation.confirm({ ...proposal, webContentsId: 17 })).toEqual({
      ok: false,
      reason: 'proposal_missing'
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it.each(['auth_session_cleared', 'app_quit'] as const)('revokes a pending proposal on %s', async (reason) => {
    const { confirmation, execute } = createConfirmation()
    const handler = vi.fn()
    const proposal = proposalFor(confirmation)

    confirmation.wrapLifecycleListener(reason, handler)()

    expect(handler).toHaveBeenCalledOnce()
    expect(await confirmation.confirm({ ...proposal, webContentsId: 17 })).toEqual({
      ok: false,
      reason: 'proposal_missing'
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it('only revokes and parks the current owner on blur, and revokes the current owner on hide', async () => {
    const { confirmation, execute } = createConfirmation()
    const parkOnBlur = vi.fn()
    const staleProposal = proposalFor(confirmation)

    confirmation.onWindowBlurred(false, parkOnBlur)
    expect(await confirmation.confirm({ ...staleProposal, webContentsId: 17 })).toEqual({
      ok: false,
      reason: 'policy_denied'
    })
    expect(parkOnBlur).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()

    initialize(confirmation, new FakePowerMonitor())
    const currentProposal = proposalFor(confirmation)
    confirmation.onWindowBlurred(true, parkOnBlur)
    expect(parkOnBlur).toHaveBeenCalledOnce()
    expect(await confirmation.confirm({ ...currentProposal, webContentsId: 17 })).toEqual({
      ok: false,
      reason: 'proposal_missing'
    })

    const hiddenProposal = proposalFor(confirmation)
    confirmation.onWindowHidden(true)
    expect(await confirmation.confirm({ ...hiddenProposal, webContentsId: 17 })).toEqual({
      ok: false,
      reason: 'proposal_missing'
    })
  })
})
