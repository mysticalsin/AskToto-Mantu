/** Reference MetricTiles.tsx: ONE card with an internal divided grid (2 cols mobile, 4 desktop)
 * of tiles — not N separate cards (SPEC rule 6). Each tile is a label + delta chip (or a
 * pinging live dot), a big value, a muted caption, and an optional mini sparkline. */
import { esc } from './index'
import { deltaChip } from './primitives'

export type MetricTile = {
  label: string
  value: string
  delta?: number | null
  live?: boolean
  caption?: string
  spark?: string
}

export function metricTiles(tiles: MetricTile[]): string {
  const cells = tiles
    .map((t) => {
      const badge = t.live ? '<span class="live" aria-hidden="true"></span>' : deltaChip(t.delta ?? null)
      const caption = t.caption ? `<div class="sub">${esc(t.caption)}</div>` : ''
      return `<div class="mtile">
        <div class="kpi-top"><span class="eyebrow" style="margin:0">${esc(t.label)}</span>${badge}</div>
        <div class="n">${esc(t.value)}</div>
        ${caption}
        ${t.spark || ''}
      </div>`
    })
    .join('')
  return `<div class="card mtiles-card" style="padding:0"><div class="mtiles-grid">${cells}</div></div>`
}
