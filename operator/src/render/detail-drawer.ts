/** Reference DetailDrawer: a 384px right-side slide-in panel with a labeled field grid. Ships
 * `hidden` by default; the client toggles it and refills `[data-drawer-body]` on row click
 * (seat overlay, ask/event trace). */
import { esc } from './index'

export type DetailField = { label: string; value: string; wide?: boolean }

export function detailDrawer(opts: { id: string; title?: string; fields?: DetailField[]; footer?: string }): string {
  const fields = (opts.fields || [])
    .map(
      (f) =>
        `<div class="seat-field${f.wide ? ' seat-overlay-wide' : ''}"><span class="lbl">${esc(f.label)}</span><span class="val">${f.value}</span></div>`
    )
    .join('')
  return `<aside id="${esc(opts.id)}" class="seat-overlay" hidden role="dialog" aria-modal="true" aria-labelledby="${esc(opts.id)}-title">
    <div class="seat-overlay-head">
      <h4 id="${esc(opts.id)}-title" data-drawer-title>${esc(opts.title || '')}</h4>
      <button type="button" class="btn" id="${esc(opts.id)}-close" aria-label="Close">Close</button>
    </div>
    <div class="seat-overlay-grid" data-drawer-body>${fields}</div>
    ${opts.footer ? `<div class="row" style="margin-top:12px">${opts.footer}</div>` : ''}
  </aside>`
}
