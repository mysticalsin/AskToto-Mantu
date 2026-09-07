/**
 * `operator_settings` (task B6, plan 3.7b law 3 and 6.11 "Value"): a small key/value table for the
 * handful of admin-editable settings that are not part of any other feature's schema (hourly rate,
 * currency, per-seat daily token budget, density, reduced motion). One row per key, kept out of
 * `store.ts`/`d1.ts` deliberately (neither file is owned by this task) - same pattern as
 * `../connectors/data.ts`'s additive `integrations` columns: raw prepared statements against
 * `env.DB` here, `SETTINGS_MIGRATIONS` appended to `schema-alter.sql`, and every write audited by the
 * caller (`routes/settings.ts`-style route module below) with a before/after snapshot.
 *
 * `hourlyRate: null` and `dailyTokenBudgetPerSeat: null` both mean "not set" - this module never
 * invents a default rate or a default budget (plan lock: "no default hourly rate"). `currency`,
 * `density` and `reducedMotion` do have defaults (a currency label and two UI preferences), which is
 * a different thing from inventing a dollar amount.
 */
import type { D1DatabaseLike } from '../d1'
import { json } from '../http'
import { auditLog, type AdminCtx } from './admin-ctx'
import { defineRoute } from './registry'

export type SettingsCurrency = 'CAD' | 'EUR' | 'USD' | 'GBP' | 'CHF'
export type SettingsDensity = 'comfortable' | 'compact'
export type SettingsReducedMotion = 'system' | 'reduce'

export interface OperatorSettingsValue {
  hourlyRate: number | null
  currency: SettingsCurrency
  dailyTokenBudgetPerSeat: number | null
  density: SettingsDensity
  reducedMotion: SettingsReducedMotion
}

export const SETTINGS_KEYS = ['hourlyRate', 'currency', 'dailyTokenBudgetPerSeat', 'density', 'reducedMotion'] as const
export type SettingsKey = (typeof SETTINGS_KEYS)[number]

export const DEFAULT_OPERATOR_SETTINGS: OperatorSettingsValue = {
  hourlyRate: null,
  currency: 'USD',
  dailyTokenBudgetPerSeat: null,
  density: 'comfortable',
  reducedMotion: 'system'
}

/** Appended verbatim to `schema-alter.sql`. `CREATE TABLE IF NOT EXISTS` (migrate.mjs / migrate
 *  contract), never pruned by retention.ts. */
export const SETTINGS_MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS operator_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);`
]

export interface SettingsReadResult {
  values: OperatorSettingsValue
  /** `max(updated_at)` over every stored row, 0 when nothing has ever been written. */
  settingsVersion: number
}

interface SettingsRow {
  key: string
  value_json: string
  updated_at: number
}

const INVALID = Symbol('invalid-setting-value')
export { INVALID as INVALID_SETTING_VALUE }

/** Pure validation, shared by the read path (defensive against a hand-edited row) and the PATCH
 *  route (defensive against a bad request body). Returns the coerced value, or the `INVALID` sentinel. */
export function validateSettingValue(key: SettingsKey, raw: unknown): OperatorSettingsValue[SettingsKey] | typeof INVALID {
  switch (key) {
    case 'hourlyRate':
      if (raw === null) return null
      if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 10000) return raw
      return INVALID
    case 'currency':
      return raw === 'CAD' || raw === 'EUR' || raw === 'USD' || raw === 'GBP' || raw === 'CHF' ? raw : INVALID
    case 'dailyTokenBudgetPerSeat':
      if (raw === null) return null
      if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 50_000_000) return raw
      return INVALID
    case 'density':
      return raw === 'comfortable' || raw === 'compact' ? raw : INVALID
    case 'reducedMotion':
      return raw === 'system' || raw === 'reduce' ? raw : INVALID
    default:
      return INVALID
  }
}

/** Reads every stored row and overlays it on the defaults. A row whose `value_json` fails to parse,
 *  or whose key is unknown, is skipped rather than failing the whole read - a hand-edited or
 *  partially-migrated D1 must never turn Settings into a 500. */
export async function readOperatorSettings(db: D1DatabaseLike | undefined): Promise<SettingsReadResult> {
  if (!db) return { values: { ...DEFAULT_OPERATOR_SETTINGS }, settingsVersion: 0 }
  let rows: SettingsRow[] = []
  try {
    const r = await db.prepare('SELECT key, value_json, updated_at FROM operator_settings').all<SettingsRow>()
    rows = r.results ?? []
  } catch {
    // Table not migrated yet on this D1: read as all-defaults rather than throwing.
    return { values: { ...DEFAULT_OPERATOR_SETTINGS }, settingsVersion: 0 }
  }
  const values: OperatorSettingsValue = { ...DEFAULT_OPERATOR_SETTINGS }
  let settingsVersion = 0
  for (const row of rows) {
    if (!(SETTINGS_KEYS as readonly string[]).includes(row.key)) continue
    try {
      const parsed = JSON.parse(row.value_json) as unknown
      const validated = validateSettingValue(row.key as SettingsKey, parsed)
      if (validated !== INVALID) (values as unknown as Record<string, unknown>)[row.key] = validated
    } catch {
      /* corrupt row: keep the default for this key */
    }
    if (row.updated_at > settingsVersion) settingsVersion = row.updated_at
  }
  return { values, settingsVersion }
}

export interface SettingsPatchResult {
  ok: true
  values: OperatorSettingsValue
  settingsVersion: number
}

export interface SettingsPatchError {
  ok: false
  error: string
  field: string
}

/** Validates every key present in `patch` before writing anything (partial success would leave the
 *  console showing a mix of the old and new value for a single PATCH). Writes one row per changed
 *  key with `updated_at`/`updated_by`; the caller (the route handler) does the audit log so it can
 *  attach the request id the same way every other admin mutation does. */
export async function writeOperatorSettingsPatch(
  db: D1DatabaseLike | undefined,
  patch: Record<string, unknown>,
  actor: string,
  now: number
): Promise<SettingsPatchResult | SettingsPatchError | { ok: false; error: 'db unbound'; field: '' }> {
  if (!db) return { ok: false, error: 'db unbound', field: '' }
  const keysPresent = SETTINGS_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(patch, k))
  const validated: Partial<OperatorSettingsValue> = {}
  for (const key of keysPresent) {
    const value = validateSettingValue(key, patch[key])
    if (value === INVALID) return { ok: false, error: `invalid ${key}`, field: key }
    ;(validated as Record<string, unknown>)[key] = value
  }
  for (const key of keysPresent) {
    const value = (validated as Record<string, unknown>)[key]
    await db
      .prepare(
        `INSERT INTO operator_settings (key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
      )
      .bind(key, JSON.stringify(value), now, actor)
      .run()
  }
  const result = await readOperatorSettings(db)
  return { ok: true, values: result.values, settingsVersion: result.settingsVersion }
}

// ---------------------------------------------------------------------------
// Routes: GET/PATCH /v1/admin/settings.json.
// ---------------------------------------------------------------------------

export function registerSettingsRoutes(): void {
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/v1/admin/settings.json',
    auth: 'admin',
    handler: async (_request, ctx) => {
      const { values, settingsVersion } = await readOperatorSettings(ctx.env.DB)
      return json({ ok: true, settings: values, settingsVersion })
    }
  })
  defineRoute<AdminCtx>({
    method: 'PATCH',
    pattern: '/v1/admin/settings.json',
    auth: 'admin',
    handler: async (request, ctx) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      const known = SETTINGS_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(body, k))
      if (!known.length) return json({ ok: false, error: 'no recognised settings key in body' }, 400)
      const before = await readOperatorSettings(ctx.env.DB)
      const result = await writeOperatorSettingsPatch(ctx.env.DB, body, ctx.email, ctx.now)
      if (!result.ok) {
        const status = result.error === 'db unbound' ? 503 : 400
        return json({ ok: false, error: result.error }, status)
      }
      const beforeChanged: Record<string, unknown> = {}
      const afterChanged: Record<string, unknown> = {}
      for (const key of known) {
        beforeChanged[key] = before.values[key]
        afterChanged[key] = result.values[key]
      }
      await auditLog(
        ctx,
        'settings-update',
        null,
        `before ${JSON.stringify(beforeChanged)} after ${JSON.stringify(afterChanged)}`.slice(0, 500)
      )
      return json({ ok: true, settings: result.values, settingsVersion: result.settingsVersion })
    }
  })
}
