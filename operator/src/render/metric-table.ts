/**
 * Reference MetricTable.tsx / GeoTable: grid `1fr auto auto auto`, 32px rows, a full-row
 * proportional bar behind the label (an inline SVG `.row-bar` rect, not a style attribute --
 * plan D6 tightens CSP to `style-src 'self'`, no `'unsafe-inline'`), sortable headers via
 * `data-sort` attributes, and extra columns that hide by the table's own *container* width
 * (650px / 350px / 150px), not the viewport (operator/shoey-ref/SPEC.md rule 8).
 */
import { esc } from './index'

export type MetricTableColumn = {
  key: string
  label: string
  sortable?: boolean
  /** Container-query breakpoint below which this column hides. One of 650 | 350 | 150, matching
   * the reference's three tiers, or omitted to always show. */
  hideBelowPx?: 650 | 350 | 150
}

export type MetricTableRow = {
  /** Icon/flag HTML shown before the label. */
  icon?: string
  label: string
  /** Raw value used only to size the proportional row bar (0 when omitted). */
  barValue?: number
  /** One rendered string per column key. */
  cells: Record<string, string>
  attrs?: string
}

function hideClass(px?: 650 | 350 | 150): string {
  return px ? ` mt-hide-${px}` : ''
}

export function metricTable(opts: {
  title: string
  labelHeader: string
  headerIcons?: string[]
  columns: MetricTableColumn[]
  rows: MetricTableRow[]
  emptyTitle?: string
  emptyDescription?: string
}): string {
  const maxBar = Math.max(1, ...opts.rows.map((r) => r.barValue ?? 0))
  const headerRow = `<div class="mt-row mt-head" role="row">
    <span role="columnheader">${esc(opts.labelHeader)}</span>
    ${opts.columns
      .map(
        (c) =>
          `<span role="columnheader" class="mt-col${hideClass(c.hideBelowPx)}"${c.sortable ? ` data-sort="${esc(c.key)}" tabindex="0" role="button"` : ''}>${esc(c.label)}</span>`
      )
      .join('')}
  </div>`
  const body = opts.rows.length
    ? opts.rows
        .map((r) => {
          const pct = maxBar > 0 ? Math.round(((r.barValue ?? 0) / maxBar) * 100) : 0
          return `<div class="mt-row" role="row" data-stagger ${r.attrs || ''}>
            <svg class="row-bar" aria-hidden="true"><rect width="${pct}%" height="100%" data-grow/></svg>
            <span class="mt-label" role="cell">${r.icon || ''}<span>${esc(r.label)}</span></span>
            ${opts.columns
              .map((c) => `<span class="mt-col${hideClass(c.hideBelowPx)}" role="cell">${r.cells[c.key] ?? ''}</span>`)
              .join('')}
          </div>`
        })
        .join('')
    : `<div class="empty" role="row">${esc(opts.emptyTitle || 'No rows yet.')}</div>`
  const icons = opts.headerIcons?.length ? `<div class="mt-flags">${opts.headerIcons.slice(0, 8).join('')}</div>` : ''
  return `<div class="mt-wrap" role="table" aria-label="${esc(opts.title)}">
    <div class="kpi-top"><p class="eyebrow">${esc(opts.title)}</p>${icons}</div>
    ${headerRow}
    <div class="mt-body">${body}</div>
  </div>`
}
