import { WORLD_PATHS } from './world-paths'
import { stripMapBands } from './map-bands'
import { projectPoint, renderCornerMapSvg, renderRealtimeMapSvg, type RealtimeMapPoint } from './world/map'
import type { MapCountry, MapDot, MixBar, SeriesPoint, TokenPoint } from './dashboard'

const MONO = ['#2a2a2e', '#3f3f46', '#71717a', '#a1a1aa', '#e4e4e7']

export function sparklineArea(values: number[], w = 220, h = 56): string {
  if (!values.length || values.every((v) => v === 0)) {
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><line x1="0" y1="${h - 2}" x2="${w}" y2="${h - 2}" stroke="var(--hair)" /></svg>`
  }
  const max = Math.max(...values, 1)
  const step = values.length > 1 ? w / (values.length - 1) : w
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 4) - 2).toFixed(1)}`)
  const d = `M0,${h} L${pts.join(' L')} L${w},${h} Z`
  const line = `M${pts.join(' L')}`
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="${d}" fill="url(#spark-fill)" />
    <path d="${line}" fill="none" stroke="var(--chart-4)" stroke-width="1.5" />
  </svg>`
}

export function sparklineLine(values: number[], w = 220, h = 56): string {
  if (!values.length || values.every((v) => v === 0)) {
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><line x1="0" y1="${h / 2}" x2="${w}" y2="${h / 2}" stroke="var(--hair)" /></svg>`
  }
  const max = Math.max(...values, 1)
  const step = values.length > 1 ? w / (values.length - 1) : w
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 6) - 3).toFixed(1)}`)
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="M${pts.join(' L')}" fill="none" stroke="var(--chart-4)" stroke-width="1.6" />
  </svg>`
}

export function dualLine(series: SeriesPoint[], w = 520, h = 140): string {
  const hb = series.map((s) => s.heartbeats)
  const asks = series.map((s) => s.asks)
  if (!series.length || (hb.every((v) => v === 0) && asks.every((v) => v === 0))) {
    return `<div class="empty">No heartbeats or Asks in this window.</div>`
  }
  const max = Math.max(...hb, ...asks, 1)
  const step = series.length > 1 ? w / (series.length - 1) : w
  const path = (vals: number[]): string =>
    vals.map((v, i) => `${(i * step).toFixed(1)},${(h - 18 - (v / max) * (h - 28)).toFixed(1)}`).join(' L')
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="M${path(hb)}" fill="none" stroke="var(--chart-5)" stroke-width="1.6" />
    <path d="M${path(asks)}" fill="none" stroke="var(--accent)" stroke-width="1.4" />
  </svg>`
}

function layerPath(vals: number[], w: number, h: number, max: number): string {
  const step = vals.length > 1 ? w / (vals.length - 1) : w
  const top = vals.map((v, i) => `${(i * step).toFixed(1)},${(h - 8 - (v / max) * (h - 16)).toFixed(1)}`)
  return `M0,${h} L${top.join(' L')} L${w},${h} Z`
}

export function stackedTokens(tokens: TokenPoint[], w = 520, h = 140): string {
  if (!tokens.length || tokens.every((t) => t.read + t.write + t.uncached === 0)) {
    return `<div class="empty">No cache token fields reported in this window.</div>`
  }
  const max = Math.max(...tokens.map((t) => t.read + t.write + t.uncached), 1)
  const read = tokens.map((t) => t.read)
  const write = tokens.map((t) => t.read + t.write)
  const all = tokens.map((t) => t.read + t.write + t.uncached)
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="${layerPath(all, w, h, max)}" fill="var(--chart-2)" />
    <path d="${layerPath(write, w, h, max)}" fill="var(--chart-3)" />
    <path d="${layerPath(read, w, h, max)}" fill="var(--chart-5)" />
  </svg>`
}

export function bars(items: MixBar[], w = 520, h = 140): string {
  if (!items.length) return `<div class="empty">No seats in the field yet.</div>`
  const max = Math.max(...items.map((i) => i.value), 1)
  const gap = 8
  const bw = Math.min(28, Math.max(8, (w - gap * (items.length + 1)) / items.length))
  const rects = items
    .slice(0, 12)
    .map((it, i) => {
      const bh = Math.max(2, (it.value / max) * (h - 28))
      const x = gap + i * (bw + gap)
      const y = h - 18 - bh
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="var(--chart-4)" />
        <text x="${(x + bw / 2).toFixed(1)}" y="${h - 6}" text-anchor="middle" class="tick">${escapeXml(it.label)}</text>`
    })
    .join('')
  return `<svg class="chart" viewBox="0 0 ${w} ${h}">${rects}</svg>`
}

export function heatmapGrid(values: number[]): string {
  const cells = values.length ? values : Array.from({ length: 17 * 7 }, () => 0)
  const max = Math.max(...cells, 0)
  const cols = 17
  const rows = 7
  const size = 11
  const gap = 3
  const w = cols * (size + gap)
  const h = rows * (size + gap)
  let out = `<svg class="heat" viewBox="0 0 ${w} ${h}">`
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const v = cells[c * rows + r] ?? 0
      const step = max === 0 ? 0 : Math.min(4, Math.ceil((v / max) * 4))
      const fill = max === 0 ? 'var(--chart-1)' : MONO[step]
      out += `<rect x="${c * (size + gap)}" y="${r * (size + gap)}" width="${size}" height="${size}" rx="2" fill="${fill}" />`
    }
  }
  out += '</svg>'
  return out
}

/** Same Mercator math as the realtime map (1152x576 viewport), so the legacy 4-variant
 * Map page's dots/graticule line up with the WORLD_PATHS land it now shares. */
function project(lat: number, lon: number): { x: number; y: number } {
  const [x, y] = projectPoint(lat, lon, '1152')
  return { x, y }
}

function scaleColor(devices: number, max: number): string {
  if (max <= 0 || devices <= 0) return 'var(--land)'
  const step = Math.min(4, Math.max(1, Math.ceil((devices / max) * 4)))
  return MONO[step]
}

export function choropleth(
  countries: MapCountry[],
  dots: MapDot[],
  variant: 'land' | 'analytics' | 'graticule' | 'hatch'
): string {
  const by = new Map(countries.map((c) => [c.iso, c.devices]))
  const max = Math.max(0, ...countries.map((c) => c.devices))
  const empty = countries.length === 0 && dots.length === 0
  let land = ''
  for (const [iso, d] of Object.entries(WORLD_PATHS)) {
    const n = by.get(iso) ?? 0
    const fill =
      empty || variant === 'land'
        ? 'var(--land)'
        : variant === 'hatch' && n > 0
          ? `url(#hatch-${Math.min(4, Math.max(1, Math.ceil((n / Math.max(max, 1)) * 4)))})`
          : scaleColor(n, max)
    land += `<path data-iso="${iso}" d="${stripMapBands(d)}" fill="${fill}" />`
  }
  let grid = ''
  if (variant === 'graticule') {
    for (let lon = -180; lon <= 180; lon += 30) {
      const x = project(0, lon).x
      grid += `<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="576" class="grat" />`
    }
    for (let lat = -60; lat <= 80; lat += 30) {
      const y = project(lat, 0).y
      grid += `<line x1="0" y1="${y.toFixed(1)}" x2="1152" y2="${y.toFixed(1)}" class="grat" />`
    }
  }
  const marks = empty
    ? ''
    : dots
        .map((dot) => {
          const p = project(dot.lat, dot.lon)
          return `<circle class="dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.2" />`
        })
        .join('')
  const caption = empty
    ? `<div class="empty map-empty">No heartbeats yet. The map stays empty until a seat checks in.</div>`
    : ''
  return `${caption}<svg class="world" viewBox="0 0 1152 576" role="img" aria-label="Unique devices by country">
    <defs>
      <pattern id="hatch-1" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--chart-3)" stroke-width="1"/></pattern>
      <pattern id="hatch-2" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="5" stroke="var(--chart-4)" stroke-width="1"/></pattern>
      <pattern id="hatch-3" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" stroke="var(--chart-5)" stroke-width="1.2"/></pattern>
      <pattern id="hatch-4" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="3" stroke="#fff" stroke-width="1.2"/></pattern>
    </defs>
    ${grid}${land}${marks}
  </svg>`
}

const SHOEY_BLUE = '#2563EB'
/** OpenPanel Shoey realtime land. Must stay this literal so curl /assets proof can see it. */
export const SHOEY_LAND = '#E5E7EB'
const SHOEY_OCEAN = '#FFFFFF'
const SHOEY_LAND_STROKE = '#6B7280'

export function blueBars(values: number[], w = 220, h = 36): string {
  if (!values.length || values.every((v) => v === 0)) {
    return `<svg class="spark bars" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><line x1="0" y1="${h - 2}" x2="${w}" y2="${h - 2}" stroke="#EDEDED" /></svg>`
  }
  const max = Math.max(...values, 1)
  const gap = 1.5
  const n = values.length
  const bw = Math.max(1.5, (w - gap * (n + 1)) / n)
  const rects = values
    .map((v, i) => {
      if (v <= 0) return ''
      const bh = Math.max(2.4, (v / max) * (h - 4))
      const x = gap + i * (bw + gap)
      return `<rect x="${x.toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${SHOEY_BLUE}" rx="0.6" />`
    })
    .join('')
  return `<svg class="spark bars" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${rects}</svg>`
}

export function blueArea(
  values: number[],
  labels: string[] = [],
  w = 860,
  h = 220
): string {
  if (!values.length || values.every((v) => v === 0)) {
    return `<div class="empty">No seats in this window.</div>`
  }
  const max = Math.max(...values, 1)
  const step = values.length > 1 ? w / (values.length - 1) : w
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 28 - (v / max) * (h - 40)).toFixed(1)}`)
  const fill = `M0,${h - 24} L${pts.join(' L')} L${w},${h - 24} Z`
  const ticks = labels
    .map((lab, i) => {
      if (!lab) return ''
      const x = i * step
      return `<text x="${x.toFixed(1)}" y="${h - 8}" class="tick" text-anchor="${i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'}">${escapeXml(lab)}</text>`
    })
    .join('')
  const yMax = max >= 1000 ? `${Math.round(max / 1000)}k` : String(Math.round(max))
  return `<svg class="chart area" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <text x="8" y="14" class="tick">${escapeXml(yMax)}</text>
    <text x="8" y="${h - 30}" class="tick">0</text>
    <path d="${fill}" fill="url(#shoey-fill)" />
    <path d="M${pts.join(' L')}" fill="none" stroke="${SHOEY_BLUE}" stroke-width="1.6" />
    ${ticks}
  </svg>`
}

/** Overview corner map. Real choropleth, ported faithfully from CountryMap.tsx via
 * ./world/map.ts (renderCornerMapSvg): oklch fill by seat count, white 0.5 strokes,
 * invisible hit pins at real country centroids. No sample dots. */
export function choroplethMini(countries: MapCountry[], cls = 'stat-choro'): string {
  const svg = renderCornerMapSvg({ countries: countries.map((c) => ({ iso: c.iso, count: c.devices })) })
  return svg.replace('class="corner-map-svg"', `class="corner-map-svg ${cls}"`)
}

/** Ocean + every world-atlas country at the 1152x576 realtime-map viewport. Inlined into
 * #map-root HTML. paintShoeyMap only restyles theme (fill/stroke attributes, not CSS). */
export function shoeyLandSvg(cls = 'world shoey-world'): string {
  let land = ''
  for (const [iso, d] of Object.entries(WORLD_PATHS)) {
    const painted = stripMapBands(d)
    if (!painted) continue
    land += `<path class="world-land" data-iso="${iso}" d="${painted}" fill="${SHOEY_LAND}" stroke="${SHOEY_LAND_STROKE}" stroke-width="1.15" />`
  }
  return `<svg class="${cls}" viewBox="0 0 1152 576" width="1152" height="576" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Unique seats by country" data-land="${SHOEY_LAND}">
    <rect class="world-ocean" width="1152" height="576" fill="${SHOEY_OCEAN}"/>
    ${land}
  </svg>`
}

export const SHOEY_LAND_SVG = shoeyLandSvg()

/** Realtime map: white ocean, faint graticule, filled land, one dot per reporting location —
 * pulsing green while live, static violet once seen-but-idle (Tony: "a pulsing green dot on
 * where people are using it and the city they are from") — plus pills for countries reporting
 * from more than one place, zoom/pan controls and the hover tooltip. Faithful port via
 * ./world/map.ts (renderRealtimeMapSvg) of WorldMap.tsx / shared/MapCanvas.tsx plus bklit's
 * Choropleth Chart behaviours. Colour is entirely CSS tokens (css-realtime.ts): this function
 * never branches on theme. */
export function shoeyWorld(countries: MapCountry[], dots: MapDot[]): string {
  const empty = countries.length === 0 && dots.length === 0
  const points = empty ? [] : groupDotsToPoints(dots)
  return renderRealtimeMapSvg({ points })
}

/** Seats sharing a country, city, and lat/lon (to 2 decimals, ~1km) render as one dot whose
 * count is the number of seats there — never a duplicate dot per seat at the same spot.
 * `MapDot` (operator/src/dashboard.ts) does not yet carry a live/idle flag, asks-in-30-min or
 * time-saved per point — every dot renders live (`live` defaults to true in
 * RealtimeMapPoint) until that data-layer distinction exists; the renderer already supports
 * all of it (see map.test.ts) for the day a route supplies it. */
function groupDotsToPoints(dots: MapDot[]): RealtimeMapPoint[] {
  const groups = new Map<string, RealtimeMapPoint>()
  for (const d of dots) {
    const key = `${d.country}:${d.city ?? ''}:${d.lat.toFixed(2)}:${d.lon.toFixed(2)}`
    const prev = groups.get(key)
    if (prev) prev.count += 1
    else groups.set(key, { country: d.country, city: d.city ?? '', lat: d.lat, lon: d.lon, count: 1 })
  }
  return [...groups.values()]
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}
