/**
 * Admin side of the MCP gateway (plan section 7 task B3): `GET /v1/admin/mcp-calls.json`, a
 * cursor-paginated, newest-first listing of every `tools/call` the gateway has recorded - device,
 * connection, tool, latency, outcome, never arguments (`connectors/mcp-calls.ts` never stores them at
 * all). The seat-facing `POST /v1/mcp/:id` handler (`connectors/gateway.ts`) is dispatched straight from
 * `index.ts`'s `/v1/*` chain, authenticated by the gateway bearer token rather than an Access session, so
 * it is never registered here.
 */
import type { AdminCtx } from './admin-ctx'
import { json } from '../http'
import { listMcpCalls } from '../connectors/mcp-calls'
import { defineRoute } from './registry'

const MAX_LIMIT = 500

function parseLimit(raw: string | null): number | undefined {
  if (!raw) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n)) return undefined
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(n)))
}

async function mcpCallsList(ctx: AdminCtx) {
  if (!ctx.env.DB) {
    // No fake data (plan lock 3): an unbound D1 means "not available", never an empty table pretending
    // there have been no calls.
    return json({ ok: true, available: false, rows: [], nextCursor: null })
  }
  const params = ctx.url.searchParams
  const page = await listMcpCalls(ctx.env.DB, {
    deviceId: params.get('device') || undefined,
    connectionId: params.get('connection') || undefined,
    limit: parseLimit(params.get('limit')),
    cursor: params.get('cursor') || undefined
  })
  return json({
    ok: true,
    available: true,
    rows: page.rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      device: r.device_id,
      connection: r.connection_id,
      tool: r.tool,
      ms: r.ms,
      outcome: r.outcome
    })),
    nextCursor: page.nextCursor
  })
}

export function registerMcpGatewayRoutes(): void {
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/v1/admin/mcp-calls.json',
    auth: 'admin',
    handler: async (_request, ctx) => mcpCallsList(ctx)
  })
}
