/** Reference MetricTiles.tsx: ONE card with an internal divided grid (2 cols mobile, 4 desktop)
 * of tiles — not N separate cards (SPEC rule 6). Each tile is a label + delta chip (or a
 * pinging live dot), a big value, a muted caption, and an optional mini sparkline. */
import { esc } from './index'
import { deltaChip, sourceTooltip } from './primitives'

export type MetricTile = {
  label: string
  value: string
  /** The plain number `value` displays, when there is one -- lets motion-bind.ts count up to
   * it on first paint (plan 3.5: "KPI numerals count up 800ms on first paint") without every
   * caller re-deriving a number from an already-formatted string. Omit for tiles whose value
   * cannot be counted (a range, a rate that is not a plain integer, "not reported"). */
  rawValue?: number
  delta?: number | null
  live?: boolean
  caption?: string
  spark?: string
  /** Formula + source for the hover tooltip (plan 3.7 item 10). */
  formula?: string
  source?: string
}

export function metricTiles(tiles: MetricTile[]): string {
  const cells = tiles
    .map((t, i) => {
      const badge = t.live ? '<span class="live" aria-hidden="true" data-beacon></span>' : deltaChip(t.delta ?? null, { flashKey: `tile-${i}` })
      const caption = t.caption ? `<div class="sub">${esc(t.caption)}</div>` : ''
      const countAttr = typeof t.rawValue === 'number' ? ` data-count-to="${t.rawValue}"` : ''
      const source = t.formula && t.source ? sourceTooltip(t.formula, t.source) : ''
      return `<div class="mtile">
        <div class="kpi-top"><span class="eyebrow eyebrow-flush">${esc(t.label)}${source}</span>${badge}</div>
        <div class="n"${countAttr} data-flash-key="tile-${i}">${esc(t.value)}</div>
        ${caption}
        ${t.spark || ''}
      </div>`
    })
    .join('')
  return `<div class="card mtiles-card mtiles-card-flush"><div class="mtiles-grid">${cells}</div></div>`
}
