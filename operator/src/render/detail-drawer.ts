/** Reference DetailDrawer: a 384px right-side slide-in panel with a labeled field grid. Ships
 * `hidden` by default; the client toggles it (operator/client/motion.ts's slideIn()) and refills
 * `[data-drawer-body]` on row click (seat overlay, ask/event trace). Header is glass (plan 3.7
 * item 5, plan P0.3: "drawer with glass header"). */
import { esc } from './index'
import { logoGlyph } from './primitives'

export type DetailField = { label: string; value: string; wide?: boolean }

function fieldsHtml(fields: DetailField[]): string {
  return fields
    .map(
      (f) =>
        `<div class="seat-field${f.wide ? ' seat-overlay-wide' : ''}"><span class="lbl">${esc(f.label)}</span><span class="val">${f.value}</span></div>`
    )
    .join('')
}

export function detailDrawer(opts: { id: string; title?: string; fields?: DetailField[]; footer?: string }): string {
  const fields = fieldsHtml(opts.fields || [])
  return `<aside id="${esc(opts.id)}" class="seat-overlay" hidden role="dialog" aria-modal="true" aria-labelledby="${esc(opts.id)}-title">
    <div class="seat-overlay-head glass">
      <h4 id="${esc(opts.id)}-title" data-drawer-title>${esc(opts.title || '')}</h4>
      <button type="button" class="btn" id="${esc(opts.id)}-close" aria-label="Close">Close</button>
    </div>
    <div class="seat-overlay-grid" data-drawer-body>${fields}</div>
    ${opts.footer ? `<div class="row drawer-footer">${opts.footer}</div>` : ''}
  </aside>`
}

/**
 * Plan 6.10: the Connectors page connection drawer shell. Same slide-in/glass-header structure
 * as detailDrawer(), plus the connector's logo in the header and an optional "Docs" link. `row`
 * carries the field grid (credential fields, scope, mode) and a footer (Test connection /
 * Save) -- callers own the exact field list from the catalog entry; this is the shell only, as
 * asked (P0.3: "connectionDrawer(entry, row?) shell").
 */
export function connectionDrawer(
  entry: { kind: string; label: string; docsUrl?: string },
  row?: { fields?: DetailField[]; footer?: string }
): string {
  const fields = fieldsHtml(row?.fields || [])
  const docs = entry.docsUrl
    ? `<a class="chip" href="${esc(entry.docsUrl)}" target="_blank" rel="noreferrer">Docs</a>`
    : ''
  return `<aside id="connection-drawer" class="seat-overlay" hidden role="dialog" aria-modal="true" aria-labelledby="connection-drawer-title" data-connector="${esc(entry.kind)}">
    <div class="seat-overlay-head glass">
      ${logoGlyph(entry.kind, entry.label, { size: 24 })}
      <h4 id="connection-drawer-title" data-drawer-title>${esc(entry.label)}</h4>
      ${docs}
      <button type="button" class="btn" id="connection-drawer-close" aria-label="Close">Close</button>
    </div>
    <div class="seat-overlay-grid" data-drawer-body>${fields}</div>
    ${row?.footer ? `<div class="row drawer-footer">${row.footer}</div>` : ''}
  </aside>`
}
