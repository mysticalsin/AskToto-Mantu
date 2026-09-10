/**
 * Export table definitions (task B10, plan D11): the column set and redaction per exportable table,
 * and a batched async row source per table so `csv.ts`/`xlsx.ts` can stream a response body without
 * holding a whole table in memory. `routes/export.ts` is the only caller.
 *
 * Redaction mirrors the JSON routes exactly: `asks` never carries stored preview text or ciphertext
 * (the export derives a label from closed metadata); `licenses` and `integrations` carry `last4`
 * only, never a credential, a config secret or the full signed license string (which is never stored
 * server-side in the first place); `seats` runs every free-text field through `looksLikeSecret`, same
 * as `dashboard.ts`.
 *
 * Every table function projects an explicit, fixed set of column keys onto the row object it yields -
 * never a raw store row spread - so a store row picking up an extra untyped column later (the
 * `connectors/data.ts` pattern) can never leak into an export by accident.
 */
import { approvalOf, isRealSeat } from '../fleet'
import { looksLikeSecret } from '../redact'
import { issuedLicenseActive } from '../fleet'
import { projectAskTelemetry, projectEventTelemetry } from '../privacy'
import type { AskRow, AuditRow, EventRow, IssuedLicenseRow, OperatorStore, SeatRow, SessionRow } from '../store'

export type ExportColumnType = 'string' | 'number' | 'date'

export interface ExportColumn {
  key: string
  header: string
  type: ExportColumnType
}

export const EXPORT_TABLES = ['audit', 'events', 'sessions', 'asks', 'licenses', 'integrations', 'seats'] as const
export type ExportTable = (typeof EXPORT_TABLES)[number]

export function isExportTable(value: unknown): value is ExportTable {
  return typeof value === 'string' && (EXPORT_TABLES as readonly string[]).includes(value)
}

export interface ExportFilters {
  since?: number
  until?: number
  q?: string
  actor?: string
  action?: string
  kinds?: string[]
  country?: string
  os?: string
  status?: string
  /** "Now" for a table whose derived column needs it (`licenses`' active/expired status). The route
   *  handler passes `ctx.now`; omitting it falls back to the wall clock, which is fine outside tests. */
  now?: number
}

export type ExportRow = Record<string, string | number | null>

export interface ExportTableDef {
  table: ExportTable
  columns: ExportColumn[]
  /** Yields batches (not single rows) so the writer never has to buffer more than one batch at a
   *  time for a table whose store method already pages (events, sessions). Tables whose only store
   *  method returns a full array (audit, asks, licenses, integrations, seats) fetch once, bounded by
   *  `MAX_ROWS`, and yield it back out in `BATCH_SIZE` slices. */
  rows(store: OperatorStore, filters: ExportFilters): AsyncGenerator<ExportRow[]>
}

const BATCH_SIZE = 1000
/** Bound for the tables whose store method has no cursor (store.ts is not owned by this task, so a
 *  true streaming query for these is out of scope) - generous for this fleet's size, and exactly
 *  the ceiling plan D11 names for a single export. */
const MAX_ROWS = 50_000

function matchesQuery(q: string | undefined, fields: (string | null | undefined)[]): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  return fields.some((f) => (f || '').toLowerCase().includes(needle))
}

/** Formula injection guard (security review, task B10): shared by `csv.ts` and `xlsx.ts` so the two
 *  formats can never disagree about what counts as a dangerous leading character. A cell is
 *  dangerous to a spreadsheet if, once any leading whitespace or control character is skipped, it
 *  starts with `=`, `+`, `-` or `@` - a spreadsheet's own leading-whitespace trimming means a value
 *  like `"\t=cmd|..."` is exactly as exploitable as `"=cmd|..."`. Guarded by prefixing a single quote,
 *  which every major spreadsheet app treats as "force text" without changing the visible value. */
export function guardFormulaInjection(value: string): string {
  return /^[\t\r\n\v\f ]*[=+\-@]/.test(value) ? `'${value}` : value
}

function* chunkArray<T>(arr: T[], size: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size)
}

async function* fromBoundedArray<T>(all: T[], project: (row: T) => ExportRow): AsyncGenerator<ExportRow[]> {
  for (const batch of chunkArray(all, BATCH_SIZE)) yield batch.map(project)
}

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

function projectAudit(row: AuditRow): ExportRow {
  return {
    ts: row.ts,
    actor: row.actor,
    action: row.action,
    ask_id: row.ask_id,
    detail: row.detail,
    request_id: row.request_id,
    route: row.route
  }
}

const AUDIT_COLUMNS: ExportColumn[] = [
  { key: 'ts', header: 'When', type: 'date' },
  { key: 'actor', header: 'Actor', type: 'string' },
  { key: 'action', header: 'Action', type: 'string' },
  { key: 'ask_id', header: 'Ask id', type: 'string' },
  { key: 'detail', header: 'Detail', type: 'string' },
  { key: 'request_id', header: 'Request id', type: 'string' },
  { key: 'route', header: 'Route', type: 'string' }
]

async function* auditRows(store: OperatorStore, filters: ExportFilters): AsyncGenerator<ExportRow[]> {
  const rows = await store.listAudit(MAX_ROWS, { since: filters.since, actor: filters.actor, action: filters.action })
  const filtered = rows
    .filter((r) => filters.until == null || r.ts <= filters.until)
    .filter((r) => matchesQuery(filters.q, [r.actor, r.action, r.detail, r.route, r.request_id]))
  yield* fromBoundedArray(filtered, projectAudit)
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

function projectEvent(row: EventRow): ExportRow {
  const safe = projectEventTelemetry(row)
  return {
    ts: safe.ts,
    kind: safe.kind,
    actor: safe.actor,
    device_id: safe.device_id,
    country: safe.country,
    detail: safe.detail
  }
}

const EVENTS_COLUMNS: ExportColumn[] = [
  { key: 'ts', header: 'When', type: 'date' },
  { key: 'kind', header: 'Kind', type: 'string' },
  { key: 'actor', header: 'Actor', type: 'string' },
  { key: 'device_id', header: 'Seat', type: 'string' },
  { key: 'country', header: 'Country', type: 'string' },
  { key: 'detail', header: 'Detail', type: 'string' }
]

async function* eventsRows(store: OperatorStore, filters: ExportFilters): AsyncGenerator<ExportRow[]> {
  let cursor: string | undefined
  do {
    const page = await store.listEvents(BATCH_SIZE, {
      since: filters.since,
      until: filters.until,
      kinds: filters.kinds,
      country: filters.country,
      os: filters.os,
      q: filters.q,
      cursor,
      limit: BATCH_SIZE
    })
    if (page.rows.length) yield page.rows.map(projectEvent)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

function sessionDuration(row: SessionRow): number {
  const end = row.ended_at ?? row.last_pulse_at
  return Math.max(0, end - row.started_at)
}

function projectSession(row: SessionRow): ExportRow {
  return {
    started_at: row.started_at,
    last_pulse_at: row.last_pulse_at,
    ended_at: row.ended_at,
    device_id: row.device_id,
    country: row.country,
    city: row.city,
    os: row.os,
    app_version: row.app_version,
    pulses: row.pulses,
    asks: row.asks,
    recaps: row.recaps,
    duration_ms: sessionDuration(row)
  }
}

const SESSIONS_COLUMNS: ExportColumn[] = [
  { key: 'started_at', header: 'Started', type: 'date' },
  { key: 'last_pulse_at', header: 'Last pulse', type: 'date' },
  { key: 'ended_at', header: 'Ended', type: 'date' },
  { key: 'device_id', header: 'Seat', type: 'string' },
  { key: 'country', header: 'Country', type: 'string' },
  { key: 'city', header: 'City', type: 'string' },
  { key: 'os', header: 'OS', type: 'string' },
  { key: 'app_version', header: 'Client', type: 'string' },
  { key: 'pulses', header: 'Events', type: 'number' },
  { key: 'asks', header: 'Asks', type: 'number' },
  { key: 'recaps', header: 'Recaps', type: 'number' },
  { key: 'duration_ms', header: 'Duration (ms)', type: 'number' }
]

async function* sessionsRows(store: OperatorStore, filters: ExportFilters): AsyncGenerator<ExportRow[]> {
  let cursor: string | undefined
  do {
    const page = await store.listSessions({ since: filters.since, until: filters.until, cursor, limit: BATCH_SIZE })
    let rows = page.rows
    if (filters.country) rows = rows.filter((r) => (r.country || '').toUpperCase() === filters.country!.toUpperCase())
    if (filters.os) rows = rows.filter((r) => (r.os || '').toLowerCase() === filters.os!.toLowerCase())
    if (filters.q) rows = rows.filter((r) => matchesQuery(filters.q, [r.device_id, r.country, r.city, r.os, r.app_version]))
    if (rows.length) yield rows.map(projectSession)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
}

// ---------------------------------------------------------------------------
// asks (no prompt text, no cipher)
// ---------------------------------------------------------------------------

function projectAsk(row: AskRow): ExportRow {
  const safe = projectAskTelemetry(row)
  return {
    id: safe.id,
    ts: safe.ts,
    device_id: safe.device_id,
    mode: safe.mode,
    provider: safe.provider,
    model: safe.model,
    outcome: safe.outcome,
    rating: safe.rating,
    question_type: safe.question_type,
    detail: safe.preview
  }
}

const ASKS_COLUMNS: ExportColumn[] = [
  { key: 'id', header: 'Ask id', type: 'string' },
  { key: 'ts', header: 'When', type: 'date' },
  { key: 'device_id', header: 'Seat', type: 'string' },
  { key: 'mode', header: 'Mode', type: 'string' },
  { key: 'provider', header: 'Provider', type: 'string' },
  { key: 'model', header: 'Model', type: 'string' },
  { key: 'outcome', header: 'Outcome', type: 'string' },
  { key: 'rating', header: 'Rating', type: 'string' },
  { key: 'question_type', header: 'Question type', type: 'string' },
  { key: 'detail', header: 'Detail', type: 'string' }
]

async function* asksRows(store: OperatorStore, filters: ExportFilters): AsyncGenerator<ExportRow[]> {
  const rows = (await store.listAsks(MAX_ROWS, filters.since)).map(projectAskTelemetry)
  const filtered = rows
    .filter((r) => filters.until == null || r.ts <= filters.until)
    .filter((r) => matchesQuery(filters.q, [r.mode, r.provider, r.model, r.outcome, r.preview]))
  yield* fromBoundedArray(filtered, projectAsk)
}

// ---------------------------------------------------------------------------
// licenses (issued, last4 only)
// ---------------------------------------------------------------------------

function licenseStatusOf(row: IssuedLicenseRow, now: number): 'revoked' | 'active' | 'expired' {
  if (row.revoked) return 'revoked'
  return issuedLicenseActive(row, now) ? 'active' : 'expired'
}

function projectLicense(row: IssuedLicenseRow, now: number): ExportRow {
  return {
    jti: row.jti,
    last4: row.last4,
    days: row.days,
    iat: row.iat * 1000,
    exp: row.exp * 1000,
    status: licenseStatusOf(row, now),
    tier: row.tier ?? null,
    group_id: row.group_id ?? null,
    member: row.member ?? null,
    activated_device: row.activated_device ?? null,
    activated_at: row.activated_at ?? null,
    created_at: row.created_at,
    created_by: row.created_by
  }
}

const LICENSES_COLUMNS: ExportColumn[] = [
  { key: 'jti', header: 'License id', type: 'string' },
  { key: 'last4', header: 'Last 4', type: 'string' },
  { key: 'days', header: 'Days', type: 'number' },
  { key: 'iat', header: 'Issued', type: 'date' },
  { key: 'exp', header: 'Expires', type: 'date' },
  { key: 'status', header: 'Status', type: 'string' },
  { key: 'tier', header: 'Tier', type: 'string' },
  { key: 'group_id', header: 'Group', type: 'string' },
  { key: 'member', header: 'Member', type: 'string' },
  { key: 'activated_device', header: 'Activated seat', type: 'string' },
  { key: 'activated_at', header: 'Activated at', type: 'date' },
  { key: 'created_at', header: 'Created', type: 'date' },
  { key: 'created_by', header: 'Created by', type: 'string' }
]

async function* licensesRows(store: OperatorStore, filters: ExportFilters): AsyncGenerator<ExportRow[]> {
  const now = filters.now ?? Date.now()
  const rows = await store.listIssuedLicenses(MAX_ROWS)
  let filtered = rows
    .filter((r) => filters.since == null || r.created_at >= filters.since!)
    .filter((r) => filters.until == null || r.created_at <= filters.until!)
  if (filters.status) filtered = filtered.filter((r) => licenseStatusOf(r, now) === filters.status)
  filtered = filtered.filter((r) => matchesQuery(filters.q, [r.last4, r.tier, r.group_id, r.member, r.created_by]))
  yield* fromBoundedArray(filtered, (r) => projectLicense(r, now))
}

// ---------------------------------------------------------------------------
// integrations (last4 only, no cipher, no config secrets)
// ---------------------------------------------------------------------------

function projectIntegration(row: {
  id: string
  kind: string
  label: string
  last4: string | null
  status: string
  created_at: number
  created_by: string | null
  rotated_at: number | null
  revoked_at: number | null
  last_used_at: number | null
  uses: number
}): ExportRow {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    last4: row.last4,
    status: row.status,
    created_at: row.created_at,
    created_by: row.created_by,
    rotated_at: row.rotated_at,
    revoked_at: row.revoked_at,
    last_used_at: row.last_used_at,
    uses: row.uses
  }
}

const INTEGRATIONS_COLUMNS: ExportColumn[] = [
  { key: 'id', header: 'Connector id', type: 'string' },
  { key: 'kind', header: 'Kind', type: 'string' },
  { key: 'label', header: 'Label', type: 'string' },
  { key: 'last4', header: 'Last 4', type: 'string' },
  { key: 'status', header: 'Status', type: 'string' },
  { key: 'created_at', header: 'Created', type: 'date' },
  { key: 'created_by', header: 'Created by', type: 'string' },
  { key: 'rotated_at', header: 'Rotated', type: 'date' },
  { key: 'revoked_at', header: 'Revoked', type: 'date' },
  { key: 'last_used_at', header: 'Last used', type: 'date' },
  { key: 'uses', header: 'Uses', type: 'number' }
]

async function* integrationsRows(store: OperatorStore, filters: ExportFilters): AsyncGenerator<ExportRow[]> {
  const rows = await store.listIntegrationsMeta()
  let filtered = rows
  if (filters.status) filtered = filtered.filter((r) => r.status === filters.status)
  filtered = filtered.filter((r) => matchesQuery(filters.q, [r.kind, r.label]))
  yield* fromBoundedArray(filtered.slice(0, MAX_ROWS), projectIntegration)
}

// ---------------------------------------------------------------------------
// seats
// ---------------------------------------------------------------------------

function safe(value: string | null): string | null {
  return value && !looksLikeSecret(value) ? value : null
}

function projectSeat(row: SeatRow): ExportRow {
  return {
    device_id: row.device_id,
    hostname: safe(row.hostname),
    email: safe(row.sso_email),
    os: row.os,
    app_version: row.app_version,
    country: row.country,
    city: row.city,
    approval: approvalOf(row),
    license: safe(row.license),
    first_seen: row.first_seen,
    last_seen: row.last_seen
  }
}

const SEATS_COLUMNS: ExportColumn[] = [
  { key: 'device_id', header: 'Seat', type: 'string' },
  { key: 'hostname', header: 'Hostname', type: 'string' },
  { key: 'email', header: 'Email', type: 'string' },
  { key: 'os', header: 'OS', type: 'string' },
  { key: 'app_version', header: 'Client', type: 'string' },
  { key: 'country', header: 'Country', type: 'string' },
  { key: 'city', header: 'City', type: 'string' },
  { key: 'approval', header: 'Approval', type: 'string' },
  { key: 'license', header: 'License', type: 'string' },
  { key: 'first_seen', header: 'First seen', type: 'date' },
  { key: 'last_seen', header: 'Last seen', type: 'date' }
]

async function* seatsRows(store: OperatorStore, filters: ExportFilters): AsyncGenerator<ExportRow[]> {
  let rows = (await store.listSeats()).filter(isRealSeat)
  if (filters.country) rows = rows.filter((r) => (r.country || '').toUpperCase() === filters.country!.toUpperCase())
  if (filters.os) rows = rows.filter((r) => (r.os || '').toLowerCase() === filters.os!.toLowerCase())
  if (filters.status) rows = rows.filter((r) => approvalOf(r) === filters.status)
  if (filters.since != null) rows = rows.filter((r) => r.last_seen >= filters.since!)
  if (filters.until != null) rows = rows.filter((r) => r.last_seen <= filters.until!)
  rows = rows.filter((r) => matchesQuery(filters.q, [r.hostname, r.sso_email, r.device_id, r.os, r.app_version]))
  yield* fromBoundedArray(rows.slice(0, MAX_ROWS), projectSeat)
}

// ---------------------------------------------------------------------------

const TABLE_DEFS: Record<ExportTable, ExportTableDef> = {
  audit: { table: 'audit', columns: AUDIT_COLUMNS, rows: auditRows },
  events: { table: 'events', columns: EVENTS_COLUMNS, rows: eventsRows },
  sessions: { table: 'sessions', columns: SESSIONS_COLUMNS, rows: sessionsRows },
  asks: { table: 'asks', columns: ASKS_COLUMNS, rows: asksRows },
  licenses: { table: 'licenses', columns: LICENSES_COLUMNS, rows: licensesRows },
  integrations: { table: 'integrations', columns: INTEGRATIONS_COLUMNS, rows: integrationsRows },
  seats: { table: 'seats', columns: SEATS_COLUMNS, rows: seatsRows }
}

export function exportTableDef(table: ExportTable): ExportTableDef {
  return TABLE_DEFS[table]
}

/** Parses the query-string filters `routes/export.ts` accepts, shared by both `export.csv` and
 *  `export.xlsx` so the two formats can never silently disagree about what "the current filter set"
 *  means for the same request. */
export function filtersFromSearchParams(params: URLSearchParams): ExportFilters {
  const since = params.get('since')
  const until = params.get('until')
  const q = params.get('q')?.trim()
  const actor = params.get('actor')?.trim()
  const action = params.get('action')?.trim()
  const kinds = params.get('kinds')
  const country = params.get('country')?.trim()
  const os = params.get('os')?.trim()
  const status = params.get('status')?.trim()
  const filters: ExportFilters = {}
  if (since != null && since !== '' && Number.isFinite(Number(since))) filters.since = Number(since)
  if (until != null && until !== '' && Number.isFinite(Number(until))) filters.until = Number(until)
  if (q) filters.q = q
  if (actor) filters.actor = actor
  if (action) filters.action = action
  if (kinds) filters.kinds = kinds.split(',').map((k) => k.trim()).filter(Boolean)
  if (country) filters.country = country
  if (os) filters.os = os
  if (status) filters.status = status
  return filters
}
