/**
 * The seat-facing MCP gateway handler (plan D8 "Brokered", task B3): `POST /v1/mcp/:id`. `index.ts`
 * dispatches to this handler before its HMAC routes, authenticated by the gateway bearer token
 * (`gateway-token.ts`), never HMAC - see this task's report for the exact `index.ts` patch (that file is
 * a shared file this task does not edit directly).
 *
 * Every call re-checks, in this order, before any upstream fetch: the token's signature and expiry, the
 * token's `connection` claim against the URL's `:id`, the `mcp` rate bucket (240/min/device), the seat's
 * existence and license/approval (`seatAuthorizedForKeys`, same as `/v1/use` and `/v1/integrations`), the
 * seat's tier entitlement (`integrations`), the connection row's existence and `active` status, that the
 * row is `mode: 'brokered'` (a `direct` row is never reachable here - the seat already holds that
 * credential directly, and this gateway would otherwise become a second, redundant path to it), and the
 * row's scope (tier/group). None of this is cached from the token: a license revoked, a connection
 * disabled, or a scope narrowed one second ago takes effect on the very next call.
 *
 * `initialize`/`tools/list`/`tools/call` are the only methods handled; an MCP-transport connection
 * (`github`, `custom-mcp`) is proxied to its upstream server (`adapters/proxy.ts`) with the stored
 * credential attached server-side; a REST-transport connection is served by its adapter's synthesized
 * tool set (`adapters/{hubspot,clickup,plane,notion,jira,linear,slack}.ts`), a write tool refused unless
 * the row has `allow_writes = 1`. Every `tools/call` (proxied or adapted) writes one `mcp_calls` row and
 * one audit row, `device`/`connection`/`tool`/`ms`/`outcome` only - arguments are never in either.
 */
import { decryptVault } from '../crypto'
import type { D1DatabaseLike } from '../d1'
import { json } from '../http'
import { seatAuthorizedForKeys } from '../fleet'
import { resolveTierAndEntitlements } from '../tiers'
import type { IntegrationRow, OperatorStore, SeatRow } from '../store'
import { parseIntegrationScope, type IntegrationScope } from '../routes/integrations-seat'
import { readIntegrationExtra, type IntegrationExtraColumns } from './data'
import { getConnectorCatalogEntry } from './catalog'
import { verifyGatewayToken } from './gateway-token'
import { insertMcpCall } from './mcp-calls'
import type { AdapterModule, AdapterTool } from './adapters/shared'
import { proxyInitialize, proxyToolsCall, proxyToolsList, type ProxyConnectionInfo } from './adapters/proxy'
import { hubspotAdapter } from './adapters/hubspot'
import { clickupAdapter } from './adapters/clickup'
import { planeAdapter } from './adapters/plane'
import { notionAdapter } from './adapters/notion'
import { jiraAdapter } from './adapters/jira'
import { linearAdapter } from './adapters/linear'
import { slackAdapter } from './adapters/slack'

export const MCP_RATE_LIMIT_PER_MIN = 240
const MCP_RATE_WINDOW_MS = 60_000
export const GATEWAY_TIMEOUT_MS = 10_000

const REST_ADAPTERS: Record<string, AdapterModule> = {
  hubspot: hubspotAdapter,
  clickup: clickupAdapter,
  plane: planeAdapter,
  notion: notionAdapter,
  jira: jiraAdapter,
  linear: linearAdapter,
  slack: slackAdapter
}

export interface GatewayEnv {
  DB?: D1DatabaseLike
  OPERATOR_INGEST_SECRET: string
  OPERATOR_VAULT_KEY?: string
}

export interface GatewayDeps {
  fetch: typeof fetch
}

interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: unknown
}

/** Same scope rule `routes/integrations-seat.ts#seatInScope` enforces for `GET /v1/integrations`
 *  (duplicated, not imported: that function is private to a file this task's ownership does not extend
 *  editing beyond "add gatewayToken and endpoint to brokered rows only" - see this task's report). Empty
 *  scope (no tiers, no groups) means every entitled seat; otherwise the seat's resolved tier, or
 *  membership in one of the listed groups, must match. */
async function seatInScope(
  store: Pick<OperatorStore, 'listGroupMembers'>,
  scope: IntegrationScope,
  seat: Pick<SeatRow, 'device_id' | 'sso_email'>,
  tier: string | null
): Promise<boolean> {
  const tiers = scope.tiers ?? []
  const groups = scope.groups ?? []
  if (!tiers.length && !groups.length) return true
  if (tier && tiers.includes(tier)) return true
  for (const groupId of groups) {
    const members = await store.listGroupMembers(groupId)
    const matched = members.some(
      (m) =>
        (m.kind === 'device' && m.member === seat.device_id) ||
        (m.kind === 'email' && seat.sso_email != null && m.member.toLowerCase() === seat.sso_email.toLowerCase())
    )
    if (matched) return true
  }
  return false
}

function safeConfig(configJson: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(configJson)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function toMcpToolShape(tool: AdapterTool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    // MCP tool annotations (2025-06-18 spec): readOnlyHint mirrors this task's own `write` flag so a
    // generic MCP client (or `probe.ts`'s own write heuristic, used elsewhere in this codebase) reads
    // the same signal without needing to know this gateway's internal `AdapterTool` shape.
    annotations: { readOnlyHint: !tool.write }
  }
}

function mcpConnectionInfo(row: IntegrationRow, extra: IntegrationExtraColumns): ProxyConnectionInfo | null {
  const catalogEntry = getConnectorCatalogEntry(row.kind)
  const config = safeConfig(extra.config_json)
  const endpoint = catalogEntry?.endpoint || config.baseUrl || row.base_url || ''
  if (!endpoint) return null
  return { endpoint, credential: null, headerName: extra.header_name }
}

/** Records one `tools/call` outcome: an `mcp_calls` row (best-effort - a D1 that predates this task's
 *  migration must never take a seat's call down with it) plus one audit row every time, matching the
 *  same `store.audit` every other route already uses. Never called with anything but
 *  device/connection/tool/ms/outcome; arguments never reach this function at all. */
async function recordCall(
  store: OperatorStore,
  env: GatewayEnv,
  now: number,
  device: string,
  connectionId: string,
  tool: string,
  ms: number,
  outcome: string
): Promise<void> {
  if (env.DB) {
    try {
      await insertMcpCall(env.DB, { id: crypto.randomUUID(), ts: now, device_id: device, connection_id: connectionId, tool, ms, outcome })
    } catch {
      /* the table may not exist yet on a D1 that predates this migration; the audit row below still records the call */
    }
  }
  await store.audit(crypto.randomUUID(), now, device, 'mcp.tools_call', null, `${tool} on ${connectionId}: ${outcome} in ${ms}ms`)
}

async function callRestAdapter(
  row: IntegrationRow,
  extra: IntegrationExtraColumns,
  env: GatewayEnv,
  toolName: string,
  args: Record<string, unknown>,
  deps: GatewayDeps,
  deadlineAt: number
): Promise<{ outcome: { content: { type: 'text'; text: string }[]; isError: boolean }; label: string }> {
  const adapter = REST_ADAPTERS[row.kind]
  const tool = adapter?.tools.find((t) => t.name === toolName)
  if (!adapter || !tool) {
    return { outcome: { content: [{ type: 'text', text: `Unknown tool ${toolName}.` }], isError: true }, label: 'error' }
  }
  if (tool.write && !extra.allow_writes) {
    return {
      outcome: {
        content: [{ type: 'text', text: 'Write tools are disabled for this connection. An admin must turn on "allow writes" first.' }],
        isError: true
      },
      label: 'refused'
    }
  }
  let credential = ''
  if (row.cipher && row.iv && env.OPERATOR_VAULT_KEY) {
    try {
      credential = await decryptVault(row.cipher, row.iv, env.OPERATOR_VAULT_KEY)
    } catch {
      return { outcome: { content: [{ type: 'text', text: "Could not decrypt this connection's credential." }], isError: true }, label: 'error' }
    }
  }
  try {
    const outcome = await adapter.callTool(toolName, args, {
      credential,
      config: safeConfig(extra.config_json),
      headerName: extra.header_name,
      fetchImpl: deps.fetch,
      deadlineAt
    })
    return { outcome, label: outcome.isError ? 'error' : 'ok' }
  } catch {
    return { outcome: { content: [{ type: 'text', text: 'The tool call failed unexpectedly.' }], isError: true }, label: 'error' }
  }
}

export async function handleMcpGateway(
  request: Request,
  store: OperatorStore,
  env: GatewayEnv,
  connectionId: string,
  now: number,
  deps: GatewayDeps = { fetch }
): Promise<Response> {
  const authz = request.headers.get('authorization') || ''
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(authz.trim())
  if (!bearerMatch) return json({ ok: false, error: 'missing bearer token', code: 'missing-token' }, 401)
  if (!env.OPERATOR_INGEST_SECRET) return json({ ok: false, error: 'gateway not configured' }, 500)

  const verified = await verifyGatewayToken(env.OPERATOR_INGEST_SECRET, bearerMatch[1].trim(), now)
  if (!verified.ok) return json({ ok: false, error: verified.error, code: verified.code }, 401)
  const { claims } = verified
  if (claims.connection !== connectionId) {
    return json({ ok: false, error: 'token is not valid for this connection', code: 'wrong-connection' }, 403)
  }

  if (await store.hitRate(`mcp:${claims.device}`, now, MCP_RATE_WINDOW_MS, MCP_RATE_LIMIT_PER_MIN)) {
    return json({ ok: false, error: 'rate limited', code: 'rate', retryAfterMs: MCP_RATE_WINDOW_MS }, 429)
  }

  const seat = await store.getSeat(claims.device)
  if (!seat) return json({ ok: false, error: 'seat not recognized', code: 'wrong-device' }, 403)
  if (!(await seatAuthorizedForKeys(store, seat, now))) return json({ ok: false, error: 'seat not entitled', code: 'not-entitled' }, 403)
  const { tier, entitlements } = await resolveTierAndEntitlements(store, seat, now)
  if (!entitlements.includes('integrations')) return json({ ok: false, error: 'seat not entitled', code: 'not-entitled' }, 403)

  const row = await store.getIntegration(connectionId)
  if (!row || row.status !== 'active') return json({ ok: false, error: 'connection not available', code: 'not-found' }, 404)

  const extra = readIntegrationExtra(row as unknown as Record<string, unknown>)
  if (extra.mode !== 'brokered') {
    return json({ ok: false, error: 'this connection is direct delivery only, not reachable through the gateway', code: 'direct-mode' }, 403)
  }
  if (!(await seatInScope(store, parseIntegrationScope(row.scope_json), seat, tier))) {
    return json({ ok: false, error: 'seat not entitled', code: 'not-entitled' }, 403)
  }

  let bodyText: string
  try {
    bodyText = await request.text()
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Could not read the request body.' } }, 400)
  }
  let rpc: JsonRpcRequest
  try {
    rpc = bodyText ? (JSON.parse(bodyText) as JsonRpcRequest) : {}
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } }, 400)
  }
  if (!rpc || typeof rpc !== 'object' || typeof rpc.method !== 'string' || !rpc.method) {
    return json({ jsonrpc: '2.0', id: rpc?.id ?? null, error: { code: -32600, message: 'Invalid request.' } }, 400)
  }

  const hasId = rpc.id !== undefined
  const respond = (result: unknown): Response => (hasId ? json({ jsonrpc: '2.0', id: rpc.id, result }) : new Response(null, { status: 202 }))
  const respondError = (code: number, message: string): Response =>
    hasId ? json({ jsonrpc: '2.0', id: rpc.id, error: { code, message } }) : new Response(null, { status: 202 })

  const deadlineAt = now + GATEWAY_TIMEOUT_MS

  if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 })

  if (rpc.method === 'initialize') {
    if (extra.transport === 'mcp') {
      const info = mcpConnectionInfo(row, extra)
      if (!info) return respondError(-32000, 'This connection has no server URL configured.')
      let credential = ''
      if (row.cipher && row.iv && env.OPERATOR_VAULT_KEY) {
        try {
          credential = await decryptVault(row.cipher, row.iv, env.OPERATOR_VAULT_KEY)
        } catch {
          return respondError(-32000, "Could not decrypt this connection's credential.")
        }
      }
      const outcome = await proxyInitialize({ ...info, credential }, rpc.params as Record<string, unknown> | undefined, deps.fetch, deadlineAt)
      if (!outcome.ok) return respondError(-32000, outcome.error?.message || 'The upstream MCP server rejected the handshake.')
      return respond(outcome.result)
    }
    return respond({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: `${row.label} via Metis Operator`, version: '1.0.0' } })
  }

  if (rpc.method === 'tools/list') {
    if (extra.transport === 'mcp') {
      const info = mcpConnectionInfo(row, extra)
      if (!info) return respondError(-32000, 'This connection has no server URL configured.')
      let credential = ''
      if (row.cipher && row.iv && env.OPERATOR_VAULT_KEY) {
        try {
          credential = await decryptVault(row.cipher, row.iv, env.OPERATOR_VAULT_KEY)
        } catch {
          return respondError(-32000, "Could not decrypt this connection's credential.")
        }
      }
      const outcome = await proxyToolsList({ ...info, credential }, deps.fetch, deadlineAt)
      if (!outcome.ok) return respondError(-32000, outcome.error?.message || 'Could not list tools.')
      return respond(outcome.result)
    }
    const adapter = REST_ADAPTERS[row.kind]
    if (!adapter) return respondError(-32000, 'No tools are available for this connection kind yet.')
    return respond({ tools: adapter.tools.map(toMcpToolShape) })
  }

  if (rpc.method === 'tools/call') {
    const params = (rpc.params ?? {}) as { name?: unknown; arguments?: unknown }
    const toolName = typeof params.name === 'string' ? params.name : ''
    if (!toolName) return respondError(-32602, 'A tool name is required.')
    const args = params.arguments && typeof params.arguments === 'object' ? (params.arguments as Record<string, unknown>) : {}

    const startedAt = Date.now()
    let outcome: { content: { type: 'text'; text: string }[]; isError: boolean }
    let label: string

    if (extra.transport === 'mcp') {
      const info = mcpConnectionInfo(row, extra)
      if (!info) return respondError(-32000, 'This connection has no server URL configured.')
      let credential = ''
      if (row.cipher && row.iv && env.OPERATOR_VAULT_KEY) {
        try {
          credential = await decryptVault(row.cipher, row.iv, env.OPERATOR_VAULT_KEY)
        } catch {
          return respondError(-32000, "Could not decrypt this connection's credential.")
        }
      }
      const proxied = await proxyToolsCall({ ...info, credential }, toolName, args, deps.fetch, deadlineAt)
      outcome = { content: proxied.content, isError: proxied.isError }
      label = proxied.timedOut ? 'timeout' : proxied.isError ? 'error' : 'ok'
    } else {
      const result = await callRestAdapter(row, extra, env, toolName, args, deps, deadlineAt)
      outcome = result.outcome
      label = result.label
    }

    const ms = Date.now() - startedAt
    await recordCall(store, env, now, claims.device, connectionId, toolName, ms, label)
    return respond(outcome)
  }

  return respondError(-32601, `Method not found: ${rpc.method}`)
}
