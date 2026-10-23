import { describe, expect, it, vi } from 'vitest'
import { CONNECTOR_ACCOUNTS_IPC } from '@shared/connector-accounts'
import { createConnectorAccountsPreloadApi } from './connector-accounts'

describe('connector account preload API', () => {
  it('invokes only the typed connector account channels with bounded payloads', async () => {
    const invoke = vi.fn(async (channel: string) => ({ ok: true, channel }))
    const api = createConnectorAccountsPreloadApi({ invoke } as never)
    await api.connectorAccounts.list()
    await api.connectorAccounts.listOnboarding()
    await api.connectorAccounts.begin({ kind: 'outlook', label: 'Work' })
    await api.connectorAccounts.resume('00000000-0000-4000-8000-000000000001')
    await api.connectorAccounts.abandon('00000000-0000-4000-8000-000000000001')
    expect(invoke.mock.calls).toEqual([
      [CONNECTOR_ACCOUNTS_IPC.list, {}],
      [CONNECTOR_ACCOUNTS_IPC.listOnboarding, {}],
      [CONNECTOR_ACCOUNTS_IPC.begin, { kind: 'outlook', label: 'Work' }],
      [CONNECTOR_ACCOUNTS_IPC.resume, { flowId: '00000000-0000-4000-8000-000000000001' }],
      [CONNECTOR_ACCOUNTS_IPC.abandon, { flowId: '00000000-0000-4000-8000-000000000001' }]
    ])
  })
})
