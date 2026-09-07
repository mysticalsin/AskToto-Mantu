/**
 * Pure, isomorphic world-map rendering. No DOM access anywhere in this module (that lives
 * in ./map-dom.ts, imported only by the client bundle). Ports the OpenPanel "Shoey" demo
 * (WorldMap.tsx, shared/MapCanvas.tsx, shared/ZoomPan.tsx, demo-shoey-0c94a954/CountryMap.tsx)
 * faithfully: same Mercator constants, same greedy clustering, same choropleth formula.
 *
 * Spec change (Tony, voice note, after the initial port): the realtime map drops the count
 * pill badges entirely. Seats render as solid pulsing dots instead; `clusterPins` stays as a
 * pure, tested helper (useful for tooltip aggregation and for any future badge UI) but its
 * output is no longer drawn on the map.
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
// Clustering (ported from WorldMap.tsx). Kept as a pure, tested helper for tooltip
// aggregation; the realtime map itself no longer draws badge pills from this output.
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

const LAND_FILL: Record<Theme, string> = { light: 'rgb(240,240,240)', dark: '#2a2a2e' }
const LAND_STROKE: Record<Theme, string> = { light: 'rgb(153,153,153)', dark: '#3f3f46' }

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

export interface RealtimeMapOptions {
  points: RealtimeMapPoint[]
  theme?: Theme
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
    @keyframes metis-rt-pulse {
      0% { r: 4.5; opacity: 0.6; }
      100% { r: 14; opacity: 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      .rt-pin-halo { animation: none; r: 9; opacity: 0.25; }
    }
  `

function renderPin(point: RealtimeMapPoint, variant: MapVariant): string {
  const [x, y] = projectPoint(point.lat, point.lon, variant)
  const dotRadius = point.count > 1 ? 6.5 : 4.5
  const label = point.city || countryName(point.country)
  const asksAttr = point.asks == null ? '' : ` data-asks="${point.asks}"`
  return `<g class="rt-pin" data-pin tabindex="0" data-country="${escapeXml(countryName(point.country))}" data-city="${escapeXml(label)}" data-seats="${point.count}"${asksAttr} transform="translate(${x.toFixed(2)} ${y.toFixed(2)})">
      <g class="rt-pin-inner" data-pin-inner>
        <circle class="rt-pin-halo" r="4.5" />
        <circle class="rt-pin-dot" r="${dotRadius}" />
      </g>
    </g>`
}

/** Full realtime map SVG: land, one pulsing dot per point (no badge pills — see the module
 * doc comment), zoom/pan viewport group and +/- control buttons rendered as markup so
 * ./map-dom.ts only has to bind handlers, and a bottom gradient fade like the reference. */
export function renderRealtimeMapSvg(options: RealtimeMapOptions): string {
  const { points, theme = 'light' } = options
  const variant: MapVariant = '1152'
  const { width, height } = MAP_DIMENSIONS[variant]
  const empty = points.length === 0
  const land = landPaths(WORLD_1152, theme)
  const pins = empty ? '' : points.map((p) => renderPin(p, variant)).join('')
  const caption = empty
    ? `<div class="empty map-empty">No heartbeats yet. The map stays empty until a seat checks in. Empty is an empty world, not sample dots.</div>`
    : ''
  const svg = `<svg class="rt-map-svg" data-map-svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Live seat locations">
    <style>${PULSE_STYLE}</style>
    <g class="rt-viewport" data-viewport transform="translate(0,0) scale(1)">
      ${land}
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
 * alpha = 0.12 + 0.88 * sqrt(count / max), white 0.5 strokes, invisible hit pins at
 * centroids for tooltips. Countries with no data render the same flat grey as the land. */
export function renderCornerMapSvg(options: CornerMapOptions): string {
  const variant: MapVariant = '520'
  const { width, height } = MAP_DIMENSIONS[variant]
  const byIso = new Map(options.countries.map((c) => [c.iso, c.count]))
  const max = Math.max(1, ...options.countries.map((c) => c.count))
  const land = WORLD_520.map((c) => {
    const count = byIso.get(c.alpha2)
    const fill =
      count === undefined ? 'rgb(240,240,240)' : `oklch(54.6% 0.22 263 / ${(0.12 + 0.88 * Math.sqrt(count / max)).toFixed(3)})`
    return `<path class="world-land" data-iso="${escapeXml(c.alpha2 || c.id)}" d="${c.d}" fill="${fill}" stroke="rgb(255,255,255)" stroke-width="0.5" />`
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
