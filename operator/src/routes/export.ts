/**
 * `GET /v1/admin/export.csv` and `GET /v1/admin/export.xlsx` (task B10, plan D11): admin only, one
 * export per table (`operator/src/export/tables.ts`), streamed through `csv.ts`/`xlsx.ts` so memory
 * stays flat regardless of row count. Every export writes one `export` audit row with the table,
 * format, row count and the filter set, once the stream has actually finished producing rows (a
 * client that disconnects early still gets a truthful row count, since the Worker keeps running the
 * generator to completion either way - `ReadableStream.cancel` is not wired to abort it, matching how
 * every other admin mutation here is audited after the fact, not before).
 *
 * Replaces the old `export.csv` handler in `admin-core.ts` (removed there; see that file's diff).
 */
import { noStoreHeaders, json } from '../http'
import { buildXlsxStream } from '../export/xlsx'
import { csvRows } from '../export/csv'
import { EXPORT_TABLES, exportTableDef, filtersFromSearchParams, isExportTable, type ExportFilters, type ExportRow, type ExportTable } from '../export/tables'
import { auditLog, type AdminCtx } from './admin-ctx'
import { defineRoute } from './registry'

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** `yyyymmdd-hhmm`, UTC, so the filename is stable regardless of the server's local timezone. */
function timestampForFilename(now: number): string {
  const d = new Date(now)
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}-${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`
}

function filenameFor(table: ExportTable, ext: 'csv' | 'xlsx', now: number): string {
  return `metis-operator-${table}-${timestampForFilename(now)}.${ext}`
}

function parseTable(ctx: AdminCtx): ExportTable | null {
  const raw = ctx.url.searchParams.get('table')
  return isExportTable(raw) ? raw : null
}

function badTableResponse() {
  return json({ ok: false, error: `table must be one of ${EXPORT_TABLES.join(', ')}` }, 400)
}

/** Re-yields every batch unchanged, but tallies the total row count as it goes, so the caller can
 *  audit the real number of rows the Worker produced without buffering them a second time. */
async function* countingBatches(source: AsyncGenerator<ExportRow[]>, onCount: (n: number) => void): AsyncGenerator<ExportRow[]> {
  let count = 0
  for await (const batch of source) {
    count += batch.length
    yield batch
  }
  onCount(count)
}

/** Adapts an async generator of string/byte chunks into a `ReadableStream`, running `onFinish` once
 *  the generator is exhausted (and therefore the true row count is known) but before the stream
 *  closes - the Workers runtime keeps the request alive for exactly that long. */
function streamFrom(chunks: AsyncGenerator<Uint8Array | string>, onFinish: () => Promise<void>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let result: IteratorResult<Uint8Array | string>
      try {
        result = await chunks.next()
      } catch (err) {
        controller.error(err)
        return
      }
      if (result.done) {
        try {
          await onFinish()
        } finally {
          controller.close()
        }
        return
      }
      controller.enqueue(typeof result.value === 'string' ? encoder.encode(result.value) : result.value)
    }
  })
}

function auditDetail(table: ExportTable, format: 'csv' | 'xlsx', rowCount: number, filters: ExportFilters): string {
  return `table ${table} format ${format} rows ${rowCount} filters ${JSON.stringify(filters)}`.slice(0, 500)
}

/** Read-cost rate limit (security review, medium): an export can read up to `MAX_ROWS` (50,000) rows
 *  and hold a streamed response open, so it costs far more than a typical admin GET - shared by both
 *  formats under one bucket key per signed-in admin, same 60 s window `hitRate` uses everywhere else. */
const EXPORT_RATE_WINDOW_MS = 60_000
const EXPORT_RATE_MAX = 10

async function exportRateLimited(ctx: AdminCtx): Promise<Response | null> {
  const limited = await ctx.store.hitRate(`admin-read-export:${ctx.email}`, ctx.now, EXPORT_RATE_WINDOW_MS, EXPORT_RATE_MAX)
  if (!limited) return null
  return json({ ok: false, error: 'rate limited', code: 'rate', retryAfterMs: EXPORT_RATE_WINDOW_MS }, 429)
}

export function registerExportRoutes(): void {
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/v1/admin/export.csv',
    auth: 'admin',
    handler: async (_request, ctx) => {
      const limited = await exportRateLimited(ctx)
      if (limited) return limited
      const table = parseTable(ctx)
      if (!table) return badTableResponse()
      const filters = { ...filtersFromSearchParams(ctx.url.searchParams), now: ctx.now }
      const def = exportTableDef(table)
      let rowCount = 0
      const counted = countingBatches(def.rows(ctx.store, filters), (n) => {
        rowCount = n
      })
      const body = streamFrom(csvRows(def.columns, counted), async () => {
        await auditLog(ctx, 'export', null, auditDetail(table, 'csv', rowCount, filters))
      })
      return new Response(body, {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${filenameFor(table, 'csv', ctx.now)}"`,
          ...noStoreHeaders()
        }
      })
    }
  })

  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/v1/admin/export.xlsx',
    auth: 'admin',
    handler: async (_request, ctx) => {
      const limited = await exportRateLimited(ctx)
      if (limited) return limited
      const table = parseTable(ctx)
      if (!table) return badTableResponse()
      const filters = { ...filtersFromSearchParams(ctx.url.searchParams), now: ctx.now }
      const def = exportTableDef(table)
      let rowCount = 0
      const counted = countingBatches(def.rows(ctx.store, filters), (n) => {
        rowCount = n
      })
      const body = streamFrom(
        buildXlsxStream({ columns: def.columns, sheetName: table, batches: counted, now: new Date(ctx.now) }),
        async () => {
          await auditLog(ctx, 'export', null, auditDetail(table, 'xlsx', rowCount, filters))
        }
      )
      return new Response(body, {
        headers: {
          'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'content-disposition': `attachment; filename="${filenameFor(table, 'xlsx', ctx.now)}"`,
          ...noStoreHeaders()
        }
      })
    }
  })
}
