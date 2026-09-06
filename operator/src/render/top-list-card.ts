/**
 * Reference TopListCard.tsx: a tab strip, a search row, a header row with 1 or 2 right-aligned
 * sortable value columns, 25px data rows with a full-row proportional bar, and a footer row.
 * Grid is `1fr 70px` for one value column, `1fr 70px 70px` for two (SPEC rule 5) — never
 * hardcode three columns.
 */
import { esc } from './index'
import { iconSvg, NAV_ICON_PATHS } from './icons'

export type TopListValueHeader = { key: string; label: string; sortable?: boolean; active?: boolean }
export type TopListRow = { icon?: string; label: string; barValue?: number; cells: Record<string, string>; attrs?: string }

export function topListCard(opts: {
  tabs?: { id: string; label: string; active?: boolean }[]
  searchPlaceholder?: string
  searchId?: string
  labelHeader: string
  valueHeaders: TopListValueHeader[]
  rows: TopListRow[]
  emptyTitle?: string
  footerRight?: string
}): string {
  const cols = opts.valueHeaders.length >= 2 ? '1fr 70px 70px' : '1fr 70px'
  const tabs = opts.tabs?.length
    ? `<div class="tlc-tabs" role="tablist">${opts.tabs
        .map((t) => `<button type="button" class="tlc-tab${t.active ? ' on' : ''}" role="tab" aria-selected="${t.active ? 'true' : 'false'}" data-tlc-tab="${esc(t.id)}">${esc(t.label)}</button>`)
        .join('')}</div>`
    : ''
  const search = opts.searchPlaceholder
    ? `<div class="tlc-search"><input${opts.searchId ? ` id="${esc(opts.searchId)}"` : ''} class="table-search" type="search" placeholder="${esc(opts.searchPlaceholder)}" autocomplete="off"></div>`
    : ''
  const maxBar = Math.max(1, ...opts.rows.map((r) => r.barValue ?? 0))
  const header = `<div class="tlc-row tlc-head" style="grid-template-columns:${cols}">
    <span>${esc(opts.labelHeader)}</span>
    ${opts.valueHeaders
      .map(
        (h) =>
          `<span class="tlc-sort" data-sort="${esc(h.key)}" tabindex="${h.sortable ? '0' : '-1'}">${esc(h.label)} ${iconSvg(NAV_ICON_PATHS[h.active ? 'chevron-down' : 'chevrons-up-down'], { class: 'tool-ic' })}</span>`
      )
      .join('')}
  </div>`
  const rows = opts.rows.length
    ? opts.rows
        .map((r) => {
          const pct = maxBar > 0 ? Math.round(((r.barValue ?? 0) / maxBar) * 100) : 0
          return `<div class="tlc-row" style="grid-template-columns:${cols}" ${r.attrs || ''}>
            <span class="tlc-bar" style="width:${pct}%" aria-hidden="true"></span>
            <span class="tlc-label">${r.icon || ''}<span>${esc(r.label)}</span></span>
            ${opts.valueHeaders.map((h) => `<span class="tlc-value">${r.cells[h.key] ?? ''}</span>`).join('')}
          </div>`
        })
        .join('')
    : `<div class="empty">${esc(opts.emptyTitle || 'No rows yet.')}</div>`
  const footer = `<div class="tlc-foot">${iconSvg(NAV_ICON_PATHS.search, { class: 'tool-ic' })}${opts.footerRight ? `<span class="tlc-foot-right">${opts.footerRight}</span>` : ''}</div>`
  return `<div class="card tlc" style="padding-bottom:0">
    ${tabs}
    ${search}
    ${header}
    <div class="tlc-body">${rows}</div>
    ${footer}
  </div>`
}
