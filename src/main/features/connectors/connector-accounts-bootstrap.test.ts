import { describe, expect, it, vi } from 'vitest'
import type { GraphTokenOutcome } from '../../auth-graph-token-outcome'
import { createMemoryConnectorAccountStore } from './account-store'
import { bootstrapConnectorAccounts } from './connector-accounts-bootstrap'

const SCOPE = { ownerKey: 'a'.repeat(64), tenantKey: 'b'.repeat(64) }

function setup(verifyCurrentIdentity: () => Promise<GraphTokenOutcome>) {
  return bootstrapConnectorAccounts({
    ipcMain: { handle: vi.fn() } as never,
    assertMainWindow: vi.fn(),
    requireAuth: () => true,
    ownerSession: {
      currentOwnerKey: () => SCOPE.ownerKey,
      currentTenantKey: () => SCOPE.tenantKey,
      onRevoked: vi.fn(() => () => undefined)
    },
    userDataPath: () => '/unused-in-test',
    onWillQuit: vi.fn(),
    identity: () => ({ signedIn: true, email: 'alice@example.test' }),
    accountStore: createMemoryConnectorAccountStore(),
    verifyCurrentIdentity
  })
}

describe('connector account bootstrap', () => {
  it('keeps registration connecting and completes onboarding only after a token success signal', async () => {
    const verify = vi.fn(async () => ({ ok: true as const, token: 'synthetic-token' }))
    const bootstrap = setup(verify)
    const ref = await bootstrap.ensureCurrentAccount('outlook')
    expect((await bootstrap.registry.listViews())[0]).toMatchObject({ accountRef: ref, health: 'connecting' })
    expect(verify).not.toHaveBeenCalled()

    const flow = await bootstrap.registry.beginOnboarding({ kind: 'outlook', label: 'Personal' })
    await bootstrap.ensureCurrentAccount('outlook')

    expect(verify).toHaveBeenCalledOnce()
    expect(await bootstrap.registry.listFlowHistory()).toMatchObject([
      { flowId: flow.flowId, status: 'completed', accountRef: ref }
    ])
    expect(await bootstrap.registry.listViews()).toMatchObject([
      { accountRef: ref, label: 'Personal', health: 'healthy', reason: 'token_refresh_succeeded' }
    ])
  })

  it('leaves an interrupted flow paused and the account needing reauthentication after interaction is required', async () => {
    const bootstrap = setup(async () => ({ ok: false, reason: 'interaction_required' }))
    await bootstrap.ensureCurrentAccount('outlook')
    const flow = await bootstrap.registry.beginOnboarding({ kind: 'outlook', label: 'Work' })
    await bootstrap.ensureCurrentAccount('outlook')
    expect(await bootstrap.registry.listOnboardingFlows()).toMatchObject([{ flowId: flow.flowId, status: 'paused' }])
    expect(await bootstrap.registry.listViews()).toMatchObject([
      { health: 'needs_reauth', reason: 'token_refresh_rejected' }
    ])
  })

  it('keeps the existing onboarding reauth signal when token setup is not configured', async () => {
    const bootstrap = setup(async () => ({ ok: false, reason: 'not_configured' }))
    await bootstrap.ensureCurrentAccount('outlook')
    const flow = await bootstrap.registry.beginOnboarding({ kind: 'outlook', label: 'Work' })

    await bootstrap.ensureCurrentAccount('outlook')

    expect(await bootstrap.registry.listOnboardingFlows()).toMatchObject([{ flowId: flow.flowId, status: 'paused' }])
    expect(await bootstrap.registry.listViews()).toMatchObject([
      { health: 'needs_reauth', reason: 'token_refresh_rejected' }
    ])
  })

  it('apple_calendar is a separate owner-scoped account that never starts an Outlook onboarding verify', async () => {
    const verify = vi.fn(async () => ({ ok: true as const, token: 'synthetic-token' }))
    const bootstrap = setup(verify)
    const outlook = await bootstrap.ensureCurrentAccount('outlook')
    await bootstrap.registry.beginOnboarding({ kind: 'outlook', label: 'Work' })
    const apple = await bootstrap.ensureCurrentAccount('apple_calendar')
    expect(apple).toBeTruthy()
    expect(apple).not.toBe(outlook)
    expect(verify).not.toHaveBeenCalled()
    expect(await bootstrap.registry.listOnboardingFlows()).toMatchObject([{ status: 'pending' }])
    expect(await bootstrap.ensureCurrentAccount('apple_calendar')).toBe(apple)
  })

  it('apple_calendar refuses without a signed-in Métis owner', async () => {
    const bootstrap = bootstrapConnectorAccounts({
      ipcMain: { handle: vi.fn() } as never,
      assertMainWindow: vi.fn(),
      requireAuth: () => true,
      ownerSession: {
        currentOwnerKey: () => SCOPE.ownerKey,
        currentTenantKey: () => SCOPE.tenantKey,
        onRevoked: vi.fn(() => () => undefined)
      },
      userDataPath: () => '/unused-in-test',
      onWillQuit: vi.fn(),
      identity: () => ({ signedIn: false }),
      accountStore: createMemoryConnectorAccountStore()
    })
    expect(await bootstrap.ensureCurrentAccount('apple_calendar')).toBeNull()
  })

  it('keeps onboarding degraded rather than requiring reauthentication after a thrown network error', async () => {
    const bootstrap = setup(async () => {
      throw new Error('network timeout with provider detail')
    })
    await bootstrap.ensureCurrentAccount('outlook')
    const flow = await bootstrap.registry.beginOnboarding({ kind: 'outlook', label: 'Work' })

    await bootstrap.ensureCurrentAccount('outlook')

    expect(await bootstrap.registry.listOnboardingFlows()).toMatchObject([{ flowId: flow.flowId, status: 'paused' }])
    expect(await bootstrap.registry.listViews()).toMatchObject([
      { health: 'degraded', reason: 'token_refresh_transient' }
    ])
  })
})
