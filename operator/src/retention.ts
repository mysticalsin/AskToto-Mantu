/**
 * Data retention (section 10, plan D10/B6): events 30 d, audit 365 d, asks 90 d, crm_sends 90 d,
 * rate_limits 1 d, integration_grants 365 d, mcp_calls 90 d, plus closing sessions that stopped
 * pulsing. `operator_settings` is never pruned (it is not event data - a hand-set preference has no
 * "age"). Called from a daily cron trigger and, capped much smaller, opportunistically on ingest so
 * a Worker that never sees a cron still stays bounded.
 *
 * `integration_grants` and `mcp_calls` are not part of `OperatorStore#pruneTable` (that method's
 * table union lives in `store.ts`, not owned by this task - same reasoning as
 * `connectors/data.ts`'s additive columns), so they are pruned here directly against `env.DB` when
 * it is bound. `mcp_calls` does not exist yet (it ships with the MCP gateway, task B3): a
 * `sqlite_master` existence check before the DELETE means this cron never throws on a D1 that
 * predates that table, on D1 (Cloudflare) or the `node:sqlite` shim alike.
 */

import type { D1DatabaseLike } from './d1'
import type { OperatorStore } from './store'

const DAY_MS = 24 * 60 * 60 * 1000

export const RETENTION_MS = {
  events: 30 * DAY_MS,
  audit: 365 * DAY_MS,
  asks: 90 * DAY_MS,
  crm_sends: 90 * DAY_MS,
  rate_limits: 1 * DAY_MS,
  integration_grants: 365 * DAY_MS,
  mcp_calls: 90 * DAY_MS
} as const

export interface RetentionCaps {
  events?: number
  audit?: number
  asks?: number
  crm_sends?: number
  rate_limits?: number
  integration_grants?: number
  mcp_calls?: number
}

export interface RetentionResult {
  events: number
  audit: number
  asks: number
  crm_sends: number
  rate_limits: number
  integration_grants: number
  mcp_calls: number
  staleSessionsClosed: number
}

export interface RetentionDeps {
  /** Raw D1 handle for the two tables `OperatorStore#pruneTable` does not cover. Omit (tests using
   *  `memoryStore()` with no D1, or a Worker with `env.DB` unbound) to skip those two prunes -
   *  they return 0 rather than throwing. */
  db?: D1DatabaseLike
}

/** Default cap per table per call: bounded so one cron tick (or one ingest request) never runs away. */
const DEFAULT_CAP = 200

async function tableExists(db: D1DatabaseLike, table: string): Promise<boolean> {
  try {
    const row = await db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").bind(table).first()
    return row != null
  } catch {
    return false
  }
}

/** Same delete-by-id-page shape as `OperatorStore#pruneTable` (d1.ts), for a table that interface
 *  does not cover. Guarded so a table that does not exist yet (`mcp_calls` before B3 ships) is a
 *  silent 0, never a thrown error - this runs from a cron with nobody watching it fail. */
async function pruneRawTable(db: D1DatabaseLike | undefined, table: string, before: number, cap: number): Promise<number> {
  if (!db) return 0
  try {
    if (!(await tableExists(db, table))) return 0
    const r = await db.prepare(`SELECT id FROM ${table} WHERE ts < ? LIMIT ?`).bind(before, cap).all<{ id: string }>()
    const rows = r.results ?? []
    for (const row of rows) {
      await db.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(row.id).run()
    }
    return rows.length
  } catch {
    // A raw-table prune must never take the cron down with it; the next run tries again.
    return 0
  }
}

function summarizeForAudit(result: RetentionResult): string {
  return Object.entries(result)
    .map(([k, v]) => `${k} ${v}`)
    .join(' ')
    .slice(0, 400)
}

export async function pruneRetention(
  store: OperatorStore,
  now: number,
  caps: RetentionCaps = {},
  deps: RetentionDeps = {}
): Promise<RetentionResult> {
  const events = await store.pruneTable('events', now - RETENTION_MS.events, caps.events ?? DEFAULT_CAP)
  const audit = await store.pruneTable('audit', now - RETENTION_MS.audit, caps.audit ?? DEFAULT_CAP)
  const asks = await store.pruneTable('asks', now - RETENTION_MS.asks, caps.asks ?? DEFAULT_CAP)
  const crm_sends = await store.pruneTable('crm_sends', now - RETENTION_MS.crm_sends, caps.crm_sends ?? DEFAULT_CAP)
  const rate_limits = await store.pruneTable('rate_limits', now - RETENTION_MS.rate_limits, caps.rate_limits ?? DEFAULT_CAP)
  const integration_grants = await pruneRawTable(
    deps.db,
    'integration_grants',
    now - RETENTION_MS.integration_grants,
    caps.integration_grants ?? DEFAULT_CAP
  )
  const mcp_calls = await pruneRawTable(deps.db, 'mcp_calls', now - RETENTION_MS.mcp_calls, caps.mcp_calls ?? DEFAULT_CAP)
  const staleSessionsClosed = await store.closeStaleSessions(now)
  const result: RetentionResult = { events, audit, asks, crm_sends, rate_limits, integration_grants, mcp_calls, staleSessionsClosed }
  // One heartbeat per run (task B6): `/health`'s lastCronAt reads the newest of these back.
  await store.audit(crypto.randomUUID(), now, 'system', 'platform.heartbeat', null, summarizeForAudit(result))
  return result
}
