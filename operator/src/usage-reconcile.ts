/**
 * Server-side usage reconciliation (G81, CAP-34, D-16): `seat_usage_daily` is recomputed from the `asks`
 * ledger for one UTC day. The Ask id is stable across the Worker write and the client ingest, so asks
 * never double count; this module therefore never increments. A run is a full recompute that replaces
 * the day, which makes it idempotent and restart-safe (there is nothing incremental to resume).
 * Counts only: no prompt, preview, model or cipher ever enters this table or its audit line.
 *
 * Same pattern as `routes/settings-store.ts`: raw D1 SQL that owns its table, with `USAGE_MIGRATIONS`
 * mirrored into `schema-alter.sql`. A missing table or a missing `asks.path_tag` is `not migrated`,
 * never an empty success.
 */
import type { D1DatabaseLike } from './d1'
import { utcMidnight } from './meters'

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_DAYS_BACK = 31
const MANAGED_METER_ID = 'managed_tokens'

export const USAGE_MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS seat_usage_daily (
  device_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  meter_id TEXT NOT NULL,
  used INTEGER NOT NULL,
  asks INTEGER NOT NULL,
  unknown_asks INTEGER NOT NULL,
  reconciled_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, day, meter_id)
);`
]

export interface UsageDayRow {
  device_id: string
  day: number
  meter_id: string
  used: number
  asks: number
  unknown_asks: number
  reconciled_at: number
}

export type ReconcileResult =
  | { ok: true; day: number; seats: number; drift: number }
  | { ok: false; error: 'db unbound' | 'not migrated' | 'invalid day' }

export function validUsageDay(day: number, now: number): boolean {
  if (!Number.isInteger(day) || day % DAY_MS !== 0) return false
  const today = utcMidnight(now)
  return day <= today && day >= today - MAX_DAYS_BACK * DAY_MS
}

export async function listUsageDay(db: D1DatabaseLike, day: number): Promise<UsageDayRow[]> {
  const r = await db
    .prepare(
      'SELECT device_id, day, meter_id, used, asks, unknown_asks, reconciled_at FROM seat_usage_daily WHERE day = ? AND meter_id = ? ORDER BY device_id'
    )
    .bind(day, MANAGED_METER_ID)
    .all<UsageDayRow>()
  return r.results ?? []
}

interface Aggregate {
  device_id: string
  used: number
  asks: number
  unknown_asks: number
}

export async function reconcileUsageDay(
  db: D1DatabaseLike | undefined,
  day: number,
  now: number
): Promise<ReconcileResult> {
  if (!db) return { ok: false, error: 'db unbound' }
  if (!validUsageDay(day, now)) return { ok: false, error: 'invalid day' }
  let before: UsageDayRow[]
  let fresh: Aggregate[]
  try {
    before = await listUsageDay(db, day)
    const r = await db
      .prepare(
        `SELECT device_id, SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) AS used, COUNT(*) AS asks,
           SUM(CASE WHEN input_tokens IS NULL AND output_tokens IS NULL THEN 1 ELSE 0 END) AS unknown_asks
         FROM asks WHERE ts >= ? AND ts < ? AND path_tag IN ('portal-cf', 'portal-direct') GROUP BY device_id`
      )
      .bind(day, day + DAY_MS)
      .all<Aggregate>()
    fresh = r.results ?? []
  } catch {
    return { ok: false, error: 'not migrated' }
  }
  const oldUsed = new Map(before.map((row) => [row.device_id, row.used]))
  const seen = new Set<string>()
  let drift = 0
  const statements = fresh.map((row) => {
    seen.add(row.device_id)
    drift += Math.abs(row.used - (oldUsed.get(row.device_id) ?? 0))
    return db
      .prepare(
        `INSERT INTO seat_usage_daily (device_id, day, meter_id, used, asks, unknown_asks, reconciled_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id, day, meter_id) DO UPDATE SET used = excluded.used, asks = excluded.asks,
           unknown_asks = excluded.unknown_asks, reconciled_at = excluded.reconciled_at`
      )
      .bind(row.device_id, day, MANAGED_METER_ID, row.used, row.asks, row.unknown_asks, now)
  })
  for (const old of before) {
    if (seen.has(old.device_id)) continue
    drift += Math.abs(old.used)
    statements.push(
      db
        .prepare('DELETE FROM seat_usage_daily WHERE device_id = ? AND day = ? AND meter_id = ?')
        .bind(old.device_id, day, MANAGED_METER_ID)
    )
  }
  try {
    if (db.batch) await db.batch(statements)
    else for (const s of statements) await s.run()
  } catch {
    return { ok: false, error: 'not migrated' }
  }
  return { ok: true, day, seats: fresh.length, drift }
}
