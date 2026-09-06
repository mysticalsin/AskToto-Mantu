/**
 * RFC 4180 CSV writer (task B10, plan D11): UTF-8 BOM, CRLF row endings, dates as ISO 8601, formula
 * injection guarded on every cell via `guardFormulaInjection` (shared with `xlsx.ts` in
 * `./tables.ts`, so the two formats can never disagree about what counts as a dangerous leading
 * character - a value starting with `=`, `+`, `-` or `@`, optionally after leading whitespace or a
 * control character, is prefixed with a single quote, the same convention Excel/Sheets/LibreOffice
 * all treat as "force text"). Streams from the same batched async row source `xlsx.ts` uses, so
 * memory stays flat regardless of row count.
 */
import { guardFormulaInjection, type ExportColumn, type ExportRow } from './tables'

export const CSV_BOM = '﻿'

export { guardFormulaInjection }

function formatCell(value: string | number | null, type: ExportColumn['type']): string {
  if (value == null) return ''
  if (type === 'date') {
    const ms = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(ms) ? new Date(ms).toISOString() : ''
  }
  return String(value)
}

/** RFC 4180 field escaping: a field containing a comma, a double quote or a line break is wrapped in
 *  double quotes, with internal double quotes doubled. Applied after the formula guard so a guarded
 *  `'=1+1` (no special characters) never needlessly gets quoted, but a value that needs both still
 *  gets both. */
export function csvField(raw: string): string {
  const guarded = guardFormulaInjection(raw)
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

export function csvLine(fields: string[]): string {
  return `${fields.join(',')}\r\n`
}

/** Header row, then one row per input row, as a stream of string chunks (one chunk per line) with a
 *  leading UTF-8 BOM so Excel opens the file as UTF-8 rather than guessing the system codepage. */
export async function* csvRows(columns: ExportColumn[], batches: AsyncIterable<ExportRow[]>): AsyncGenerator<string> {
  yield CSV_BOM
  yield csvLine(columns.map((c) => csvField(c.header)))
  for await (const batch of batches) {
    for (const row of batch) {
      yield csvLine(columns.map((c) => csvField(formatCell(row[c.key] ?? null, c.type))))
    }
  }
}
