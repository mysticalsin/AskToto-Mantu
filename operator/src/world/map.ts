/**
 * Pure, isomorphic world-map rendering. No DOM access anywhere in this module (that lives in
 * ./map-dom.ts, imported only by the client bundle). Every colour is a CSS custom property
 * (`var(--map-land)`, `var(--live)`, ...) defined in operator/src/spa/css.ts -- there is no hex
 * or rgb() literal anywhere below, light/dark repaint themselves with zero JS, and gates.mjs
 * gate 3 (hex literals in operator/src/world/**) passes on this file by construction.
 *
 * Plan 3.7 item 2 / 6.3 (the OpenPanel look plus bklit's choropleth behaviours): white ocean,
 * `--map-land` land through 0.5px `--map-stroke` borders, a 10-degree graticule at 60% opacity,
 * a Mercator projection centred [0, 20] with the scale derived from the width (see
 * ./mercator.ts), dark `--map-dot` dots per city (stacked seats enlarge the dot; a live seat at
 * that point also gets a green pulsing halo), and a white pill per country with a green live dot
 * plus the seat count and place count ("3 Canada, 2 places") at the country's centroid, with a
 * simple collision nudge so nearby pills never overlap. Hover, zoom/pan and the country click
 * filter are wired by ./map-dom.ts against the `data-*` hooks this module renders; no page
 * writes its own keyframes outside operator/client/motion.ts's helpers (`data-beacon`) or the
 * one embedded `<style>` block below, which carries only the CSS transitions the interactive
 * DOM manipulation in map-dom.ts turns on and off (no `@keyframes` -- the beacon pulse is
 * motion.ts's, bound generically by every page's `bindMotion()` call).
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
// Clustering: a pure, tested helper for tooltip aggregation by pixel proximity (kept exactly
// as ported from WorldMap.tsx). Not used for the country pills below, which group strictly by
// country instead — see countryPillInfos().
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

/** Accepted for backward compatibility (operator/src/charts.ts's shoeyWorld() still passes a
 * `theme` option) -- every colour below is a CSS custom property, so light/dark repaint
 * themselves with zero JS and this type no longer changes what gets rendered. */
export type Theme = 'light' | 'dark'

function escapeXml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function landPaths(entries: { id: string; alpha2: string; d: string }[]): string {
  return entries
    .map((c) => `<path class="world-land" data-iso="${escapeXml(c.alpha2 || c.id)}" d="${c.d}" />`)
    .join('')
}

const GRATICULE_STEP_DEG = 10

/** A meridian/parallel every 10 degrees (bklit's ChoroplethGraticule): in a Mercator
 * projection both are straight lines, so no path baking is needed -- ./mercator.ts's
 * projectPoint places each one exactly where the land paths were projected from. Lines that
 * would fall outside the canvas (a parallel beyond the projection's vertical extent) are
 * skipped rather than drawn off-screen. */
export function graticuleLines(variant: MapVariant): string {
  const { width, height } = MAP_DIMENSIONS[variant]
  const lines: string[] = []
  for (let lon = -180; lon <= 180; lon += GRATICULE_STEP_DEG) {
    const [x] = projectPoint(0, lon, variant)
    if (x < -0.01 || x > width + 0.01) continue
    lines.push(`<line class="grat" x1="${x.toFixed(2)}" y1="0" x2="${x.toFixed(2)}" y2="${height}" />`)
  }
  for (let lat = -80; lat <= 80; lat += GRATICULE_STEP_DEG) {
    const [, y] = projectPoint(lat, 0, variant)
    if (y < -0.01 || y > height + 0.01) continue
    lines.push(`<line class="grat" x1="0" y1="${y.toFixed(2)}" x2="${width}" y2="${y.toFixed(2)}" />`)
  }
  return `<g class="rt-graticule" data-graticule aria-hidden="true">${lines.join('')}</g>`
}

export interface RealtimeMapPoint {
  country: string
  city: string
  lat: number
  lon: number
  /** Seats reporting from this exact point. */
  count: number
  /** Of those seats, how many are live right now (heartbeat under 2 min). Omitted or 0 when
   * none are -- the dot's halo only pulses when this point is genuinely live. */
  live?: number
  /** Asks in the last 30 min from this point, when known. Omitted entirely from the markup
   * when not supplied — numbers stay honest, never a fabricated zero. */
  asks?: number
}

/** Per-country totals for the pill's seat/live counts (plan 3.7 item 2), independent of
 * `points` — a country with seats but no lat/lon on any of them still gets an honest pill. */
export interface RealtimeCountryTotal {
  iso: string
  seats: number
  live: number
}

export interface RealtimeMapOptions {
  points: RealtimeMapPoint[]
  countryTotals?: RealtimeCountryTotal[]
  /** Accepted for backward compatibility; see the Theme doc comment above. */
  theme?: Theme
}

function renderPin(point: RealtimeMapPoint, variant: MapVariant): string {
  const [x, y] = projectPoint(point.lat, point.lon, variant)
  const dotRadius = point.count > 1 ? 6.5 : 4.5
  const label = point.city || countryName(point.country)
  const asksAttr = point.asks == null ? '' : ` data-asks="${point.asks}"`
  const liveAttr = point.live ? ` data-live="${point.live}"` : ''
  const halo = point.live ? `<circle class="rt-pin-halo" r="${dotRadius}" data-beacon />` : ''
  const iso = point.country.toUpperCase().trim()
  const isoAttr = iso ? ` data-iso="${escapeXml(iso)}"` : ''
  return `<g class="rt-pin" data-pin tabindex="0"${isoAttr} data-country="${escapeXml(countryName(point.country))}" data-city="${escapeXml(label)}" data-seats="${point.count}"${asksAttr}${liveAttr} transform="translate(${x.toFixed(2)} ${y.toFixed(2)})">
      <g class="rt-pin-inner" data-pin-inner>
        ${halo}
        <circle class="rt-pin-dot" r="${dotRadius}" />
      </g>
    </g>`
}

interface CountryPillInfo {
  iso: string
  countryLabel: string
  seats: number
  live: number
  places: number
}

function countryPillInfos(points: RealtimeMapPoint[], countryTotals?: RealtimeCountryTotal[]): CountryPillInfo[] {
  const byIso = new Map<string, { seats: number; live: number; places: Set<string> }>()
  for (const p of points) {
    const iso = p.country.toUpperCase().trim()
    if (!iso) continue
    const cur = byIso.get(iso) ?? { seats: 0, live: 0, places: new Set<string>() }
    cur.seats += p.count
    cur.live += p.live ?? 0
    cur.places.add(p.city || `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`)
    byIso.set(iso, cur)
  }
  for (const t of countryTotals ?? []) {
    const iso = t.iso.toUpperCase().trim()
    if (!iso) continue
    const cur = byIso.get(iso) ?? { seats: 0, live: 0, places: new Set<string>() }
    // The route-provided total is the authoritative seat/live count (it counts every seat in
    // the country, not only the ones we could place a dot for); dot-derived places stays the
    // honest count of distinct locations we actually know.
    cur.seats = Math.max(cur.seats, t.seats)
    cur.live = Math.max(cur.live, t.live)
    byIso.set(iso, cur)
  }
  return [...byIso.entries()]
    .filter(([, v]) => v.seats > 0)
    .map(([iso, v]) => ({ iso, countryLabel: countryName(iso), seats: v.seats, live: v.live, places: Math.max(1, v.places.size) }))
}

/** "3 Canada, 2 places" when more than one place is known, "3 Canada" for a single place. */
export function pillLabel(info: { countryLabel: string; seats: number; places: number }): string {
  const base = `${info.seats} ${info.countryLabel}`
  return info.places > 1 ? `${base}, ${info.places} places` : base
}

const PILL_HEIGHT = 20
const PILL_PAD_X = 9
const PILL_DOT_SPACE = 14
const PILL_CHAR_WIDTH = 5.6
const PILL_GAP = 4

function estimatePillWidth(label: string): number {
  return PILL_DOT_SPACE + PILL_PAD_X * 2 + label.length * PILL_CHAR_WIDTH
}

interface PillBox {
  info: CountryPillInfo
  label: string
  x: number
  y: number
  width: number
}

/** Anchors every pill at its country's baked centroid, then a simple collision nudge (the
 * spec's own word: not a force-directed layout) -- sweep top to bottom, and push a pill down
 * past any already-placed pill it would otherwise overlap. */
function placePills(infos: CountryPillInfo[], variant: MapVariant): PillBox[] {
  const centroids = variant === '1152' ? CENTROIDS_1152 : CENTROIDS_520
  const initial: PillBox[] = []
  for (const info of infos) {
    const centroid = centroids[info.iso]
    if (!centroid) continue
    const label = pillLabel(info)
    initial.push({ info, label, x: centroid[0], y: centroid[1], width: estimatePillWidth(label) })
  }
  initial.sort((a, b) => a.y - b.y)
  const placed: PillBox[] = []
  for (const box of initial) {
    let y = box.y
    for (const other of placed) {
      const overlapsX = Math.abs(box.x - other.x) < (box.width + other.width) / 2 + PILL_GAP
      const overlapsY = Math.abs(y - other.y) < PILL_HEIGHT + PILL_GAP
      if (overlapsX && overlapsY) y = other.y + PILL_HEIGHT + PILL_GAP
    }
    placed.push({ ...box, y })
  }
  return placed
}

function renderPill(box: PillBox): string {
  const { info, label } = box
  const liveClass = info.live > 0 ? ' rt-pill-live' : ''
  const dotBeacon = info.live > 0 ? ' data-beacon' : ''
  const left = box.x - box.width / 2
  const top = box.y - PILL_HEIGHT / 2
  return `<g class="rt-pill${liveClass}" data-country-pill tabindex="0" data-iso="${escapeXml(info.iso)}" data-country="${escapeXml(info.countryLabel)}" data-country-seats="${info.seats}" data-country-live="${info.live}" data-country-places="${info.places}" transform="translate(${left.toFixed(2)} ${top.toFixed(2)})">
    <rect class="rt-pill-bg" width="${box.width.toFixed(2)}" height="${PILL_HEIGHT}" rx="${PILL_HEIGHT / 2}" />
    <circle class="rt-pill-dot" cx="${(PILL_PAD_X + 2).toFixed(2)}" cy="${PILL_HEIGHT / 2}" r="3"${dotBeacon} />
    <text class="rt-pill-text" x="${(PILL_DOT_SPACE + PILL_PAD_X).toFixed(2)}" y="${PILL_HEIGHT / 2}" dominant-baseline="central">${escapeXml(label)}</text>
  </g>`
}

/** The one embedded `<style>` block for this component's own interactive states (hover fade,
 * the pill/dot palette, the zoom viewport's transition). Every value is a token or a plain
 * transition/geometry number -- no `@keyframes` (the live beacon pulse is motion.ts's
 * `data-beacon`, bound generically by every page's bindMotion() call, per plan 3.5b's
 * implementation rule), so nothing here needs its own `prefers-reduced-motion` guard beyond
 * disabling the transitions themselves. */
const MAP_STYLE = `
    .world-land { fill: var(--map-land); stroke: var(--map-stroke); stroke-width: 0.5; vector-effect: non-scaling-stroke; cursor: pointer; transition: opacity 150ms var(--ease-color), fill 150ms var(--ease-color); }
    .world-land.is-faded { opacity: 0.4; }
    .world-land.is-hovered { fill: var(--map-land-hover); }
    .rt-pin { cursor: pointer; transition: opacity 150ms var(--ease-color); }
    .rt-pin.is-faded { opacity: 0.4; }
    .rt-pin-halo { fill: none; stroke: var(--live); stroke-width: 1.5; opacity: 0.6; transform-origin: center; }
    .rt-pin-dot { fill: var(--map-dot); stroke: var(--map-ocean); stroke-width: 1.2; }
    .rt-pill { cursor: pointer; transition: opacity 150ms var(--ease-color); }
    .rt-pill.is-faded { opacity: 0.4; }
    .rt-pill-bg { fill: var(--map-pill); stroke: var(--border); stroke-width: 1; }
    .rt-pill-dot { fill: var(--ink-3); }
    .rt-pill-live .rt-pill-dot { fill: var(--live); }
    .rt-pill-text { font: 600 10px var(--font-body); fill: var(--ink); }
    .rt-graticule { opacity: 0; transition: opacity 400ms var(--ease-color); }
    .rt-graticule.is-shown { opacity: 1; }
    .rt-viewport { transition: transform 250ms var(--ease-spring); }
    .rt-viewport.is-dragging { transition: none; }
    .rt-viewport.is-resetting { transition-duration: 400ms; }
    @media (prefers-reduced-motion: reduce) {
      .rt-viewport, .world-land, .rt-pill, .rt-pin, .rt-graticule { transition: none; }
    }
  `

/** Full realtime map SVG: white ocean, land, the 10-degree graticule, one dot per point (dark,
 * stacked seats enlarge it, a live point also gets a green pulsing halo), a white pill per
 * country with a green live dot and its seat/place count, a zoom/pan viewport group and +/-
 * control buttons rendered as markup so ./map-dom.ts only has to bind handlers, and a bottom
 * gradient fade like the reference. */
export function renderRealtimeMapSvg(options: RealtimeMapOptions): string {
  const { points, countryTotals } = options
  const variant: MapVariant = '1152'
  const { width, height } = MAP_DIMENSIONS[variant]
  const empty = points.length === 0 && (countryTotals ?? []).every((c) => c.seats === 0)
  const land = landPaths(WORLD_1152)
  const graticule = graticuleLines(variant)
  const pins = empty ? '' : points.map((p) => renderPin(p, variant)).join('')
  const pills = empty ? '' : placePills(countryPillInfos(points, countryTotals), variant).map(renderPill).join('')
  const caption = empty
    ? `<div class="empty map-empty">No seat has checked in during the last 30 minutes.</div>`
    : ''
  const svg = `<svg class="rt-map-svg" data-map-svg tabindex="0" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Live seat locations, zoomable and pannable, plus and minus keys to zoom">
    <style>${MAP_STYLE}</style>
    <rect class="rt-map-ocean" width="${width}" height="${height}" fill="var(--map-ocean)" />
    <g class="rt-viewport" data-viewport transform="translate(0,0) scale(1)">
      ${land}
      ${graticule}
      ${pins}
      ${pills}
    </g>
  </svg>`
  const controls = `<div class="rt-map-controls" data-map-controls>
    <button type="button" class="rt-map-zoom" data-zoom-in aria-label="Zoom in">+</button>
    <button type="button" class="rt-map-zoom" data-zoom-out aria-label="Zoom out">&minus;</button>
  </div>`
  const fade = `<div class="rt-map-fade" aria-hidden="true"></div>`
  return `${caption}<div class="rt-map" data-map-root>${svg}${controls}${fade}</div>`
}

// ---------------------------------------------------------------------------------------
// Corner choropleth (CountryMap.tsx port). Unchanged by the realtime-map spec update: the
// Overview corner map is a separate component (plan 3.7 item 2's last sentence), still every
// colour a token.
// ---------------------------------------------------------------------------------------

export interface CornerCountry {
  iso: string
  count: number
}

export interface CornerMapOptions {
  countries: CornerCountry[]
}

/** 520x300 corner choropleth: fill by a sequential violet scale (`--chart-scale-01..05`,
 * plan 3.2), white 0.5 strokes, invisible hit pins at centroids for tooltips. Countries with no
 * data render the same flat grey as the land (`--data-track`), never a fabricated color. */
export function renderCornerMapSvg(options: CornerMapOptions): string {
  const variant: MapVariant = '520'
  const { width, height } = MAP_DIMENSIONS[variant]
  const byIso = new Map(options.countries.map((c) => [c.iso, c.count]))
  const max = Math.max(1, ...options.countries.map((c) => c.count))
  const scaleSteps = ['var(--chart-scale-01)', 'var(--chart-scale-02)', 'var(--chart-scale-03)', 'var(--chart-scale-04)', 'var(--chart-scale-05)']
  const land = WORLD_520.map((c) => {
    const count = byIso.get(c.alpha2)
    const fill =
      count === undefined
        ? 'var(--data-track)'
        : scaleSteps[Math.min(scaleSteps.length - 1, Math.round((scaleSteps.length - 1) * Math.sqrt(count / max)))]
    return `<path class="world-land" data-iso="${escapeXml(c.alpha2 || c.id)}" d="${c.d}" fill="${fill}" stroke="var(--map-ocean)" stroke-width="0.5" />`
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
