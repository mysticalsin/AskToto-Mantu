/**
 * Pure, isomorphic world-map rendering. No DOM access anywhere in this module (that lives
 * in ./map-dom.ts, imported only by the client bundle). Ports the OpenPanel "Shoey" demo
 * (WorldMap.tsx, shared/MapCanvas.tsx, shared/ZoomPan.tsx, demo-shoey-0c94a954/CountryMap.tsx)
 * faithfully: same Mercator constants, same greedy clustering, same choropleth formula.
 *
 * Realtime uplift (Tony 2026-09-13): dark ocean + subtle grid, country flag pills
 * (`{Country} · {N} devices · {places} places` = fleet geo, not Live), city labels beside pulsing dots.
 * `clusterPins` still drives badge placement distance; country rollups supply pill text.
 */
import { CENTROIDS_1152, CENTROIDS_520, WORLD_1152, WORLD_520 } from './paths.generated'
import { MAP_DIMENSIONS, MERCATOR_VARIANTS, projectPoint, type MapVariant } from './mercator'

export type { MapVariant }
export { MAP_DIMENSIONS, MERCATOR_VARIANTS, projectPoint }

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' })
  } catch {
    return null
  }
})()

/** Country name for an alpha-2 code, via Intl.DisplayNames, falling back to the code itself
 * (never throws — Workers/older runtimes may lack a region for an unusual code). */
export function countryName(code: string): string {
  if (!code) return code
  try {
    return regionNames?.of(code.toUpperCase()) ?? code
  } catch {
    return code
  }
}

// ---------------------------------------------------------------------------------------
// Clustering (ported from WorldMap.tsx). Used for tooltip aggregation and to space
// country pills when several countries are on the map.
// ---------------------------------------------------------------------------------------

export interface ClusterPoint {
  country: string
  city: string
  count: number
  x: number
  y: number
}

export interface Cluster {
  x: number
  y: number
  count: number
  members: ClusterPoint[]
}

export interface ClusterOptions {
  radiusPx: number
  maxBadges: number
  minBadgeDistancePx: number
}

export const DEFAULT_CLUSTER_OPTIONS: ClusterOptions = {
  radiusPx: 22,
  maxBadges: 42,
  minBadgeDistancePx: 90
}

export interface ClusterResult {
  clusters: Cluster[]
  badgeClusters: Cluster[]
}

/** Greedy clustering in projected pixel space, identical to WorldMap.tsx: a point joins the
 * first cluster whose anchor (first member) is within `radiusPx`, else starts a new cluster.
 * Then badges are chosen by count descending, greedily accepting one only if it is at least
 * `minBadgeDistancePx` from every badge already accepted, capped at `maxBadges`. */
export function clusterPins(points: ClusterPoint[], options: ClusterOptions = DEFAULT_CLUSTER_OPTIONS): ClusterResult {
  const clusters: Cluster[] = []
  for (const point of points) {
    const target = clusters.find((cluster) => {
      const dx = point.x - cluster.x
      const dy = point.y - cluster.y
      return Math.sqrt(dx * dx + dy * dy) <= options.radiusPx
    })
    if (target) {
      target.members.push(point)
      target.count += point.count
    } else {
      clusters.push({ x: point.x, y: point.y, count: point.count, members: [point] })
    }
  }

  const sortedByCount = [...clusters].sort((a, b) => b.count - a.count)
  const badgeClusters: Cluster[] = []
  const acceptedPositions: { x: number; y: number }[] = []
  for (const cluster of sortedByCount) {
    if (badgeClusters.length >= options.maxBadges) break
    const farEnough = acceptedPositions.every((p) => {
      const dx = cluster.x - p.x
      const dy = cluster.y - p.y
      return Math.sqrt(dx * dx + dy * dy) >= options.minBadgeDistancePx
    })
    if (farEnough) {
      badgeClusters.push(cluster)
      acceptedPositions.push({ x: cluster.x, y: cluster.y })
    }
  }

  return { clusters, badgeClusters }
}

/** "Longueuil" for a single member, "Canada, 3 places" for one country with several members,
 * "5 places" once more than one country is represented. */
export function clusterLabel(cluster: Cluster): string {
  const { members } = cluster
  if (members.length === 1) {
    const [member] = members
    return member.city ? member.city : countryName(member.country)
  }
  const countryCodes = new Set(members.map((m) => m.country))
  if (countryCodes.size === 1) {
    const [code] = countryCodes
    return `${countryName(code)}, ${members.length} places`
  }
  return `${members.length} places`
}

// ---------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------

export type Theme = 'light' | 'dark'

const LAND_FILL: Record<Theme, string> = { light: 'rgb(240,240,240)', dark: '#1f1830' }
const LAND_STROKE: Record<Theme, string> = { light: 'rgb(153,153,153)', dark: '#3a2f52' }
const OCEAN_FILL: Record<Theme, string> = { light: '#ffffff', dark: '#120e1c' }
const GRID_STROKE: Record<Theme, string> = { light: 'rgba(23, 8, 38, 0.08)', dark: 'rgba(37, 29, 54, 0.85)' }
const LABEL_FILL: Record<Theme, string> = { light: '#170826', dark: '#f3eefb' }
const PILL_BG: Record<Theme, string> = { light: 'rgba(255,255,255,0.92)', dark: 'rgba(26, 21, 38, 0.92)' }
const PILL_BORDER: Record<Theme, string> = { light: 'rgba(23, 8, 38, 0.12)', dark: 'rgba(255,255,255,0.14)' }
const PILL_FG: Record<Theme, string> = { light: '#170826', dark: '#fafafa' }

function escapeXml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function landPaths(entries: { id: string; alpha2: string; d: string }[], theme: Theme): string {
  const fill = LAND_FILL[theme]
  const stroke = LAND_STROKE[theme]
  return entries
    .map(
      (c) =>
        `<path class="world-land" data-iso="${escapeXml(c.alpha2 || c.id)}" d="${c.d}" fill="${fill}" stroke="${stroke}" stroke-width="0.5" />`
    )
    .join('')
}

/** Subtle lon/lat grid behind land — Mission Control density without clutter. */
function oceanGrid(theme: Theme, width: number, height: number): string {
  const stroke = GRID_STROKE[theme]
  const lines: string[] = []
  for (let lon = -180; lon <= 180; lon += 30) {
    const [x] = projectPoint(0, lon, '1152')
    lines.push(
      `<line class="rt-map-grid" x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${height}" stroke="${stroke}" stroke-width="0.6" />`
    )
  }
  for (let lat = -60; lat <= 80; lat += 30) {
    const [, y] = projectPoint(lat, 0, '1152')
    lines.push(
      `<line class="rt-map-grid" x1="0" y1="${y.toFixed(1)}" x2="${width}" y2="${y.toFixed(1)}" stroke="${stroke}" stroke-width="0.6" />`
    )
  }
  return `<rect class="world-ocean" width="${width}" height="${height}" fill="${OCEAN_FILL[theme]}" />
    <g class="rt-map-grid-layer" aria-hidden="true">${lines.join('')}</g>`
}

export interface RealtimeMapPoint {
  country: string
  city: string
  lat: number
  lon: number
  /** Seats reporting from this exact point. */
  count: number
  /** Asks in the last 30 min from this point, when known. Omitted entirely from the
   * tooltip when not supplied — numbers stay honest, never a fabricated zero. */
  asks?: number
}

/** Optional country rollup (from dashboard map.countries) so pill seat totals stay honest
 * when fleet device counts are known separately from dots. */
export interface RealtimeCountryRollup {
  iso: string
  devices: number
}

export interface RealtimeMapOptions {
  points: RealtimeMapPoint[]
  theme?: Theme
  countries?: RealtimeCountryRollup[]
}

const PULSE_STYLE = `
    .rt-pin { cursor: pointer; }
    .rt-pin-halo {
      fill: none;
      stroke: #10b981;
      stroke-width: 1.5;
      opacity: 0.6;
      transform-origin: center;
      animation: metis-rt-pulse 1.8s ease-out infinite;
    }
    .rt-pin-dot { fill: #10b981; stroke: #ffffff; stroke-width: 1.5; }
    .rt-pin-label {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.01em;
      pointer-events: none;
      user-select: none;
    }
    .rt-country-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px 4px 8px;
      border-radius: 999px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11px;
      font-weight: 500;
      line-height: 1.2;
      white-space: nowrap;
      box-shadow: 0 6px 18px rgba(0,0,0,0.28);
      pointer-events: none;
      user-select: none;
    }
    .rt-country-pill img {
      width: 16px;
      height: 12px;
      border-radius: 2px;
      display: block;
      flex: 0 0 auto;
    }
    .rt-country-pill .rt-pill-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #3f3f46;
      flex: 0 0 auto;
    }
    @keyframes metis-rt-pulse {
      0% { r: 4.5; opacity: 0.6; }
      100% { r: 14; opacity: 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      .rt-pin-halo { animation: none; r: 9; opacity: 0.25; }
    }
  `

const MAX_LABEL_CHARS = 22

function truncateLabel(raw: string): string {
  const s = String(raw || '').trim()
  if (s.length <= MAX_LABEL_CHARS) return s
  return `${s.slice(0, MAX_LABEL_CHARS - 1)}...`
}

/** City label lines for a pin. Multi-line when the city string uses " / " or newlines. */
function cityLabelLines(city: string, country: string): string[] {
  const raw = (city || '').trim()
  if (!raw) return [countryName(country)]
  const parts = raw.split(/\s*\/\s*|\n+/).map((p) => p.trim()).filter(Boolean)
  return parts.length ? parts : [raw]
}

function renderPin(point: RealtimeMapPoint, variant: MapVariant, theme: Theme): string {
  const [x, y] = projectPoint(point.lat, point.lon, variant)
  const dotRadius = point.count > 1 ? 6.5 : 4.5
  const label = point.city || countryName(point.country)
  const asksAttr = point.asks == null ? '' : ` data-asks="${point.asks}"`
  const lines = cityLabelLines(point.city, point.country)
  const fullTitle = lines.join(' / ')
  const labelFill = LABEL_FILL[theme]
  const tspans = lines
    .map((line, i) => {
      const dy = i === 0 ? '0.35em' : '1.15em'
      return `<tspan x="10" dy="${dy}">${escapeXml(truncateLabel(line))}</tspan>`
    })
    .join('')
  return `<g class="rt-pin" data-pin tabindex="0" data-country="${escapeXml(countryName(point.country))}" data-city="${escapeXml(label)}" data-seats="${point.count}"${asksAttr} transform="translate(${x.toFixed(2)} ${y.toFixed(2)})">
      <g class="rt-pin-inner" data-pin-inner>
        <circle class="rt-pin-halo" r="4.5" />
        <circle class="rt-pin-dot" r="${dotRadius}" />
        <text class="rt-pin-label" fill="${labelFill}" title="${escapeXml(fullTitle)}">${tspans}</text>
      </g>
    </g>`
}

export interface CountryPill {
  iso: string
  name: string
  seats: number
  places: number
  x: number
  y: number
}

/** Roll points up by country for flag pills. Seat totals prefer `countries` rollup when
 * present so the pill matches fleet device counts. */
export function countryPillsFromPoints(
  points: RealtimeMapPoint[],
  countries: RealtimeCountryRollup[] = [],
  variant: MapVariant = '1152'
): CountryPill[] {
  if (!points.length) return []
  const byIso = new Map<
    string,
    { seats: number; places: Set<string>; xs: number[]; ys: number[] }
  >()
  for (const p of points) {
    const iso = (p.country || '').toUpperCase()
    if (!iso) continue
    const [x, y] = projectPoint(p.lat, p.lon, variant)
    const placeKey = `${(p.city || '').trim().toLowerCase()}|${p.lat.toFixed(2)}|${p.lon.toFixed(2)}`
    const prev = byIso.get(iso)
    if (prev) {
      prev.seats += p.count
      prev.places.add(placeKey)
      prev.xs.push(x)
      prev.ys.push(y)
    } else {
      byIso.set(iso, { seats: p.count, places: new Set([placeKey]), xs: [x], ys: [y] })
    }
  }
  const deviceByIso = new Map(countries.map((c) => [c.iso.toUpperCase(), c.devices]))
  const pills: CountryPill[] = []
  for (const [iso, agg] of byIso) {
    const seats = deviceByIso.get(iso) ?? agg.seats
    const avgX = agg.xs.reduce((a, b) => a + b, 0) / agg.xs.length
    const avgY = agg.ys.reduce((a, b) => a + b, 0) / agg.ys.length
    const centroid = CENTROIDS_1152[iso]
    // Prefer country centroid when available so the pill sits on land (Tony Canada pill),
    // not on top of city labels. Fall back to mean of reporting points.
    const x = centroid ? centroid[0] : avgX
    const y = centroid ? centroid[1] : avgY
    pills.push({
      iso,
      name: countryName(iso),
      seats,
      places: agg.places.size,
      x,
      y
    })
  }
  // Space pills with the same greedy distance rule as badgeClusters.
  const asClusters: ClusterPoint[] = pills.map((p) => ({
    country: p.iso,
    city: p.name,
    count: p.seats,
    x: p.x,
    y: p.y
  }))
  const { badgeClusters } = clusterPins(asClusters, {
    ...DEFAULT_CLUSTER_OPTIONS,
    radiusPx: 0,
    minBadgeDistancePx: 110,
    maxBadges: 24
  })
  const keep = new Set(badgeClusters.map((c) => c.members[0]?.country))
  // Design: country cluster pill stays for multi-place countries (Tony flag pill).
  return pills
    .filter((p) => keep.has(p.iso) && p.places >= 2)
    .sort((a, b) => b.seats - a.seats)
}

function renderCountryPill(pill: CountryPill, theme: Theme): string {
  const iso = pill.iso.toLowerCase()
  // Fleet device count (dashboard country rollup), not Live seats.
  const label = `${pill.name} · ${pill.seats} devices · ${pill.places} places`
  const bg = PILL_BG[theme]
  const border = PILL_BORDER[theme]
  const fg = PILL_FG[theme]
  // foreignObject sized generously; CSS pill shrink-wraps content.
  const foW = Math.min(320, Math.max(160, 28 + label.length * 7.2))
  const foH = 28
  return `<g class="rt-country-pill-g pill-g" data-country-pill="${escapeXml(pill.iso)}" data-seats="${pill.seats}" data-places="${pill.places}" transform="translate(${pill.x.toFixed(2)} ${pill.y.toFixed(2)})">
      <g class="rt-pill-inner" data-pin-inner>
        <foreignObject x="${(-foW / 2).toFixed(1)}" y="${(-foH / 2).toFixed(1)}" width="${foW.toFixed(1)}" height="${foH}" requiredExtensions="http://www.w3.org/1999/xhtml">
          <div xmlns="http://www.w3.org/1999/xhtml" class="rt-country-pill" style="background:${bg};border:1px solid ${border};color:${fg}">
            <span class="rt-pill-dot" aria-hidden="true"></span>
            <img src="/assets/flags/${escapeXml(iso)}.svg" width="16" height="12" alt="" />
            <span>${escapeXml(label)}</span>
          </div>
        </foreignObject>
      </g>
    </g>`
}

/** Full realtime map SVG: dark ocean + grid, land, country flag pills, pulsing dots with
 * city labels, zoom/pan viewport and +/- controls. */
export function renderRealtimeMapSvg(options: RealtimeMapOptions): string {
  const { points, countries = [], theme = 'dark' } = options
  const variant: MapVariant = '1152'
  const { width, height } = MAP_DIMENSIONS[variant]
  const empty = points.length === 0
  const ocean = oceanGrid(theme, width, height)
  const land = landPaths(WORLD_1152, theme)
  const pills = empty ? [] : countryPillsFromPoints(points, countries, variant)
  const pillMarkup = pills.map((p) => renderCountryPill(p, theme)).join('')
  const pins = empty ? '' : points.map((p) => renderPin(p, variant, theme)).join('')
  const caption = empty
    ? `<div class="empty map-empty">No heartbeats yet. The map stays empty until a seat checks in. Empty is an empty world, not sample dots.</div>`
    : ''
  const svg = `<svg class="rt-map-svg" data-map-svg data-map-theme="${theme}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Live seat locations">
    <style>${PULSE_STYLE}</style>
    <g class="rt-viewport" data-viewport transform="translate(0,0) scale(1)">
      ${ocean}
      ${land}
      ${pillMarkup}
      ${pins}
    </g>
  </svg>`
  const controls = `<div class="rt-map-controls" data-map-controls>
    <button type="button" class="rt-map-zoom" data-zoom-in aria-label="Zoom in">+</button>
    <button type="button" class="rt-map-zoom" data-zoom-out aria-label="Zoom out">&minus;</button>
  </div>`
  const fade = `<div class="rt-map-fade" aria-hidden="true"></div>`
  return `${caption}<div class="rt-map" data-map-root style="position:relative">${svg}${controls}${fade}</div>`
}

// ---------------------------------------------------------------------------------------
// Corner choropleth (CountryMap.tsx port). Unchanged by the realtime-map spec update.
// ---------------------------------------------------------------------------------------

export interface CornerCountry {
  iso: string
  count: number
}

export interface CornerMapOptions {
  countries: CornerCountry[]
}

/** 520x300 corner choropleth: `oklch(54.6% 0.22 263 / alpha)` fill with
 * alpha = 0.12 + 0.88 * sqrt(count / max), theme-aware land/strokes, and invisible hit pins at
 * centroids for tooltips. Countries with no data use the current theme's neutral land color. */
export function renderCornerMapSvg(options: CornerMapOptions): string {
  const variant: MapVariant = '520'
  const { width, height } = MAP_DIMENSIONS[variant]
  const byIso = new Map(options.countries.map((c) => [c.iso, c.count]))
  const max = Math.max(1, ...options.countries.map((c) => c.count))
  const land = WORLD_520.map((c) => {
    const count = byIso.get(c.alpha2)
    const fill =
      count === undefined ? 'var(--map-land)' : `oklch(54.6% 0.22 263 / ${(0.12 + 0.88 * Math.sqrt(count / max)).toFixed(3)})`
    return `<path class="world-land" data-iso="${escapeXml(c.alpha2 || c.id)}" d="${c.d}" fill="${fill}" stroke="var(--map-stroke)" stroke-width="0.5" />`
  }).join('')
  const pins = options.countries
    .filter((c) => byIso.has(c.iso) && CENTROIDS_520[c.iso])
    .map((c) => {
      const [x, y] = CENTROIDS_520[c.iso]
      const count = byIso.get(c.iso) ?? 0
      return `<g class="corner-pin" data-pin tabindex="0" data-country="${escapeXml(countryName(c.iso))}" data-count="${count}" transform="translate(${x} ${y})"><circle r="6" fill="transparent" /></g>`
    })
    .join('')
  return `<svg class="corner-map-svg" data-map-svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Countries by activity">${land}${pins}</svg>`
}

export { CENTROIDS_1152, CENTROIDS_520, WORLD_1152, WORLD_520 }
