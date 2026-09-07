/**
 * Overview page SVG helpers (plan 6.2, P1.2). Owned exclusively by the Overview page: no other
 * page module imports from this file. Kept dependency-free like operator/src/render/index.ts so
 * it bundles cleanly into both the Worker and the browser client.
 *
 * Every value drawn here comes from a real DashboardPayload field passed in by
 * operator/src/render/pages/overview.ts -- nothing in this file invents a number (plan lock 3).
 * No hex literals (plan lock: "no hex literal outside css.ts"): every fill/stroke is a
 * `var(--token)` reference, the same convention operator/src/charts.ts already uses.
 */
import { esc } from '../index'
import type { MapCountry } from '../../dashboard'

const CHART_SCALE_STEPS = 5

/** Smallest top-of-scale the seat area chart will use. See `areaChartWithPrevious`. */
const AREA_SCALE_FLOOR = 4

/**
 * Headroom above the series, so the busiest point never touches the top of the frame.
 *
 * A chart scaled exactly to its own maximum puts that maximum on the ceiling, and a series that
 * does not vary puts EVERY point there: the seat chart, drawn from a steady twelve seats a day,
 * filled its whole card with one solid block of colour and read as a broken panel rather than a
 * flat trend. A fifth of the height in reserve is enough for the line to sit inside the frame and
 * be legible as a line. The axis label still prints the real top of the scale, so the extra space
 * is visible as scale, never as invented data.
 */
const SCALE_HEADROOM = 1.2

/**
 * Area chart with an optional dashed previous-period line (plan 3.2/3.5b: "area chart with
 * previous period dashed"). `previous` is omitted whenever the payload has no prior-period
 * series -- DashboardPayload does not compute one today (see the Overview report's data-gap
 * note), so this draws only the solid current-period line and area until that lands. The path
 * itself is drawn in client-side over 800ms by operator/client/motion.ts's `drawPath()`
 * (`[data-ov-area-line]`), matching plan 3.5b "path draws in over 800ms, area fill fades in
 * after, previous-period dashed line fades last" -- the fade-in timing lives in
 * operator/src/spa/css-overview.ts as a plain CSS animation (delay-staggered), not here.
 */
export function areaChartWithPrevious(opts: {
  current: number[]
  previous?: number[] | null
  labels?: string[]
  width?: number
  height?: number
}): string {
  const w = opts.width ?? 860
  const h = opts.height ?? 220
  const current = opts.current || []
  const previous = opts.previous && opts.previous.length ? opts.previous : null
  if (!current.length || current.every((v) => v === 0)) {
    return `<div class="empty ov-area-empty">No seat activity in this window yet.</div>`
  }
  const padTop = 18
  const padBottom = 24
  const padX = 4
  const innerH = h - padTop - padBottom
  const innerW = w - padX * 2
  const allVals = previous ? [...current, ...previous] : current
  // Headroom floor. Scaling to the series max alone means a fleet with a single seat gets a chart
  // whose entire vertical range is 0 to 1: the one day someone opened Métis pins to the top of the
  // frame and the line reads as a cliff, which looks like a spike in traffic rather than one seat.
  // A floor of 4 keeps small real numbers small on screen; the axis label still prints the true top
  // of the scale, so nothing is overstated. Once the fleet passes 4 the series drives the scale again.
  const max = Math.max(AREA_SCALE_FLOOR, ...allVals) * SCALE_HEADROOM
  const baseline = padTop + innerH
  const stepFor = (arr: number[]): number => (arr.length > 1 ? innerW / (arr.length - 1) : 0)
  const pointsFor = (arr: number[]): string[] => {
    const step = stepFor(arr)
    return arr.map((v, i) => {
      const x = padX + i * step
      const y = padTop + innerH - (Math.max(0, v) / max) * innerH
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
  }
  const curPts = pointsFor(current)
  const curStep = stepFor(current)
  const lastX = (padX + curStep * (current.length - 1)).toFixed(1)
  const areaD = `M${padX},${baseline} L${curPts.join(' L')} L${lastX},${baseline} Z`
  const lineD = `M${curPts.join(' L')}`
  const prevPath = previous
    ? `<path class="ov-area-prev" data-ov-area-prev d="M${pointsFor(previous).join(' L')}" fill="none" stroke="var(--ink-3)" stroke-width="1.5" stroke-dasharray="5 4" />`
    : ''
  const labels = opts.labels || []
  const ticks = labels
    .map((lab, i) => {
      if (!lab) return ''
      const x = padX + i * curStep
      const anchor = i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'
      return `<text x="${x.toFixed(1)}" y="${h - 6}" class="ov-area-tick" text-anchor="${anchor}">${esc(lab)}</text>`
    })
    .join('')
  const yMax = max >= 1000 ? `${Math.round(max / 1000)}k` : String(Math.round(max))
  const legend = previous
    ? `<div class="ov-area-legend"><span class="ov-area-legend-item"><i class="ov-area-swatch ov-area-swatch-cur" aria-hidden="true"></i>This period</span><span class="ov-area-legend-item"><i class="ov-area-swatch ov-area-swatch-prev" aria-hidden="true"></i>Previous period</span></div>`
    : ''
  return `<svg class="ov-area-chart" data-ov-area viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Unique seats over time">
    <text x="4" y="12" class="ov-area-tick">${esc(yMax)}</text>
    <text x="4" y="${(baseline - 4).toFixed(1)}" class="ov-area-tick">0</text>
    <path class="ov-area-fill" data-ov-area-fill d="${areaD}" fill="var(--data-1)" fill-opacity="0.12" />
    <path class="ov-area-line" data-ov-area-line d="${lineD}" fill="none" stroke="var(--data-1)" stroke-width="1.5" />
    ${prevPath}
    ${ticks}
  </svg>${legend}`
}

/**
 * Small bar spark for a metric tile (plan 3.5b: "mini bars grow from the baseline, staggered
 * 20ms per bar"). Generalizes operator/src/render/live.ts's `visitorsBars()` (fixed at 30 bars,
 * sized for the Realtime strip) to an arbitrary series length -- Overview's tile sparks are
 * 7-point daily series, not 30-point minute series. Every bar carries `data-grow` and a 20ms
 * stagger delay, wired for free by operator/client/motion-bind.ts.
 */
export function miniBars(values: number[], opts?: { width?: number; height?: number; token?: 1 | 2 | 3 | 4 }): string {
  const w = opts?.width ?? 104
  const h = opts?.height ?? 28
  const vals = values || []
  if (!vals.length || vals.every((v) => v === 0)) {
    return `<svg class="ov-mini-bars ov-mini-bars-empty" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><line x1="0" y1="${h - 1}" x2="${w}" y2="${h - 1}" stroke="var(--border)" /></svg>`
  }
  const max = Math.max(1, ...vals) * SCALE_HEADROOM
  const gap = 2
  const n = vals.length
  const bw = Math.max(2, (w - gap * (n + 1)) / n)
  const color = `var(--data-${opts?.token ?? 1})`
  const rects = vals
    .map((v, i) => {
      // A day with nothing in it draws nothing. The 2px floor keeps a real but small value visible
      // against a large max; applying it to zero as well drew a coloured stub for a day that had no
      // activity, so a sparse week read as seven small events instead of one real one.
      const bh = v <= 0 ? 0 : Math.max(2, Math.round((v / max) * (h - 4)))
      if (!bh) return ''
      const x = gap + i * (bw + gap)
      const y = h - bh
      return `<rect x="${x.toFixed(1)}" y="${y}" width="${bw.toFixed(1)}" height="${bh}" rx="1" fill="${color}" data-grow data-grow-delay="${i * 20}" />`
    })
    .join('')
  return `<svg class="ov-mini-bars" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${rects}</svg>`
}

export interface TokenParts {
  in: number
  out: number
  cacheRead: number
  cacheWrite: number
}

/**
 * Token-mix stacked bar (plan 3.7b law 4: "token tracking is a first-class view"). One segment
 * per component in `--data-1..4` (the token sheet's own chart-series order), each `data-grow` so
 * the segments grow in on first paint. Renders the neutral `--data-track` fill when every
 * component is zero (never a fabricated split).
 */
export function tokenStackBar(parts: TokenParts, opts?: { height?: number }): string {
  const h = opts?.height ?? 10
  const total = Math.max(0, parts.in) + Math.max(0, parts.out) + Math.max(0, parts.cacheRead) + Math.max(0, parts.cacheWrite)
  if (total <= 0) {
    return `<svg class="ov-token-bar ov-token-bar-empty" viewBox="0 0 100 ${h}" preserveAspectRatio="none" aria-hidden="true"><rect width="100" height="${h}" rx="3" fill="var(--data-track)" /></svg>`
  }
  const segs: { value: number; token: 1 | 2 | 3 | 4 }[] = [
    { value: parts.in, token: 1 },
    { value: parts.out, token: 2 },
    { value: parts.cacheRead, token: 3 },
    { value: parts.cacheWrite, token: 4 }
  ]
  let x = 0
  const rects = segs
    .map((s) => {
      const pct = (Math.max(0, s.value) / total) * 100
      if (pct <= 0) return ''
      const rect = `<rect x="${x.toFixed(2)}" y="0" width="${pct.toFixed(2)}" height="${h}" rx="1.5" fill="var(--data-${s.token})" data-grow />`
      x += pct
      return rect
    })
    .join('')
  return `<svg class="ov-token-bar" viewBox="0 0 100 ${h}" preserveAspectRatio="none" role="img" aria-label="Token mix, in, out, cache read, cache write">${rects}</svg>`
}

/**
 * Recolours operator/src/charts.ts's `choroplethMini()` output through CSS classes instead of
 * its own inline `fill` (plan brief: "use the existing choropleth SVG function from charts.ts as
 * is, wrapped in your own container, and recolour it through CSS classes on data-iso paths using
 * --chart-scale-01..05"). `renderCornerMapSvg` (operator/src/world/map.ts) already stamps every
 * land path with `data-iso`, so this only needs to add a `scale-N` class per path -- a real CSS
 * class rule always outranks an SVG presentation attribute's fill (presentation attributes carry
 * specificity 0), so the added class wins over the function's own inline colour without touching
 * charts.ts. `scale-0` (→ `--data-track`) marks a country with zero devices; `scale-1..5` bucket
 * the rest evenly against the fleet's own max, matching plan 3.2's sequential scale.
 */
export function recolorChoroplethMini(svg: string, countries: MapCountry[]): string {
  const byIso = new Map(countries.map((c) => [c.iso, c.devices]))
  const max = Math.max(0, ...countries.map((c) => c.devices))
  // `renderCornerMapSvg` (operator/src/world/map.ts) always emits `class="world-land"`
  // immediately before `data-iso="XX"` on every land path -- append to that existing class
  // attribute rather than adding a second one (two `class=` attributes on one element is
  // invalid markup and only the first would ever apply).
  return svg.replace(/class="world-land" data-iso="([A-Za-z]{2})"/g, (match, iso: string) => {
    const devices = byIso.get(iso.toUpperCase()) ?? 0
    const bucket = devices <= 0 || max <= 0 ? 0 : Math.min(CHART_SCALE_STEPS, Math.max(1, Math.ceil((devices / max) * CHART_SCALE_STEPS)))
    return `class="world-land ov-map-scale-${bucket}" data-iso="${iso}"`
  })
}
