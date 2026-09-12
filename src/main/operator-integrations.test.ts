import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => '1.8.0-test' } }))
vi.mock('./license', () => ({ getMachineId: () => 'machine-test-0001' }))
vi.mock('./logger', () => ({
  mainLog: { warn: () => {}, info: () => {}, error: () => {} },
  setAuditActor: () => {},
  auditLog: () => {}
}))

const connectMcpMock = vi.fn()
const pushToMcpMock = vi.fn()
vi.mock('./mcp/mcpClient', () => ({
  connectMcp: (...args: unknown[]) => connectMcpMock(...args),
  pushToMcp: (...args: unknown[]) => pushToMcpMock(...args)
}))

import {
  callOperatorMcpTool,
  emptyOperatorIntegrationsCache,
  fetchOperatorIntegrations,
  maybeRefreshOperatorIntegrations,
  operatorCrmCredentialFor,
  operatorIntegrationFor,
  operatorIntegrationsSnapshot,
  operatorMcpServer,
  reconcileOperatorMcpRegistry,
  registeredOperatorMcpServers,
  resetOperatorIntegrationsStateForTests,
  resolveCrmCredentialSource,
  setOperatorIntegrationsFetchForTests,
  shouldRefetchOperatorIntegrations,
  type OperatorMcpRegistration
} from './operator-integrations'
import type { OperatorIntegration } from '@shared/operator-entitlements'

const SETTINGS = { operatorUrl: 'https://operator.test', operatorIngestSecret: 'shared-secret' }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const hubspot: OperatorIntegration = {
  id: 'int-hubspot',
  kind: 'hubspot',
  label: 'HubSpot',
  baseUrl: 'https://hubspot.example/mcp',
  credential: 'hs-key-1',
  scopes: []
}
const customMcp: OperatorIntegration = {
  id: 'int-custom',
  kind: 'custom-mcp',
  label: 'Internal Tools',
  baseUrl: 'https://internal.example/mcp',
  credential: 'tok-1',
  scopes: []
}
const plane: OperatorIntegration = {
  id: 'int-plane',
  kind: 'plane',
  label: 'Plane',
  baseUrl: 'https://plane.example/mcp',
  credential: 'plane-tok-1',
  scopes: []
}

beforeEach(() => {
  resetOperatorIntegrationsStateForTests()
  connectMcpMock.mockReset()
  pushToMcpMock.mockReset()
  connectMcpMock.mockResolvedValue({ ok: true, tools: [] })
})
afterEach(() => {
  setOperatorIntegrationsFetchForTests(null)
  resetOperatorIntegrationsStateForTests()
})

describe('shouldRefetchOperatorIntegrations', () => {
  it('refetches when nothing has been fetched yet', () => {
    expect(shouldRefetchOperatorIntegrations(emptyOperatorIntegrationsCache(), 0, 1000)).toBe(true)
  })
  it('refetches when the heartbeat-reported version moved', () => {
    const cache = { version: 1, fetchedAt: 1000, integrations: [] }
    expect(shouldRefetchOperatorIntegrations(cache, 2, 1500)).toBe(true)
  })
  it('does not refetch when the version matches and the cache is fresh', () => {
    const cache = { version: 1, fetchedAt: 1000, integrations: [] }
    expect(shouldRefetchOperatorIntegrations(cache, 1, 1000 + 60_000)).toBe(false)
  })
  it('refetches once the 6h cache goes stale even with the same version', () => {
    const cache = { version: 1, fetchedAt: 1000, integrations: [] }
    expect(shouldRefetchOperatorIntegrations(cache, 1, 1000 + 6 * 60 * 60 * 1000)).toBe(true)
  })
})

describe('reconcileOperatorMcpRegistry (register / replace / remove)', () => {
  it('registers a new integration not previously in the registry', () => {
    const next = reconcileOperatorMcpRegistry(new Map(), [customMcp])
    expect(next.size).toBe(1)
    const reg = next.get('int-custom')!
    expect(reg.baseUrl).toBe(customMcp.baseUrl)
    expect(reg.credential).toBe(customMcp.credential)
    expect(reg.tools).toBeUndefined() // not discovered yet
  })

  it('keeps discovered tools when the same id is unchanged across a reconcile', () => {
    const current = new Map<string, OperatorMcpRegistration>([
      ['int-custom', { id: 'int-custom', kind: 'custom-mcp', label: 'Internal Tools', baseUrl: customMcp.baseUrl!, credential: customMcp.credential!, tools: ['do_thing'] }]
    ])
    const next = reconcileOperatorMcpRegistry(current, [customMcp])
    expect(next.get('int-custom')?.tools).toEqual(['do_thing'])
  })

  it('replaces on version change: same id, new baseUrl/credential resets tools for rediscovery', () => {
    const current = new Map<string, OperatorMcpRegistration>([
      ['int-custom', { id: 'int-custom', kind: 'custom-mcp', label: 'Internal Tools', baseUrl: customMcp.baseUrl!, credential: customMcp.credential!, tools: ['old_tool'] }]
    ])
    const rotated: OperatorIntegration = { ...customMcp, credential: 'tok-2' }
    const next = reconcileOperatorMcpRegistry(current, [rotated])
    const reg = next.get('int-custom')!
    expect(reg.credential).toBe('tok-2')
    expect(reg.tools).toBeUndefined()
  })

  it('removes an id no longer present in the delivered list', () => {
    const current = new Map<string, OperatorMcpRegistration>([
      ['int-custom', { id: 'int-custom', kind: 'custom-mcp', label: 'Internal Tools', baseUrl: customMcp.baseUrl!, credential: customMcp.credential!, tools: [] }]
    ])
    const next = reconcileOperatorMcpRegistry(current, [])
    expect(next.has('int-custom')).toBe(false)
    expect(next.size).toBe(0)
  })

  it('handles register + replace + remove all in one reconcile', () => {
    const current = new Map<string, OperatorMcpRegistration>([
      ['keep-same', { id: 'keep-same', kind: 'custom-mcp', label: 'Keep', baseUrl: 'https://k.example', credential: 'k1', tools: ['t1'] }],
      ['gone', { id: 'gone', kind: 'custom-mcp', label: 'Gone', baseUrl: 'https://g.example', credential: 'g1', tools: ['t2'] }],
      ['rotate', { id: 'rotate', kind: 'custom-mcp', label: 'Rotate', baseUrl: 'https://r.example', credential: 'old', tools: ['t3'] }]
    ])
    const delivered: OperatorIntegration[] = [
      { id: 'keep-same', kind: 'custom-mcp', label: 'Keep', baseUrl: 'https://k.example', credential: 'k1', scopes: [] },
      { id: 'rotate', kind: 'custom-mcp', label: 'Rotate', baseUrl: 'https://r.example', credential: 'new', scopes: [] },
      { id: 'brand-new', kind: 'custom-mcp', label: 'Brand new', baseUrl: 'https://n.example', credential: 'n1', scopes: [] }
    ]
    const next = reconcileOperatorMcpRegistry(current, delivered)
    expect([...next.keys()].sort()).toEqual(['brand-new', 'keep-same', 'rotate'])
    expect(next.get('keep-same')?.tools).toEqual(['t1']) // unchanged, tools preserved
    expect(next.get('rotate')?.tools).toBeUndefined() // credential changed, needs rediscovery
    expect(next.get('brand-new')?.tools).toBeUndefined() // newly registered
  })

  it('skips an integration with no baseUrl or no credential yet', () => {
    const incomplete: OperatorIntegration = { id: 'incomplete', kind: 'notion', label: 'Notion', baseUrl: null, credential: null, scopes: [] }
    const next = reconcileOperatorMcpRegistry(new Map(), [incomplete])
    expect(next.size).toBe(0)
  })
})

describe('MQA-295 fetchOperatorIntegrations credential isolation', () => {
  it('never forwards a licence credential through an HTTP redirect', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.test' } }))
    setOperatorIntegrationsFetchForTests(fetcher as typeof fetch)
    await fetchOperatorIntegrations({ ...SETTINGS, operatorLicenseToken: 'METIS-OP-1.fixture' })
    expect(fetcher).toHaveBeenCalledWith('https://operator.test/v1/integrations', expect.objectContaining({
      redirect: 'manual',
      headers: expect.objectContaining({ 'x-metis-license': 'METIS-OP-1.fixture' })
    }))
  })

  it('cannot restore credentials from a pending request after the connection is cleared', async () => {
    let complete!: (response: Response) => void
    setOperatorIntegrationsFetchForTests(() => new Promise((resolve) => { complete = resolve }))
    const pending = fetchOperatorIntegrations(SETTINGS)
    resetOperatorIntegrationsStateForTests()
    complete(jsonResponse({ ok: true, version: 1, integrations: [customMcp] }))
    expect(await pending).toBeNull()
    expect(operatorIntegrationsSnapshot().integrations).toEqual([])
    expect(registeredOperatorMcpServers()).toEqual([])
    expect(connectMcpMock).not.toHaveBeenCalled()
  })

  it.each([200, 403])('does not let an old connection response (%s) overwrite the new connection', async (status) => {
    let complete!: (response: Response) => void
    const fetcher = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, version: 2, integrations: [plane] }))
    setOperatorIntegrationsFetchForTests(fetcher as typeof fetch)
    const old = fetchOperatorIntegrations(SETTINGS)
    const replacement = fetchOperatorIntegrations({ ...SETTINGS, operatorLicenseToken: 'METIS-OP-1.replacement' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    await replacement
    complete(jsonResponse({ ok: true, version: 1, integrations: [customMcp] }, status))
    expect(await old).toBeNull()
    expect(operatorIntegrationFor('plane')?.id).toBe(plane.id)
    expect(operatorIntegrationFor('custom-mcp')).toBeNull()
  })

  it('fetches, caches, and registers custom-mcp connections', async () => {
    setOperatorIntegrationsFetchForTests((async () => jsonResponse({ ok: true, version: 1, integrations: [customMcp] })) as typeof fetch)
    const result = await fetchOperatorIntegrations(SETTINGS)
    expect(result).toHaveLength(1)
    expect(operatorIntegrationsSnapshot().version).toBe(1)
    expect(operatorIntegrationFor('custom-mcp')?.id).toBe('int-custom')
    // Background tool discovery is fire-and-forget; give it a tick.
    await Promise.resolve()
    await Promise.resolve()
    expect(connectMcpMock).toHaveBeenCalledWith(customMcp.baseUrl, customMcp.credential, {}, customMcp.label)
  })

  it('registration point: registeredOperatorMcpServers reflects the reconciled registry after a fetch', async () => {
    setOperatorIntegrationsFetchForTests((async () => jsonResponse({ ok: true, version: 1, integrations: [customMcp] })) as typeof fetch)
    await fetchOperatorIntegrations(SETTINGS)
    const servers = registeredOperatorMcpServers()
    expect(servers).toHaveLength(1)
    expect(servers[0].id).toBe('int-custom')
    expect(operatorMcpServer('int-custom')?.baseUrl).toBe(customMcp.baseUrl)
  })

  it('replaces the registry on a version-bumped fetch with a rotated credential', async () => {
    setOperatorIntegrationsFetchForTests((async () => jsonResponse({ ok: true, version: 1, integrations: [customMcp] })) as typeof fetch)
    await fetchOperatorIntegrations(SETTINGS)
    const rotated = { ...customMcp, credential: 'tok-rotated' }
    setOperatorIntegrationsFetchForTests((async () => jsonResponse({ ok: true, version: 2, integrations: [rotated] })) as typeof fetch)
    await fetchOperatorIntegrations(SETTINGS)
    expect(operatorMcpServer('int-custom')?.credential).toBe('tok-rotated')
  })

  it('removes a connection the Operator stops delivering', async () => {
    setOperatorIntegrationsFetchForTests((async () => jsonResponse({ ok: true, version: 1, integrations: [customMcp] })) as typeof fetch)
    await fetchOperatorIntegrations(SETTINGS)
    expect(operatorMcpServer('int-custom')).not.toBeNull()
    setOperatorIntegrationsFetchForTests((async () => jsonResponse({ ok: true, version: 2, integrations: [] })) as typeof fetch)
    await fetchOperatorIntegrations(SETTINGS)
    expect(operatorMcpServer('int-custom')).toBeNull()
    expect(registeredOperatorMcpServers()).toHaveLength(0)
  })

  it('clears the cache on a 403 (seat not entitled) instead of erroring', async () => {
    setOperatorIntegrationsFetchForTests((async () => jsonResponse({ ok: true, version: 1, integrations: [hubspot] })) as typeof fetch)
    await fetchOperatorIntegrations(SETTINGS)
    setOperatorIntegrationsFetchForTests((async () => jsonResponse({ ok: false, error: 'seat not entitled', code: 'not-entitled' }, 403)) as typeof fetch)
    const result = await fetchOperatorIntegrations(SETTINGS)
    expect(result).toEqual([])
    expect(operatorIntegrationFor('hubspot')).toBeNull()
  })

  it('returns null and never clears the cache on a transient network failure', async () => {
    setOperatorIntegrationsFetchForTests((async () => jsonResponse({ ok: true, version: 1, integrations: [hubspot] })) as typeof fetch)
    await fetchOperatorIntegrations(SETTINGS)
    setOperatorIntegrationsFetchForTests((async () => {
      throw new Error('network down')
    }) as typeof fetch)
    const result = await fetchOperatorIntegrations(SETTINGS)
    expect(result).toBeNull()
    expect(operatorIntegrationFor('hubspot')?.id).toBe('int-hubspot') // untouched
  })

  it('returns null when Operator is not configured, without making a network call', async () => {
    const fn = vi.fn()
    setOperatorIntegrationsFetchForTests(fn as unknown as typeof fetch)
    const result = await fetchOperatorIntegrations({ operatorUrl: '', operatorIngestSecret: '' })
    expect(result).toBeNull()
    expect(fn).not.toHaveBeenCalled()
  })

  it('shares one in-flight request across concurrent callers', async () => {
    let calls = 0
    setOperatorIntegrationsFetchForTests((async () => {
      calls++
      await new Promise((r) => setTimeout(r, 5))
      return jsonResponse({ ok: true, version: 1, integrations: [hubspot] })
    }) as typeof fetch)
    const [a, b] = await Promise.all([fetchOperatorIntegrations(SETTINGS), fetchOperatorIntegrations(SETTINGS)])
    expect(calls).toBe(1)
    expect(a).toEqual(b)
  })
})

describe('maybeRefreshOperatorIntegrations', () => {
  it('refetches a changed connection even if its reported version matches the previous one', async () => {
    setOperatorIntegrationsFetchForTests(async () => jsonResponse({ ok: true, version: 1, integrations: [hubspot] }))
    await fetchOperatorIntegrations(SETTINGS, 1000)
    const fetcher = vi.fn(async () => jsonResponse({ ok: true, version: 1, integrations: [plane] }))
    setOperatorIntegrationsFetchForTests(fetcher as typeof fetch)
    maybeRefreshOperatorIntegrations({ ...SETTINGS, operatorLicenseToken: 'METIS-OP-1.replacement' }, 1, 2000)
    expect(fetcher).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(operatorIntegrationFor('plane')?.id).toBe(plane.id))
    expect(operatorIntegrationFor('hubspot')).toBeNull()
  })

  it('triggers a fetch when the version changed', async () => {
    const fn = vi.fn(async () => jsonResponse({ ok: true, version: 5, integrations: [] }))
    setOperatorIntegrationsFetchForTests(fn as unknown as typeof fetch)
    maybeRefreshOperatorIntegrations(SETTINGS, 5, 1000)
    await Promise.resolve()
    await Promise.resolve()
    expect(fn).toHaveBeenCalledTimes(1)
  })
  it('does nothing when the cache is already fresh for that version', async () => {
    setOperatorIntegrationsFetchForTests((async () => jsonResponse({ ok: true, version: 1, integrations: [] })) as typeof fetch)
    await fetchOperatorIntegrations(SETTINGS, 1000)
    const fn = vi.fn()
    setOperatorIntegrationsFetchForTests(fn as unknown as typeof fetch)
    maybeRefreshOperatorIntegrations(SETTINGS, 1, 1000 + 1000)
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('callOperatorMcpTool', () => {
  it('refuses an unregistered connection id', async () => {
    const result = await callOperatorMcpTool('unknown-id', 'do_thing', {})
    expect(result).toEqual({ ok: false, error: 'This Operator connection is not available.' })
  })

  it('refuses a tool not in the discovered tool list', async () => {
    setOperatorIntegrationsFetchForTests((async () => jsonResponse({ ok: true, version: 1, integrations: [customMcp] })) as typeof fetch)
    await fetchOperatorIntegrations(SETTINGS)
    connectMcpMock.mockResolvedValue({ ok: true, tools: ['known_tool'] })
    await new Promise((r) => setTimeout(r, 0))
    const result = await callOperatorMcpTool('int-custom', 'unknown_tool', {})
    expect(result.ok).toBe(false)
  })

  it('pushes through pushToMcp with the registered baseUrl/credential', async () => {
    setOperatorIntegrationsFetchForTests((async () => jsonResponse({ ok: true, version: 1, integrations: [customMcp] })) as typeof fetch)
    connectMcpMock.mockResolvedValue({ ok: true, tools: ['do_thing'] })
    await fetchOperatorIntegrations(SETTINGS)
    await new Promise((r) => setTimeout(r, 0))
    pushToMcpMock.mockResolvedValue({ ok: true, result: { id: '123' } })
    const result = await callOperatorMcpTool('int-custom', 'do_thing', { a: 1 })
    expect(result).toEqual({ ok: true, result: { id: '123' } })
    expect(pushToMcpMock).toHaveBeenCalledWith(customMcp.baseUrl, customMcp.credential, {}, 'do_thing', { a: 1 }, customMcp.label)
  })
})

describe('operatorCrmCredentialFor', () => {
  it('returns a credential for plane when Operator supplies one', async () => {
    setOperatorIntegrationsFetchForTests((async () => jsonResponse({ ok: true, version: 1, integrations: [plane] })) as typeof fetch)
    await fetchOperatorIntegrations(SETTINGS)
    const cred = operatorCrmCredentialFor('plane')
    expect(cred).not.toBeNull()
    expect(cred?.endpointUrl).toBe(plane.baseUrl)
    expect(cred?.apiKey).toBe(plane.credential)
  })

  it('returns null for clickup even when Operator supplies one (OAuth-only local flow)', async () => {
    const clickup: OperatorIntegration = { id: 'int-clickup', kind: 'clickup', label: 'ClickUp', baseUrl: 'https://cu.example', credential: 'cu-tok', scopes: [] }
    setOperatorIntegrationsFetchForTests((async () => jsonResponse({ ok: true, version: 1, integrations: [clickup] })) as typeof fetch)
    await fetchOperatorIntegrations(SETTINGS)
    expect(operatorCrmCredentialFor('clickup')).toBeNull()
  })

  it('returns null when there is no matching integration at all', () => {
    expect(operatorCrmCredentialFor('plane')).toBeNull()
  })
})

describe('resolveCrmCredentialSource', () => {
  it('prefers local whenever it is actually usable', () => {
    expect(resolveCrmCredentialSource(true, true)).toBe('local')
    expect(resolveCrmCredentialSource(true, false)).toBe('local')
  })
  it('falls back to operator only when local is not usable and an operator credential exists', () => {
    expect(resolveCrmCredentialSource(false, true)).toBe('operator')
  })
  it('defaults to local when neither is available (no misleading operator claim)', () => {
    expect(resolveCrmCredentialSource(false, false)).toBe('local')
  })
})
