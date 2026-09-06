/** Reference DataTableClient / WideTable: a plain `<table>` with an `emptyState()` fallback
 * when there are no rows. Column widths follow content (no `table-layout:fixed` here, that's
 * left to the caller's wrapper) so it degrades to `overflow-x:auto` on narrow screens.
 *
 * Plan 3.5c adds a second look, `variant: 'card'` (ported from a supplied shadcn card-variant
 * table): rows separated rather than ruled, a --surface band per row with a 1px top highlight,
 * numeric columns right-aligned mono, and sortable headers with an up/down/neutral double-arrow
 * glyph. The default variant below is untouched, byte for byte, so no existing caller or test
 * moves; `renderCardTable()` is a separate code path only reached when `variant: 'card'` is
 * passed explicitly. */
import { esc } from './index'
import { emptyState } from './primitives'
import { iconSvg, NAV_ICON_PATHS } from './icons'

export type DataTableColumn = {
  key: string
  label: string
  /** Card variant only: right-align and use mono for this column (plan 3.5c). Ignored by the
   *  default variant. */
  numeric?: boolean
  /** Card variant only: renders the up/down/neutral sort arrow and the data-sort hook. */
  sortable?: boolean
  /** Card variant only: which way this column is currently sorted, if at all. */
  sortDirection?: 'asc' | 'desc' | null
}
export type DataTableRow = { cells: Record<string, string>; attrs?: string; selected?: boolean }

export function dataTable(opts: {
  columns: DataTableColumn[]
  rows: DataTableRow[]
  emptyTitle: string
  emptyDescription?: string
  id?: string
  rowClass?: string
  /** Plan 3.5c: 'card' is used on Connectors, Groups, Licenses and Audit. Omit (or 'default')
   *  for the existing dense, ruled look every other page keeps using. */
  variant?: 'default' | 'card'
  /** Card variant only: a footer row in a slightly mixed surface (plan 3.5c). */
  footer?: string
}): string {
  if (!opts.rows.length) {
    return emptyState({ title: opts.emptyTitle, description: opts.emptyDescription })
  }
  if (opts.variant === 'card') {
    return renderCardTable(opts)
  }
  const idAttr = opts.id ? ` id="${esc(opts.id)}"` : ''
  const head = `<thead><tr>${opts.columns.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>`
  const body = opts.rows
    .map(
      (r) =>
        `<tr class="${esc(opts.rowClass || '')}${r.selected ? ' is-selected' : ''}" data-stagger ${r.attrs || ''}>${opts.columns
          .map((c) => `<td>${r.cells[c.key] ?? ''}</td>`)
          .join('')}</tr>`
    )
    .join('')
  return `<div class="table-wrap"><table${idAttr}>${head}<tbody>${body}</tbody></table></div>`
}

function sortArrowIcon(direction: 'asc' | 'desc' | null | undefined): string {
  const key = direction === 'asc' ? 'arrow-up' : direction === 'desc' ? 'arrow-down' : 'arrow-up-down'
  return iconSvg(NAV_ICON_PATHS[key], { class: 'dt-sort-ic' })
}

function renderCardTable(opts: {
  columns: DataTableColumn[]
  rows: DataTableRow[]
  id?: string
  rowClass?: string
  footer?: string
}): string {
  const idAttr = opts.id ? ` id="${esc(opts.id)}"` : ''
  const head = `<thead><tr>${opts.columns
    .map((c) => {
      const numeric = c.numeric ? ' dt-card-numeric' : ''
      if (!c.sortable) return `<th class="${numeric}">${esc(c.label)}</th>`
      return `<th class="dt-card-sortable${numeric}" data-sort="${esc(c.key)}" tabindex="0" role="button">${esc(c.label)}${sortArrowIcon(c.sortDirection)}</th>`
    })
    .join('')}</tr></thead>`
  const body = opts.rows
    .map(
      (r) =>
        `<tr class="${esc(opts.rowClass || '')}${r.selected ? ' is-selected' : ''}" data-stagger ${r.attrs || ''}>${opts.columns
          .map((c) => `<td class="${c.numeric ? 'dt-card-numeric' : ''}">${r.cells[c.key] ?? ''}</td>`)
          .join('')}</tr>`
    )
    .join('')
  const foot = opts.footer ? `<tfoot><tr><td colspan="${opts.columns.length}">${opts.footer}</td></tr></tfoot>` : ''
  return `<div class="table-wrap"><table class="dt-card"${idAttr}>${head}<tbody>${body}</tbody>${foot}</table></div>`
}
