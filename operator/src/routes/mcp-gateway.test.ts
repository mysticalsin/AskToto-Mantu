import { describe, expect, it, vi } from 'vitest'
import { handleRequest, type Env } from '../index'
import { encryptVault } from '../crypto'
import { mintGatewayToken } from '../connectors/gateway-token'
import { memoryStore, type IntegrationRow, type OperatorStore, type SeatRow } from '../store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY, TEST_ADMIN_EMAILS, TEST_VAULT_KEY } from '../test-fixtures'
import { handleIntegrationsSeat } from './integrations-seat'
import { MCP_GATEWAY_MAX_BODY_BYTES } from './mcp-gateway'

const NOW = 1_725_000_000_000
const DEVICE = 'device-a-0001'
const UPSTREAM = 'https://mcp.example.com/rpc'

const env: Env = {
  OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
  OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
  ADMIN_EMAILS: TEST_ADMIN_EMAILS,
  OPERATOR_SKILL_PRIVATE_KEY: '',
  OPERATOR_VAULT_KEY: TEST_VAULT_KEY
}

function seat(overrides: Partial<SeatRow> = {}): SeatRow {
  return {
    device_id: DEVICE,
    seat_hash: 'seat',
    os: 'darwin',
    app_version: '1.8.5',
    first_seen: NOW,
    last_seen: NOW,
    country: 'CA',
    city: null,
    region: null,
    lat: null,
    lon: null,
    last_index_at: null,
    hostname: 'Example-MacBook-Pro',
    sso_email: 'admin@example.test',
    license: 'approved',
    approval: 'approved',
    ...overrides
  }
}

async function brokeredRow(overrides: Partial<IntegrationRow> = {}): Promise<IntegrationRow> {
  const enc = await encryptVault('upstream-secret-token', TEST_VAULT_KEY)
  return {
    id: 'int-1',
    kind: 'custom-mcp',
    label: 'Internal MCP',
    base_url: UPSTREAM,
    cipher: enc.cipher,
    iv: enc.iv,
    last4: 'oken',
    scope_json: '{}',
    status: 'active',
    created_at: NOW - 1000,
    created_by: 'owner@example.test',
    rotated_at: null,
    revoked_at: null,
    last_used_at: null,
    uses: 0,
    mode: 'brokered',
    transport: 'mcp',
    ...overrides
  } as IntegrationRow
}

async function setup(row?: IntegrationRow): Promise<OperatorStore> {
  const store = memoryStore()
  await store.upsertSeat(seat())
  await store.putIntegration(row ?? (await brokeredRow()))
  return store
}

async function post(
  store: OperatorStore,
  path: string,
  token: string | null,
  body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
  upstream: typeof fetch = vi.fn(async () => new Response('{"result":{}}', { headers: { 'content-type': 'application/json' } })) as typeof fetch
): Promise<Response> {
  return handleRequest(
    new Request(`https://operator.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body
    }),
    env,
    {},
    { store, now: NOW, providerFetch: upstream }
  )
}

describe('POST /v1/mcp/:id (brokered gateway)', () => {
  it('routes the endpoint delivered by GET /v1/integrations and forwards with the vaulted credential', async () => {
    const store = await setup()
    const delivered = await (await handleIntegrationsSeat(store, env, DEVICE, NOW)).json() as {
      integrations: { endpoint: string; gatewayToken: string }[]
    }
    const { endpoint, gatewayToken } = delivered.integrations[0]
    const upstream = vi.fn(async () => new Response('{"result":{"tools":[]}}', { headers: { 'content-type': 'application/json' } }))

    const res = await post(store, endpoint, gatewayToken, undefined, upstream as unknown as typeof fetch)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ result: { tools: [] } })
    const [url, init] = upstream.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(UPSTREAM)
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer upstream-secret-token')
  })

  it('401s without a bearer token and with a forged one', async () => {
    const store = await setup()
    expect((await post(store, '/v1/mcp/int-1', null)).status).toBe(401)
    expect((await post(store, '/v1/mcp/int-1', 'aaa.bbb')).status).toBe(401)
  })

  it('403s a token minted for a different connection', async () => {
    const store = await setup()
    const token = await mintGatewayToken(TEST_INGEST_SECRET, DEVICE, 'other-connection', NOW)
    expect((await post(store, '/v1/mcp/int-1', token)).status).toBe(403)
  })

  it('401s an expired token', async () => {
    const store = await setup()
    const token = await mintGatewayToken(TEST_INGEST_SECRET, DEVICE, 'int-1', NOW - 2 * 60 * 60 * 1000)
    expect((await post(store, '/v1/mcp/int-1', token)).status).toBe(401)
  })

  it('404s once the connection is revoked, even with a live token', async () => {
    const store = await setup(await brokeredRow({ status: 'revoked' }))
    const token = await mintGatewayToken(TEST_INGEST_SECRET, DEVICE, 'int-1', NOW)
    expect((await post(store, '/v1/mcp/int-1', token)).status).toBe(404)
  })

  it('403s a seat that is no longer approved', async () => {
    const store = await setup()
    await store.updateSeatApproval(DEVICE, 'revoked')
    const token = await mintGatewayToken(TEST_INGEST_SECRET, DEVICE, 'int-1', NOW)
    expect((await post(store, '/v1/mcp/int-1', token)).status).toBe(403)
  })

  it('413s a body over the cap without calling upstream', async () => {
    const store = await setup()
    const token = await mintGatewayToken(TEST_INGEST_SECRET, DEVICE, 'int-1', NOW)
    const upstream = vi.fn()
    const res = await post(store, '/v1/mcp/int-1', token, 'x'.repeat(MCP_GATEWAY_MAX_BODY_BYTES + 1), upstream as unknown as typeof fetch)
    expect(res.status).toBe(413)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('does not serve a direct-mode connection', async () => {
    const store = await setup(await brokeredRow({ mode: 'direct' } as Partial<IntegrationRow>))
    const token = await mintGatewayToken(TEST_INGEST_SECRET, DEVICE, 'int-1', NOW)
    expect((await post(store, '/v1/mcp/int-1', token)).status).toBe(404)
  })
})
