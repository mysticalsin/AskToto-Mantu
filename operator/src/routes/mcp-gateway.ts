/**
 * Seat-facing MCP gateway: `POST /v1/mcp/:id`, the endpoint `GET /v1/integrations` hands a seat for a
 * `brokered` connection. The seat authenticates with the gateway bearer token minted for its device and
 * that connection (`connectors/gateway-token.ts`); the connector's own credential is decrypted here and
 * attached to the upstream request, so it never reaches the seat. Every call re-checks approval, tier
 * entitlement, scope and that the connection is still active, so a revoke takes effect immediately
 * rather than at token expiry.
 */
import { decryptVault } from '../crypto'
import { readIntegrationExtra } from '../connectors/data'
import { verifyGatewayToken } from '../connectors/gateway-token'
import { getConnectorCatalogEntry } from '../connectors/catalog'
import type { D1DatabaseLike } from '../d1'
import { seatAuthorizedForKeys } from '../fleet'
import { json } from '../http'
import type { OperatorStore } from '../store'
import { resolveTierAndEntitlements } from '../tiers'
import { decodeOAuthPayload, parseIntegrationScope, refreshDirectOAuthCredential, seatInScope } from './integrations-seat'

/** Largest JSON-RPC request body the gateway will forward. */
export const MCP_GATEWAY_MAX_BODY_BYTES = 256 * 1024
const MCP_GATEWAY_TIMEOUT_MS = 30_000

export function mcpGatewayConnectionId(pathname: string): string | null {
  const m = /^\/v1\/mcp\/([^/]+)$/.exec(pathname)
  if (!m) return null
  try {
    return decodeURIComponent(m[1])
  } catch {
    return m[1]
  }
}

export async function handleMcpGateway(
  request: Request,
  store: OperatorStore,
  env: { OPERATOR_VAULT_KEY?: string; OPERATOR_INGEST_SECRET: string; DB?: D1DatabaseLike },
  connectionId: string,
  now: number,
  upstreamFetch: typeof fetch = fetch
): Promise<Response> {
  if (request.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405)
  if (!env.OPERATOR_VAULT_KEY || !env.OPERATOR_INGEST_SECRET) return json({ ok: false, error: 'vault key unbound' }, 503)
  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')
  if (!bearer) return json({ ok: false, error: 'missing gateway token' }, 401)
  const verified = await verifyGatewayToken(env.OPERATOR_INGEST_SECRET, bearer[1].trim(), now)
  if (!verified.ok) return json({ ok: false, error: verified.error, code: verified.code }, 401)
  const { device, connection } = verified.claims
  if (connection !== connectionId) return json({ ok: false, error: 'gateway token is for another connection' }, 403)

  const seat = await store.getSeat(device)
  if (!seat || !(await seatAuthorizedForKeys(store, seat, now))) {
    return json({ ok: false, error: 'seat not entitled', code: 'not-entitled' }, 403)
  }
  const { tier, entitlements } = await resolveTierAndEntitlements(store, seat, now)
  if (!entitlements.includes('integrations')) {
    return json({ ok: false, error: 'seat not entitled', code: 'not-entitled' }, 403)
  }
  const row = await store.getIntegration(connectionId)
  if (!row || row.status !== 'active' || !(await seatInScope(store, parseIntegrationScope(row.scope_json), seat, tier))) {
    return json({ ok: false, error: 'not found' }, 404)
  }
  const extra = readIntegrationExtra(row as unknown as Record<string, unknown>)
  if (extra.mode !== 'brokered' || !row.base_url || !row.cipher || !row.iv) return json({ ok: false, error: 'not found' }, 404)

  // A declared oversize length is refused before any of the body is read.
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MCP_GATEWAY_MAX_BODY_BYTES) {
    return json({ ok: false, error: 'request too large' }, 413)
  }
  const body = await request.text()
  if (new TextEncoder().encode(body).length > MCP_GATEWAY_MAX_BODY_BYTES) {
    return json({ ok: false, error: 'request too large' }, 413)
  }

  let credential: string
  try {
    credential = await decryptVault(row.cipher, row.iv, env.OPERATOR_VAULT_KEY)
  } catch {
    return json({ ok: false, error: 'connection unavailable' }, 502)
  }
  if (getConnectorCatalogEntry(row.kind)?.oauth?.flow === 'auth-code') {
    const payload = decodeOAuthPayload(credential)
    if (payload) credential = await refreshDirectOAuthCredential(store, env, row, payload, extra.config_json, now, upstreamFetch)
  }

  const headers = new Headers({
    authorization: `Bearer ${credential}`,
    'content-type': request.headers.get('content-type') ?? 'application/json',
    accept: request.headers.get('accept') ?? 'application/json, text/event-stream'
  })
  const session = request.headers.get('mcp-session-id')
  if (session) headers.set('mcp-session-id', session)
  let upstream: Response
  try {
    upstream = await upstreamFetch(row.base_url, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(MCP_GATEWAY_TIMEOUT_MS)
    })
  } catch {
    return json({ ok: false, error: 'upstream unreachable' }, 502)
  }
  await store.audit(crypto.randomUUID(), now, device, 'mcp-call', null, `${connectionId} ${upstream.status}`)
  const out = new Headers({ 'cache-control': 'no-store' })
  for (const name of ['content-type', 'mcp-session-id']) {
    const v = upstream.headers.get(name)
    if (v) out.set(name, v)
  }
  return new Response(upstream.body, { status: upstream.status, headers: out })
}

export function registerMcpGatewayRoutes(): void {
  // The seat-facing POST /v1/mcp/:id is dispatched from index.ts (it authenticates with a gateway
  // bearer token, not a console session); the admin-side mcp-calls listing is not registered yet.
}
