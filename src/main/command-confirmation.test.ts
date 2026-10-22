import { describe, expect, it, vi } from 'vitest'
import type { DesktopActionRequest } from '@shared/desktop-actions'
import { CommandConfirmation, type CommandPowerMonitor } from './command-confirmation'
import type { CommandExecutionContext } from './command-control'

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
  // G04 observed-receipt rule: a verified result is evidence only with a receipt bound to this dispatch.
  const execute = vi.fn(async (_request: DesktopActionRequest, context: CommandExecutionContext) => ({
    id: 'desktop.open_notes' as const,
    ok: true,
    outcome: 'verified' as const,
    receipt: { idempotencyKey: context.idempotencyKey, argsHash: context.argsHash, observation: 'Notes is frontmost' }
  }))
  const sendCommandState = vi.fn()
  const getOwner = vi.fn(() => {
    const owner = state.owner
    return owner
      ? {
          isDestroyed: () => owner.destroyed,
          isVisible: () => owner.visible,
          isFocused: () => owner.focused,
          webContents: { send: sendCommandState }
        }
      : null
  })
  const audit = vi.fn()
  const confirmation = new CommandConfirmation({
    execute,
    isAuthenticated: () => state.authenticated,
    hasListenEntitlement: () => state.listenEntitled,
    getOwner,
    isOnboardingExclusive: () => state.onboardingExclusive,
    // These tests are about the lifecycle policy, not the 300 ms Return guard (command-confirmation.card.test.ts).
    minConfirmDelayMs: 0,
    audit
  })
  return { confirmation, execute, sendCommandState, getOwner, audit, state }
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

  it.each([
    'suspend',
    'lock-screen'
  ] as const)('denies confirmation if %s hook registration fails, even when the other hook succeeds', async (failedEvent) => {
    const { confirmation, execute } = createConfirmation()
    initialize(confirmation, new FakePowerMonitor(failedEvent))
    const proposal = proposalFor(confirmation)

    expect(await confirmation.confirm({ ...proposal, webContentsId: 17 })).toEqual({
      ok: false,
      reason: 'policy_denied'
    })
    expect(execute).not.toHaveBeenCalled()
  })

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
    const result = { closed: true }
    const handler = vi.fn((..._args: [string, { sequence: number }]) => result)
    const proposal = proposalFor(confirmation)
    const wrapped = confirmation.wrapLifecycleListener(reason, handler)

    expect(wrapped('signout', { sequence: 7 })).toBe(result)

    expect(handler).toHaveBeenCalledExactlyOnceWith('signout', { sequence: 7 })
    expect(await confirmation.confirm({ ...proposal, webContentsId: 17 })).toEqual({
      ok: false,
      reason: 'proposal_missing'
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it.each([
    'onState',
    'owner',
    'audit'
  ] as const)('still runs the %s lifecycle listener once and rethrows its revocation error', async (seam) => {
    const { confirmation, sendCommandState, getOwner, audit } = createConfirmation()
    const proposal = proposalFor(confirmation)
    const error = new Error(`${seam} failed`)
    if (seam === 'onState')
      sendCommandState.mockImplementationOnce(() => {
        throw error
      })
    if (seam === 'owner')
      getOwner.mockImplementationOnce(() => {
        throw error
      })
    if (seam === 'audit')
      audit.mockImplementationOnce(() => {
        throw error
      })
    const listener = vi.fn((..._args: [string, number]) => 'listener-result')
    const wrapped = confirmation.wrapLifecycleListener('auth_session_cleared', listener)

    let caught: unknown
    try {
      wrapped('auth', 3)
    } catch (thrown) {
      caught = thrown
    }
    expect(caught).toBe(error)
    expect(listener).toHaveBeenCalledExactlyOnceWith('auth', 3)
    expect(await confirmation.confirm({ ...proposal, webContentsId: 17 })).toEqual({
      ok: false,
      reason: 'proposal_missing'
    })
  })

  it('runs the current-window blur action and preserves the revocation error when reporting throws', async () => {
    const { confirmation, sendCommandState } = createConfirmation()
    initialize(confirmation, new FakePowerMonitor())
    const proposal = proposalFor(confirmation)
    const error = new Error('window blur state reporting failed')
    sendCommandState.mockImplementationOnce(() => {
      throw error
    })
    const onCurrentBlur = vi.fn()

    let caught: unknown
    try {
      confirmation.onWindowBlurred(true, onCurrentBlur)
    } catch (thrown) {
      caught = thrown
    }
    expect(caught).toBe(error)
    expect(onCurrentBlur).toHaveBeenCalledOnce()
    expect(await confirmation.confirm({ ...proposal, webContentsId: 17 })).toEqual({
      ok: false,
      reason: 'proposal_missing'
    })
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

describe('CommandConfirmation task recovery', () => {
  function withRecovery(recoverTasks: () => Promise<unknown>) {
    const logger = { warn: vi.fn(), error: vi.fn() }
    const confirmation = new CommandConfirmation({
      execute: vi.fn(async () => ({ id: 'desktop.open_notes' as const, ok: true, outcome: 'verified' as const })),
      recoverTasks,
      isAuthenticated: () => true,
      hasListenEntitlement: () => true,
      getOwner: () => null,
      isOnboardingExclusive: () => false,
      audit: vi.fn()
    })
    return { confirmation, logger }
  }

  it('restores task history at boot without executing anything', () => {
    const recoverTasks = vi.fn(async () => undefined)
    const { confirmation, logger } = withRecovery(recoverTasks)
    confirmation.initialize(new FakePowerMonitor(), vi.fn(), logger)
    expect(recoverTasks).toHaveBeenCalledTimes(1)
  })

  it('logs a recovery failure instead of crashing boot', async () => {
    const { confirmation, logger } = withRecovery(async () => {
      throw new Error('archive read failed')
    })
    confirmation.initialize(new FakePowerMonitor(), vi.fn(), logger)
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalled())
  })
})

describe('CommandConfirmation immediate-run gate (V03: the confirmation inputs minus owner focus)', () => {
  it('reads the same live inputs the confirmation policy reads, and focus is not one of them', () => {
    const { confirmation, state } = createConfirmation()
    initialize(confirmation, new FakePowerMonitor())
    state.owner!.focused = false
    const gate = confirmation.immediateRunGate()
    expect(gate).toMatchObject({
      authenticated: true,
      listenEntitled: true,
      ownerPresent: true,
      ownerVisible: true,
      onboardingExclusive: false,
      lifecycleHooksReady: true
    })
    expect(Object.keys(gate)).not.toContain('ownerFocused')
  })

  it('follows each input as it changes', () => {
    const { confirmation, state } = createConfirmation()
    expect(confirmation.immediateRunGate().lifecycleHooksReady).toBe(false) // hooks not registered yet
    initialize(confirmation, new FakePowerMonitor())
    state.authenticated = false
    state.listenEntitled = false
    state.onboardingExclusive = true
    state.owner = { destroyed: false, visible: false, focused: true }
    expect(confirmation.immediateRunGate()).toMatchObject({
      authenticated: false,
      listenEntitled: false,
      onboardingExclusive: true,
      ownerPresent: true,
      ownerVisible: false
    })
    state.owner = { destroyed: true, visible: true, focused: true }
    expect(confirmation.immediateRunGate()).toMatchObject({
      ownerPresent: false,
      ownerVisible: false,
      ownerWebContentsId: null
    })
    state.owner = null
    expect(confirmation.immediateRunGate()).toMatchObject({ ownerPresent: false, ownerVisible: false })
  })

  it('a failed lifecycle hook leaves the gate closed', () => {
    const { confirmation } = createConfirmation()
    initialize(confirmation, new FakePowerMonitor('lock-screen'))
    expect(confirmation.immediateRunGate().lifecycleHooksReady).toBe(false)
  })

  it('names the owner window id only when the window exposes one', () => {
    const state = { id: 17 as number | undefined }
    const confirmation = new CommandConfirmation({
      execute: vi.fn(),
      isAuthenticated: () => true,
      hasListenEntitlement: () => true,
      getOwner: () => ({
        isDestroyed: () => false,
        isVisible: () => true,
        isFocused: () => false,
        webContents: { id: state.id, send: vi.fn() }
      }),
      isOnboardingExclusive: () => false,
      audit: vi.fn()
    })
    expect(confirmation.immediateRunGate().ownerWebContentsId).toBe(17)
    state.id = undefined
    expect(confirmation.immediateRunGate().ownerWebContentsId).toBeNull()
  })
})
