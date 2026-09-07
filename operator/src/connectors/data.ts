/**
 * New `integrations` columns for the connector catalog (task B2), kept out of `d1.ts` and `store.ts`
 * deliberately: neither file is owned by this task. `d1.ts`'s `putIntegration` does an
 * `INSERT OR REPLACE` with an explicit, narrower column list, so a call to it always resets these columns
 * to their schema defaults on an existing row; every route mutation in `./routes/integrations.ts` that
 * calls `store.putIntegration` therefore calls `writeIntegrationExtraColumns` immediately afterward, when
 * `env.DB` is bound, to reapply the values that call would otherwise have just discarded.
 *
 * Reading these columns back needs no D1-specific code at all: `d1.ts`'s `getIntegration` and
 * `listIntegrationRows` both `SELECT *`, so once the columns exist in the table they come back as extra,
 * untyped properties on the same `IntegrationRow` object either backing store already returns.
 * `readIntegrationExtra` just reads those properties off whatever object it is given (a D1 row via
 * `SELECT *`, or a plain object the in-memory store held onto) with the SQL-level defaults applied when a
 * property is absent (e.g. every row that predates this migration).
 */
import type { D1DatabaseLike } from '../d1'

export type IntegrationMode = 'brokered' | 'direct'

export interface IntegrationExtraColumns {
  auth_kind: string | null
  header_name: string | null
  transport: string | null
  mode: IntegrationMode
  allow_writes: 0 | 1
  config_json: string
  tools_json: string | null
  last_test_json: string | null
  last_test_at: number | null
  notes: string | null
  /** JSON array of tool names an admin has switched off on the Tools tab's per-tool enable switch
   *  (plan 6.10c: "every tool ... a per-tool enable switch"). Always a JSON array of strings, never
   *  absent -- `coerceDisabledToolsJson` guarantees `'[]'` for a row that predates this column or
   *  carries a corrupt value, the same discipline `coerceConfigJson` already applies to
   *  `config_json`. Checked by `gateway.ts` before a `tools/call` reaches the adapter or the proxied
   *  upstream server, for both REST-adapter and MCP-transport connections. */
  disabled_tools_json: string
}

/** Mirrors the SQL-level `DEFAULT`s in `INTEGRATION_ALTERS`, so a row with no extra columns yet (or a
 *  fresh in-memory row before any extra field has been set) reads the same as a just-migrated D1 row. */
export const INTEGRATION_EXTRA_DEFAULTS: IntegrationExtraColumns = {
  auth_kind: null,
  header_name: null,
  transport: null,
  mode: 'brokered',
  allow_writes: 0,
  config_json: '{}',
  tools_json: null,
  last_test_json: null,
  last_test_at: null,
  notes: null,
  disabled_tools_json: '[]'
}

/** Idempotent (SQLite errors "duplicate column name" on a re-run, which `migrate.mjs` already treats as
 *  expected and skips, same as every other ALTER in `schema-alter.sql`). Appended verbatim to
 *  `schema-alter.sql`. */
export const INTEGRATION_ALTERS: string[] = [
  'ALTER TABLE integrations ADD COLUMN auth_kind TEXT;',
  'ALTER TABLE integrations ADD COLUMN header_name TEXT;',
  'ALTER TABLE integrations ADD COLUMN transport TEXT;',
  "ALTER TABLE integrations ADD COLUMN mode TEXT NOT NULL DEFAULT 'brokered';",
  'ALTER TABLE integrations ADD COLUMN allow_writes INTEGER NOT NULL DEFAULT 0;',
  "ALTER TABLE integrations ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}';",
  'ALTER TABLE integrations ADD COLUMN tools_json TEXT;',
  'ALTER TABLE integrations ADD COLUMN last_test_json TEXT;',
  'ALTER TABLE integrations ADD COLUMN last_test_at INTEGER;',
  'ALTER TABLE integrations ADD COLUMN notes TEXT;',
  "ALTER TABLE integrations ADD COLUMN disabled_tools_json TEXT NOT NULL DEFAULT '[]';"
]

function coerceMode(value: unknown): IntegrationMode {
  return value === 'direct' ? 'direct' : 'brokered'
}

function coerceAllowWrites(value: unknown): 0 | 1 {
  return value === 1 || value === true || value === '1' ? 1 : 0
}

/** True only for a string that parses as a JSON object (not an array, not a bare scalar). A caller
 *  downstream (`routes/integrations.ts`) does `JSON.parse` on `config_json` to build a response; an
 *  unvalidated string here would turn one corrupt row into a 500 for the whole listing. */
function coerceConfigJson(value: unknown): string {
  if (typeof value !== 'string' || !value) return '{}'
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? value : '{}'
  } catch {
    return '{}'
  }
}

/** True only for a string that parses as a JSON array of strings (never an object, never a mixed
 *  array). Same discipline as `coerceConfigJson` above: a corrupt or absent value reads as `'[]'`
 *  rather than throwing downstream, in `gateway.ts` or in `integrationSummary()`. */
function coerceDisabledToolsJson(value: unknown): string {
  if (typeof value !== 'string' || !value) return '[]'
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every((v) => typeof v === 'string') ? value : '[]'
  } catch {
    return '[]'
  }
}

/** Parses `disabled_tools_json` into the plain string array both `integrationSummary()` (the wire
 *  shape) and `gateway.ts` (the per-call enforcement check) need, one implementation shared by both
 *  rather than two hand-rolled `JSON.parse` call sites. */
export function parseDisabledTools(disabledToolsJson: string): string[] {
  try {
    const parsed: unknown = JSON.parse(disabledToolsJson)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/** Reads the extra columns off any object that may carry them (a D1 `SELECT *` row, or a plain in-memory
 *  row) with the same defaults the SQL migration itself uses. Never throws on a row that predates the
 *  migration (every field just reads as its default). */
export function readIntegrationExtra(row: Record<string, unknown> | null | undefined): IntegrationExtraColumns {
  if (!row) return { ...INTEGRATION_EXTRA_DEFAULTS }
  return {
    auth_kind: typeof row.auth_kind === 'string' ? row.auth_kind : null,
    header_name: typeof row.header_name === 'string' ? row.header_name : null,
    transport: typeof row.transport === 'string' ? row.transport : null,
    mode: coerceMode(row.mode),
    allow_writes: coerceAllowWrites(row.allow_writes),
    config_json: coerceConfigJson(row.config_json),
    tools_json: typeof row.tools_json === 'string' ? row.tools_json : null,
    last_test_json: typeof row.last_test_json === 'string' ? row.last_test_json : null,
    last_test_at: typeof row.last_test_at === 'number' ? row.last_test_at : null,
    notes: typeof row.notes === 'string' ? row.notes : null,
    disabled_tools_json: coerceDisabledToolsJson(row.disabled_tools_json)
  }
}

/** Merges `patch` onto whatever extra values `row` already carries (defaults for the rest), returning a
 *  new object suitable for `store.putIntegration`. Used for every mutation path so a field the caller
 *  did not touch survives the round trip. */
export function withIntegrationExtra<T extends object>(row: T, patch: Partial<IntegrationExtraColumns>): T & IntegrationExtraColumns {
  const current = readIntegrationExtra(row as Record<string, unknown>)
  return { ...row, ...current, ...patch }
}

/** Reapplies the extra columns via a direct `UPDATE`, bypassing `d1.ts` entirely. Call this immediately
 *  after every `store.putIntegration()` in a route whenever `env.DB` is bound; see the module doc for why. */
export async function writeIntegrationExtraColumns(db: D1DatabaseLike, id: string, extra: IntegrationExtraColumns): Promise<void> {
  await db
    .prepare(
      `UPDATE integrations SET
        auth_kind = ?, header_name = ?, transport = ?, mode = ?, allow_writes = ?,
        config_json = ?, tools_json = ?, last_test_json = ?, last_test_at = ?, notes = ?,
        disabled_tools_json = ?
       WHERE id = ?`
    )
    .bind(
      extra.auth_kind,
      extra.header_name,
      extra.transport,
      extra.mode,
      extra.allow_writes,
      extra.config_json,
      extra.tools_json,
      extra.last_test_json,
      extra.last_test_at,
      extra.notes,
      extra.disabled_tools_json,
      id
    )
    .run()
}

export async function readIntegrationExtraColumns(db: D1DatabaseLike, id: string): Promise<IntegrationExtraColumns | null> {
  const row = await db
    .prepare(
      `SELECT auth_kind, header_name, transport, mode, allow_writes, config_json, tools_json, last_test_json, last_test_at, notes, disabled_tools_json
       FROM integrations WHERE id = ?`
    )
    .bind(id)
    .first<Record<string, unknown>>()
  return row ? readIntegrationExtra(row) : null
}

/** Hard delete, only ever called on an already-revoked row (the route enforces that). Cleans up the
 *  grant history for the same id so `integration_grants` never outlives the connection it audited. */
export async function deleteIntegrationRow(db: D1DatabaseLike, id: string): Promise<void> {
  await db.prepare('DELETE FROM integration_grants WHERE integration_id = ?').bind(id).run()
  await db.prepare('DELETE FROM integrations WHERE id = ?').bind(id).run()
}
