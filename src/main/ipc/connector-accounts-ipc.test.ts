import { describe, expect, it, vi } from 'vitest'
import { CONNECTOR_ACCOUNTS_IPC } from '@shared/connector-accounts'
import { registerConnectorAccountsIpc } from './connector-accounts-ipc'

type Handler = (event: unknown, payload?: unknown) => unknown

function setup(over: { auth?: boolean } = {}) {
  const handlers = new Map<string, Handler>()
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler))
  }
  const assertMainWindow = vi.fn()
  const requireAuth = vi.fn(() => over.auth ?? true)
  const flow = {
    flowId: '00000000-0000-4000-8000-000000000001',
    kind: 'outlook',
    label: 'Work',
    status: 'pending',
    startedAt: 1,
    updatedAt: 1,
    expiresAt: 600001
  }
  const registry = {
    prepareCurrentScope: vi.fn(async () => undefined),
    listViews: vi.fn(async () => []),
    listOnboardingFlows: vi.fn(async () => []),
    beginOnboarding: vi.fn(async () => flow),
    resumeOnboarding: vi.fn(async () => ({ ok: true, flow })),
    abandonOnboarding: vi.fn(async () => ({ ok: true, flow: { ...flow, status: 'abandoned', reason: 'abandoned' } }))
  }
  registerConnectorAccountsIpc(ipcMain as never, { assertMainWindow, requireAuth, registry: registry as never })
  const invoke = (channel: string, payload: unknown = {}) => handlers.get(channel)?.({ sender: 'test' }, payload)
  return { handlers, invoke, assertMainWindow, requireAuth, registry }
}

describe('connector account IPC', () => {
  it('registers account and onboarding views behind the live-window and auth gates', async () => {
    const s = setup()
    expect(s.handlers.has(CONNECTOR_ACCOUNTS_IPC.list)).toBe(true)
    const result = await s.invoke(CONNECTOR_ACCOUNTS_IPC.list)
    expect(s.assertMainWindow).toHaveBeenCalledOnce()
    expect(s.requireAuth).toHaveBeenCalledOnce()
    expect(s.registry.listViews).toHaveBeenCalledOnce()
    expect(result).toEqual({ ok: true, accounts: [] })
  })

  it('does not read account state when auth is unavailable', async () => {
    const s = setup({ auth: false })
    expect(await s.invoke(CONNECTOR_ACCOUNTS_IPC.list)).toEqual({ ok: false, error: 'auth_required' })
    expect(s.registry.listViews).not.toHaveBeenCalled()
  })

  it('strictly rejects extra fields before calling the registry', async () => {
    const s = setup()
    expect(await s.invoke(CONNECTOR_ACCOUNTS_IPC.list, { ownerKey: 'not-for-renderer' })).toEqual({
      ok: false,
      error: 'invalid_input'
    })
    expect(s.registry.listViews).not.toHaveBeenCalled()
  })

  it('authenticates every flow mutation and accepts only a validated flow id', async () => {
    const s = setup()
    const flowId = '00000000-0000-4000-8000-000000000001'
    expect(await s.invoke(CONNECTOR_ACCOUNTS_IPC.resume, { flowId })).toMatchObject({ ok: true })
    expect(s.registry.resumeOnboarding).toHaveBeenCalledWith(flowId)
    expect(s.assertMainWindow).toHaveBeenCalledOnce()
    expect(s.requireAuth).toHaveBeenCalledOnce()
    expect(await s.invoke(CONNECTOR_ACCOUNTS_IPC.abandon, { flowId, accountRef: 'hostile' })).toEqual({
      ok: false,
      error: 'invalid_input'
    })
    expect(s.registry.abandonOnboarding).not.toHaveBeenCalled()
  })
})
