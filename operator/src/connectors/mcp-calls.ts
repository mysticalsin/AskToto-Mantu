/**
 * The `mcp_calls` table (plan section 7 task B3): one row per `tools/call` a seat makes through the MCP
 * gateway, `device_id`, `connection_id`, `tool`, `ms` (latency) and `outcome` only - the call's arguments
 * are never written anywhere, matching the same "never the text" discipline `asks.prompt_cipher` follows
 * for a question and `events.detail` follows for everything else (`redact.ts`/`safeAuditText`).
 *
 * Kept out of `store.ts`/`d1.ts` deliberately (neither file is owned by this task): this module talks to
 * `env.DB` directly, the same pattern `connectors/data.ts` (task B2) already uses for the `integrations`
 * table's additive columns. `retention.ts`'s `pruneRawTable('mcp_calls', ...)` already expects exactly
 * the `id`/`ts` shape this table defines (it shipped ahead of this table, see its module doc), so the
 * columns below are not a new design - they are the specific columns that function already assumes.
 *
 * `CREATE TABLE IF NOT EXISTS` + the two indexes are the exact SQL appended, verbatim, to the end of
 * `schema-alter.sql` as a wholly new table (the same "additive, never a redefinition" exception
 * `operator_settings` used first - see `migrate.contract.test.ts`'s "agree on every table name" test and
 * its `ALTER_ONLY_NEW_TABLES` allowlist, extended here to include `mcp_calls`).
 */
import type { D1DatabaseLike } from '../d1'

export const MCP_CALLS_TABLE_SQL = [
  `CREATE TABLE IF NOT EXISTS mcp_calls (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  ms INTEGER NOT NULL,
  outcome TEXT NOT NULL
);`,
  'CREATE INDEX IF NOT EXISTS mcp_calls_connection_ts ON mcp_calls(connection_id, ts);',
  'CREATE INDEX IF NOT EXISTS mcp_calls_device_ts ON mcp_calls(device_id, ts);'
]

export interface McpCallRow {
  id: string
  ts: number
  device_id: string
  connection_id: string
  tool: string
  ms: number
  outcome: string
}

export async function insertMcpCall(db: D1DatabaseLike, row: McpCallRow): Promise<void> {
  await db
    .prepare('INSERT INTO mcp_calls (id, ts, device_id, connection_id, tool, ms, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(row.id, row.ts, row.device_id, row.connection_id, row.tool, row.ms, row.outcome)
    .run()
}

export interface McpCallsQueryOpts {
  deviceId?: string
  connectionId?: string
  limit?: number
  cursor?: string
}

export interface McpCallsPage {
  rows: McpCallRow[]
  nextCursor: string | null
}

// Same base64url `${ts}:${id}` cursor codec every other cursor-paginated admin route uses
// (`d1.ts`, `routes/seat-timeline.ts`), duplicated locally rather than imported: neither file exports
// its copy, and this is five lines, not a dependency worth creating across an ownership boundary.
function encodeCursor(ts: number, id: string): string {
  const bytes = new TextEncoder().encode(`${ts}:${id}`)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeCursor(cursor: string | undefined): { ts: number; id: string } | null {
  if (!cursor) return null
  try {
    const padded = cursor.replace(/-/g, '+').replace(/_/g, '/')
    const pad = (4 - (padded.length % 4)) % 4
    const bin = atob(padded + '='.repeat(pad))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const raw = new TextDecoder().decode(bytes)
    const i = raw.lastIndexOf(':')
    if (i < 0) return null
    const ts = Number(raw.slice(0, i))
    const id = raw.slice(i + 1)
    if (!Number.isFinite(ts) || !id) return null
    return { ts, id }
  } catch {
    return null
  }
}

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

/** Admin listing for `GET /v1/admin/mcp-calls.json` (`routes/mcp-gateway.ts`): newest first, optionally
 *  filtered to one device or one connection, cursor-paginated the same way every other admin table is. */
export async function listMcpCalls(db: D1DatabaseLike, opts: McpCallsQueryOpts = {}): Promise<McpCallsPage> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)))
  const cursor = decodeCursor(opts.cursor)
  const clauses: string[] = []
  const params: unknown[] = []
  if (opts.deviceId) {
    clauses.push('device_id = ?')
    params.push(opts.deviceId)
  }
  if (opts.connectionId) {
    clauses.push('connection_id = ?')
    params.push(opts.connectionId)
  }
  if (cursor) {
    clauses.push('(ts < ? OR (ts = ? AND id < ?))')
    params.push(cursor.ts, cursor.ts, cursor.id)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const sql = `SELECT id, ts, device_id, connection_id, tool, ms, outcome FROM mcp_calls ${where} ORDER BY ts DESC, id DESC LIMIT ?`
  const r = await db
    .prepare(sql)
    .bind(...params, limit)
    .all<McpCallRow>()
  const rows = r.results ?? []
  const last = rows.at(-1)
  const nextCursor = rows.length === limit && last ? encodeCursor(last.ts, last.id) : null
  return { rows, nextCursor }
}
