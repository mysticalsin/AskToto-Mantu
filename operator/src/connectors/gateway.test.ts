/**
 * Focused coverage for the per-tool disabled switch (plan 6.10c, finding 8): a `tools/call` naming
 * a tool an admin switched off on the Tools tab must be refused before either dispatch path
 * (REST-adapter or MCP-proxy) ever touches the network - see `handleMcpGateway`'s own doc comment
 * for where that check sits. This file does not attempt full gateway coverage (auth, rate limiting,
 * scope) - none of that changed here; it isolates the one new behaviour this task added.
 */
import { describe, expect, it, vi } from 'vitest'
import { encryptVault } from '../crypto'
import { memoryStore, type IntegrationRow, type SeatRow } from '../store'
import { TEST_INGEST_SECRET, TEST_VAULT_KEY } from '../test-fixtures'
import { mintGatewayToken } from './gateway-token'
import { handleMcpGateway, type GatewayEnv } from './gateway'

// Real wall-clock time, not a fixed historical constant like most fixtures in this codebase use:
// adapters/shared.ts#resolveThenValidate's DNS-over-HTTPS lookup (called from the REST adapter's
// dispatch path this suite exercises) defaults its own deadline check to the real `Date.now`, so a
// fixed-in-the-past `NOW` would make `deadlineAt - Date.now()` negative and short-circuit the
// lookup to "no addresses" before `fetchImpl` is ever called - indistinguishable, from this
// suite's own assertions, from this task's new disabled-tool refusal. Using the real clock keeps
// that unrelated deadline math out of the way of what this file actually tests.
const NOW = Date.now()

function seat(overrides: Partial<SeatRow> & Pick<SeatRow, 'device_id'>): SeatRow {
  return {
    seat_hash: 'seat',
    os: 'darwin',
    app_version: '1.8.5',
    first_seen: NOW,
    last_seen: NOW,
    country: 'CA',
    city: 'Longueuil',
    region: null,
    lat: null,
    lon: null,
    last_index_at: null,
    hostname: 'Tonys-MacBook-Pro',
    sso_email: 'twalteur@amaris.com',
    license: 'approved',
    approval: 'approved',
    ...overrides
  }
}

/** A brokered, REST-transport, write-allowed HubSpot connection - the extra columns (operator/src/
 *  connectors/data.ts) as plain properties, exactly how a real D1 `SELECT *` row or the in-memory
 *  store carries them (`readIntegrationExtra` reads these off any object shape). */
async function hubspotRow(id: string, disabledTools: string[]): Promise<IntegrationRow> {
  const enc = await encryptVault('pat-secret-token', TEST_VAULT_KEY)
  return {
    id,
    kind: 'hubspot',
    label: 'Hubspot prod',
    base_url: 'https://api.hubapi.com',
    cipher: enc.cipher,
    iv: enc.iv,
    last4: 'oken',
    scope_json: '{}',
    status: 'active',
    created_at: NOW - 1000,
    created_by: 'tony.walteur@gmail.com',
    rotated_at: null,
    revoked_at: null,
    last_used_at: null,
    uses: 0,
    mode: 'brokered',
    allow_writes: 1,
    transport: 'rest',
    config_json: '{}',
    disabled_tools_json: JSON.stringify(disabledTools)
  } as unknown as IntegrationRow
}

function gatewayEnv(): GatewayEnv {
  return { OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET, OPERATOR_VAULT_KEY: TEST_VAULT_KEY }
}

function toolsCallRequest(token: string, toolName: string): Request {
  return new Request('https://operator.test/v1/mcp/int-1', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: {} } })
  })
}

describe('handleMcpGateway: per-tool disabled switch (finding 8)', () => {
  it('refuses a disabled REST-adapter tool before any network fetch runs', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'device-a-0001' }))
    await store.putIntegration(await hubspotRow('int-1', ['create_contact']))
    const token = await mintGatewayToken(TEST_INGEST_SECRET, 'device-a-0001', 'int-1', NOW)
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 500 }))

    const res = await handleMcpGateway(toolsCallRequest(token, 'create_contact'), store, gatewayEnv(), 'int-1', NOW, { fetch: fetchSpy })
    const body = (await res.json()) as { result: { content: { text: string }[]; isError: boolean } }
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toContain('switched off')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('still dispatches a tool that is not in disabledTools', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'device-a-0001' }))
    await store.putIntegration(await hubspotRow('int-1', ['create_contact']))
    const token = await mintGatewayToken(TEST_INGEST_SECRET, 'device-a-0001', 'int-1', NOW)
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 500 }))

    const res = await handleMcpGateway(toolsCallRequest(token, 'list_contacts'), store, gatewayEnv(), 'int-1', NOW, { fetch: fetchSpy })
    const body = (await res.json()) as { result: { content: { text: string }[]; isError: boolean } }
    expect(body.result.content[0].text).not.toContain('switched off')
    expect(fetchSpy).toHaveBeenCalled()
  })

  it('an empty disabledTools list refuses nothing', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'device-a-0001' }))
    await store.putIntegration(await hubspotRow('int-1', []))
    const token = await mintGatewayToken(TEST_INGEST_SECRET, 'device-a-0001', 'int-1', NOW)
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 500 }))

    const res = await handleMcpGateway(toolsCallRequest(token, 'list_contacts'), store, gatewayEnv(), 'int-1', NOW, { fetch: fetchSpy })
    const body = (await res.json()) as { result: { content: { text: string }[]; isError: boolean } }
    expect(body.result.content[0].text).not.toContain('switched off')
    expect(fetchSpy).toHaveBeenCalled()
  })
})
