import { describe, expect, it, vi } from 'vitest'
import { createMemoryConnectorAccountStore } from './account-store'
import { bootstrapConnectorAccounts } from './connector-accounts-bootstrap'

const SCOPE = { ownerKey: 'a'.repeat(64), tenantKey: 'b'.repeat(64) }

function setup(verifyCurrentIdentity: () => Promise<string | null>) {
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
    const verify = vi.fn(async () => 'token')
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

  it('leaves an interrupted flow paused and the account needing reauthentication after a rejected token check', async () => {
    const bootstrap = setup(async () => null)
    await bootstrap.ensureCurrentAccount('outlook')
    const flow = await bootstrap.registry.beginOnboarding({ kind: 'outlook', label: 'Work' })
    await bootstrap.ensureCurrentAccount('outlook')
    expect(await bootstrap.registry.listOnboardingFlows()).toMatchObject([
      { flowId: flow.flowId, status: 'paused' }
    ])
    expect(await bootstrap.registry.listViews()).toMatchObject([{ health: 'needs_reauth' }])
  })
})
