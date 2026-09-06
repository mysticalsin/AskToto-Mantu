/** Reference DataTableClient / WideTable: a plain `<table>` with an `emptyState()` fallback
 * when there are no rows. Column widths follow content (no `table-layout:fixed` here — that's
 * left to the caller's wrapper) so it degrades to `overflow-x:auto` on narrow screens. */
import { esc } from './index'
import { emptyState } from './primitives'

export type DataTableColumn = { key: string; label: string }
export type DataTableRow = { cells: Record<string, string>; attrs?: string }

export function dataTable(opts: {
  columns: DataTableColumn[]
  rows: DataTableRow[]
  emptyTitle: string
  emptyDescription?: string
  id?: string
  rowClass?: string
}): string {
  if (!opts.rows.length) {
    return emptyState({ title: opts.emptyTitle, description: opts.emptyDescription })
  }
  const idAttr = opts.id ? ` id="${esc(opts.id)}"` : ''
  const head = `<thead><tr>${opts.columns.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>`
  const body = opts.rows
    .map(
      (r) =>
        `<tr class="${esc(opts.rowClass || '')}" ${r.attrs || ''}>${opts.columns
          .map((c) => `<td>${r.cells[c.key] ?? ''}</td>`)
          .join('')}</tr>`
    )
    .join('')
  return `<div class="table-wrap" style="overflow-x:auto"><table${idAttr}>${head}<tbody>${body}</tbody></table></div>`
}
